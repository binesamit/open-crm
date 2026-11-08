// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Windowed loading, before / after (docs/PERFORMANCE-REVIEW.md §7.1): in-process requests against the perf-seed
 * database, wall time (median of `--runs`) and response size (raw and gzip). Local databases only.
 *   PERF_DATABASE_URL=postgres://bines:bines@localhost:5434/bines_perf \
 *     pnpm --filter @bines/api exec tsx scripts/windowed-bench.ts [--runs 5] [--slug perf100k]
 * "Before" = what the board page loaded until now (the whole board); "after" = what a windowed board page loads
 * (size probe, outline with the footer summaries, the first window of rows) and what a filter / sort / grouping
 * change costs (one outline). `--client`: instead, the browser-side work on boards that still load whole.
 */
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { memoryMailer } from '@bines/server-mail';
import {
  applyPlan,
  encodeQuery,
  groupRows,
  planQuery,
  querySchema,
  type QueryEnv,
  type QueryRow,
  resolveField,
  summarize,
  summaryOptions,
} from '@bines/shared';
import { createApp } from '../src/app';
import { createDb } from '../src/db/client';
import { createDeps } from '../src/deps';
import { loadEnv } from '../src/env';
import { createLogger } from '../src/lib/logger';
import { nullBus } from '../src/lib/realtime';
import { memoryStorage } from '../src/lib/storage';

const opt = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const runs = Number(opt('runs') ?? 5);
const slug = opt('slug') ?? 'perf100k';
const url = process.env.PERF_DATABASE_URL;
if (!url) throw new Error('PERF_DATABASE_URL is required');
if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('local databases only');

const env = loadEnv({
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  WEB_ORIGIN: 'http://localhost:5173',
  BETTER_AUTH_SECRET: 'bench-secret-bench-secret-bench-secret-123',
  DATABASE_URL: url,
});
const config = JSON.parse(readFileSync(new URL(`../../../perf/.perf-${slug}.json`, import.meta.url), 'utf8')) as {
  account_id: string;
  password: string;
  users: string[];
  boards: { id: string; name: string; items: number }[];
};
const { db, close } = createDb(url);
const app = createApp(
  createDeps({ env, logger: createLogger(env), db, mailer: memoryMailer(), storage: memoryStorage(), bus: nullBus }),
);
const origin = env.WEB_ORIGIN;
const signIn = await app.request('/api/auth/sign-in/email', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ email: config.users[1], password: config.password }),
});
const cookie = signIn.headers
  .getSetCookie()
  .map((c) => c.split(';')[0]!)
  .find((c) => c.startsWith('bos.session_token='));
if (!cookie) throw new Error(`sign-in failed: ${signIn.status}`);

