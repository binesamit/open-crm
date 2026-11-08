// SPDX-License-Identifier: AGPL-3.0-only
/**
 * CPU profile of one API request, in-process (docs/PERFORMANCE-REVIEW.md): signs in as a perf-seed user, warms
 * up, then records `--runs` requests with the V8 profiler and prints the top functions by self time, plus the wall
 * time of each run. Local databases only (like perf-seed).
 *   pnpm --filter @bines/api exec tsx scripts/perf-profile.ts GET /boards/<id>/items [--runs 3] [--body '{...}']
 * Writes perf/results/profile-<timestamp>.cpuprofile (open it in Chrome DevTools → Performance).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { memoryMailer } from '@bines/server-mail';
import { createApp } from '../src/app';
import { createDb } from '../src/db/client';
import { createDeps } from '../src/deps';
import { loadEnv } from '../src/env';
import { createLogger } from '../src/lib/logger';
import { nullBus } from '../src/lib/realtime';
import { memoryStorage } from '../src/lib/storage';

const [method = 'GET', path = '/health'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const opt = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const runs = Number(opt('runs') ?? 3);
const body = opt('body');
const slug = opt('slug') ?? 'perf100k';

try {
  process.loadEnvFile(new URL('../../../.env', import.meta.url));
} catch {
  // no .env
}
const env = loadEnv({ ...process.env, LOG_LEVEL: 'warn' });
const host = new URL(env.DATABASE_URL!).hostname;
if (!['localhost', '127.0.0.1'].includes(host)) throw new Error('local databases only');
const config = JSON.parse(readFileSync(new URL(`../../../perf/.perf-${slug}.json`, import.meta.url), 'utf8')) as {
  account_id: string;
  password: string;
  users: string[];
};
const { db, close } = createDb(env.DATABASE_URL!);
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
  .find((c) => c.startsWith('bos.session_token='))!;
const send = async () => {
  const t = performance.now();
  const res = await app.request(`/api/v1${path}`, {
    method,
    headers: {
      origin,
      cookie,
      'x-account-id': config.account_id,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body,
  });
  const size = (await res.arrayBuffer()).byteLength;
  return { status: res.status, ms: performance.now() - t, size };
};

try {
  console.warn('warm-up', await send());
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 200 });
  await session.post('Profiler.start');
  for (let i = 0; i < runs; i++) console.warn(`run ${i + 1}`, await send());
  const { profile } = await session.post('Profiler.stop');
  mkdirSync(new URL('../../../perf/results/', import.meta.url), { recursive: true });
  const file = new URL(`../../../perf/results/profile-${Date.now()}.cpuprofile`, import.meta.url);
  writeFileSync(file, JSON.stringify(profile));

  // Self time per function (sample counts × interval).
  const dt = profile.timeDeltas ?? [];
  const byNode = new Map<number, number>();
  (profile.samples ?? []).forEach((id, i) => byNode.set(id, (byNode.get(id) ?? 0) + (dt[i] ?? 0)));
  const self = new Map<string, number>();
  for (const n of profile.nodes) {
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.split(/[\\/]/).slice(-2).join('/')}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (byNode.get(n.id) ?? 0));
  }
  const total = [...self.values()].reduce((s, x) => s + x, 0);
  console.warn(`\nself time, ${runs} runs (total ${(total / 1000).toFixed(0)} ms sampled):`);
  for (const [k, us] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) {
    console.warn(`${(us / 1000).toFixed(0).padStart(7)} ms  ${((us / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
  }
} finally {
  await close();
}