const call = async (method: string, path: string, body?: unknown) => {
  const t = performance.now();
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: {
      origin,
      cookie,
      'x-account-id': config.account_id,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const ms = performance.now() - t;
  if (res.status !== 200) throw new Error(`${method} ${path} → ${res.status} ${buf.toString().slice(0, 300)}`);
  return { ms, raw: buf.byteLength, json: JSON.parse(buf.toString()) as Record<string, unknown> };
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const kb = (n: number) => `${Math.round(n / 1024)}KB`;
const bench = async (label: string, method: string, path: string, body?: unknown) => {
  await call(method, path, body); // warm-up
  const times: number[] = [];
  let last!: Awaited<ReturnType<typeof call>>;
  for (let i = 0; i < runs; i++) {
    last = await call(method, path, body);
    times.push(last.ms);
  }
  const gz = gzipSync(JSON.stringify(last.json)).byteLength;
  console.warn(
    `${label.padEnd(58)} ${String(Math.round(median(times))).padStart(6)}ms  ${kb(last.raw).padStart(7)}  gz ${kb(gz)}`,
  );
  return last.json;
};

/**
 * `--client`: what the browser computes per render on boards that still load whole (≤ the threshold) — the
 * board page's filter/sort (`applyPlan`), sections, grouping and every footer, on the real rows (Node's V8; a
 * desktop browser is about the same, a phone 3–5× slower).
 */
const clientBench = async () => {
  for (const b of config.boards.filter((x) => x.items <= 6000)) {
    const board = (await call('GET', `/boards/${b.id}`)).json as {
      columns: { id: string; type: string; settings: Record<string, unknown> }[];
      groups: { id: string }[];
    };
    const rows = (await call('GET', `/boards/${b.id}/items`)).json.data as QueryRow[];
    const env: QueryEnv = {
      columns: board.columns.map((c) => ({ id: c.id, type: c.type, settings: c.settings })),
      meId: null,
      teams: [],
      today: '2026-10-05',
      timezone: 'Asia/Jerusalem',
      weekend: 'fri_sat',
      firstDay: 0,
    };
    const fields = board.columns.flatMap((c) => {
      try {
        return [resolveField(c.id, env)];
      } catch {
        return [];
      }
    });
    const status = board.columns.find((c) => c.type === 'status')!.id;
    const amount = board.columns.find((c) => c.type === 'numbers')!.id;
    const rank = new Map(board.groups.map((g, i) => [g.id, i]));
    const footers = (list: QueryRow[]) => fields.forEach((f) => summarize(f, list, env.timezone));
    const time = (fn: () => void) => {
      const ts: number[] = [];
      for (let i = 0; i < 7; i++) {
        const t = performance.now();
        fn();
        ts.push(performance.now() - t);
      }
      return Math.round(median(ts));
    };
    const byGroups = (query: object) => () => {
      const matched = applyPlan(rows, planQuery(querySchema.parse(query), env), env.timezone, rank);
      for (const g of board.groups) footers(matched.filter((r) => r.group_id === g.id));
    };
    const filter = {
      kind: 'group',
      operator: 'and',
      negate: false,
      rules: [{ column_id: status, operator: 'any_of', values: [1] }],
    };
    const plain = time(byGroups({}));
    const filtered = time(byGroups({ filter, sort: [{ column_id: amount, direction: 'desc' }] }));
    const grouped = time(() => {
      const matched = applyPlan(rows, planQuery(querySchema.parse({}), env), env.timezone);
      for (const bucket of groupRows(matched, resolveField(status, env), { timezone: env.timezone, emptyLabel: '' }))
        footers(bucket.rows);
    });
    console.warn(
      `${b.name.padEnd(14)} ${String(b.items).padStart(6)} items: board ${plain}ms · filter+sort ${filtered}ms · group by status ${grouped}ms (${fields.length} footers)`,
    );
  }
};

try {
  if (process.argv.includes('--client')) await clientBench();
  for (const b of config.boards.filter((x) => x.items >= 6000 && !process.argv.includes('--client'))) {
    console.warn(`\n== ${b.name} (${b.items} items) ==`);
    const board = (await call('GET', `/boards/${b.id}`)).json as {
      columns: { id: string; type: string; settings: Record<string, unknown> }[];
    };
    const qenv: QueryEnv = {
      columns: board.columns.map((c) => ({ id: c.id, type: c.type, settings: c.settings })),
      meId: null,
      teams: [],
      today: '2026-10-05',
      timezone: 'Asia/Jerusalem',
      weekend: 'fri_sat',
      firstDay: 0,
    };
    // The footers a table shows: every column whose default summary is not "none".
    const footers = board.columns.flatMap((c) => {
      try {
        const o = summaryOptions(resolveField(c.id, qenv));
        return o.length && o[0] !== 'none' ? [{ column_id: c.id }] : [];
      } catch {
        return [];
      }
    });
    const stored = footers.filter(
      (f) => !['formula', 'mirror'].includes(board.columns.find((c) => c.id === f.column_id)!.type),
    );
    const status = board.columns.find((c) => c.type === 'status')!.id;
    const amount = board.columns.find((c) => c.type === 'numbers')!.id;

    console.warn('-- before (whole board) --');
    await bench('GET items (whole board)', 'GET', `/boards/${b.id}/items`);
    console.warn('-- after (windowed) --');
    await bench('GET items?window=1 (size probe)', 'GET', `/boards/${b.id}/items?window=1`);
    const outline = (await bench(
      `POST outline (${stored.length} stored footers)`,
      'POST',
      `/boards/${b.id}/items/outline`,
      {
        summaries: stored,
      },
    )) as { sections: { ids: string[] }[] };
    await bench(
      `POST outline (all ${footers.length} footers, formula/mirror too)`,
      'POST',
      `/boards/${b.id}/items/outline`,
      {
        summaries: footers,
      },
    );
    await bench('POST outline (no footers)', 'POST', `/boards/${b.id}/items/outline`, {});
    const first = outline.sections[0]!.ids.slice(0, 60);
    await bench('GET items?ids= (first screen, 60 rows)', 'GET', `/boards/${b.id}/items?ids=${first.join(',')}`);
    const window = outline.sections[0]!.ids.slice(0, 200);
    await bench('GET items?ids= (one window, 200 rows)', 'GET', `/boards/${b.id}/items?ids=${window.join(',')}`);
    console.warn('-- after: a toolbar change = one outline --');
    const filter = {
      kind: 'group',
      operator: 'and',
      negate: false,
      rules: [{ column_id: status, operator: 'any_of', values: [1] }],
    };
    await bench('outline: filter status + sort amount desc', 'POST', `/boards/${b.id}/items/outline`, {
      query: { filter, sort: [{ column_id: amount, direction: 'desc' }] },
      summaries: stored,
    });
    await bench('outline: search "acme"', 'POST', `/boards/${b.id}/items/outline`, {
      query: { search: 'acme' },
      summaries: stored,
    });
    await bench('outline: group by status', 'POST', `/boards/${b.id}/items/outline`, {
      query: { group_by: { column_id: status } },
      summaries: stored,
    });
    await bench(
      '(before: the same filter, whole result) GET items?q=',
      'GET',
      `/boards/${b.id}/items?q=${encodeQuery({ filter, sort: [{ column_id: amount, direction: 'desc' }] } as never)}`,
    );
  }
} finally {
  await close();
}
