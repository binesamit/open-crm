// SPDX-License-Identifier: AGPL-3.0-only
import {
  GROUP_PATH_SEP,
  newId,
  rankBetween,
  groupOptsOf,
  outlineSections,
  type QueryEnv,
  type QueryRow,
  resolveField,
} from '@bines/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cells, columns, items } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * The server's target for the 2-level outline on 30,000 rows (the plan: under a second on Postgres). The tests run
 * on PGlite (in-process, single-threaded): ≈360 ms alone, ≈1.2 s while the whole suite runs in parallel — so the
 * bound here is 3 s (a regression of the grouping engine shows as a multiple, not a few hundred ms).
 */
const OUTLINE_TARGET_MS = 3000;

/**
 * Prod ק3: grouping in up to three levels. The server's outline returns each node in tree
 * order — a parent with its count and summaries, then its children with their ids — with the board's groups as the
 * first level when the view groups by none; and it stays fast on 30,000 rows.
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
let groupIds: string[];
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme-group-levels',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  const ws = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Levels', workspace_id: ws }))).id;
  await as().post(`/boards/${boardId}/columns`, { id: 'st', title: 'Status', type: 'status' });
  await as().post(`/boards/${boardId}/columns`, { id: 'due', title: 'Due', type: 'date' });
  await as().post(`/boards/${boardId}/columns`, { id: 'amt', title: 'Amount', type: 'numbers' });
  groupIds = ((await body(await as().get(`/boards/${boardId}`))).groups as Json[]).map((g) => g.id);
  for (const [name, index, date, amt, g] of [
    ['A', 1, '2026-01-10', 100, 0],
    ['B', 1, '2026-02-10', 200, 0],
    ['C', 0, '2026-01-20', 300, 1],
    ['D', 1, '2026-01-25', 400, 1],
  ] as const)
    await as().post(`/boards/${boardId}/items`, {
      name,
      group_id: groupIds[Math.min(g, groupIds.length - 1)],
      cells: { st: { index }, due: { date }, amt },
    });
});
afterAll(() => t.close());

const outline = async (query: Json) => {
  const res = await as().post(`/boards/${boardId}/items/outline`, {
    query,
    summaries: [{ column_id: 'amt', fn: 'sum' }],
  });
  expect(res.status).toBe(200);
  return (await body(res)).sections as Json[];
};
const shape = (sections: Json[]) =>
  sections.map((s) => [
    s.key.split(GROUP_PATH_SEP).join(' › '),
    s.level,
    s.count ?? s.ids.length,
    s.summaries.amt.text,
  ]);

describe('nested grouping ( ק3)', () => {
  it('status › month: each parent with its count and sum, then its children with their rows', async () => {
    const sections = await outline({
      group_by: { column_id: 'st' },
      subgroups: [{ column_id: 'due', date_unit: 'month' }],
    });
    expect(shape(sections)).toEqual([
      ['0', 0, 1, '300'],
      ['0 › 2026-01', 1, 1, '300'],
      ['1', 0, 3, '700'],
      ['1 › 2026-01', 1, 2, '500'],
      ['1 › 2026-02', 1, 1, '200'],
    ]);
    // A parent carries no ids (its children do).
    expect(sections[0]!.ids).toEqual([]);
  });

  it("the board's groups as the first level, in the board's order", async () => {
    const sections = await outline({ subgroups: [{ column_id: 'st' }] });
    expect(sections.filter((s) => s.level === 0).map((s) => s.key)).toEqual(
      groupIds.filter((id) => sections.some((s) => s.key === id)),
    );
    expect(sections.find((s) => s.level === 1)?.key.startsWith(`${sections[0]!.key}${GROUP_PATH_SEP}`)).toBe(true);
  });

  it('a saved view keeps its levels; a column that is gone drops its level', async () => {
    const sections = await outline({ group_by: { column_id: 'st' }, subgroups: [{ column_id: 'gone' }] });
    expect(sections.every((s) => s.level === undefined)).toBe(true);
  });
});

describe('nested grouping performance ( ק3)', () => {
  it('the server: POST /items/outline, 30,000 rows in two levels with a sum — under the target', async () => {
    const ws = (await body(await as().get('/workspaces'))).data[0].id;
    const perf = await body(await as().post('/boards', { name: 'Perf 30k', workspace_id: ws }));
    await as().post(`/boards/${perf.id}/columns`, { id: 'st', title: 'Status', type: 'status' });
    await as().post(`/boards/${perf.id}/columns`, { id: 'due', title: 'Due', type: 'date' });
    await as().post(`/boards/${perf.id}/columns`, { id: 'amt', title: 'Amount', type: 'numbers' });
    const cols = await t.db.select().from(columns).where(eq(columns.boardId, perf.id));
    const colId = (key: string) => cols.find((c) => c.key === key)!.id;
    const groupId = ((await body(await as().get(`/boards/${perf.id}`))).groups as Json[])[0]!.id;
    // Straight into the database (the API would take minutes for 30,000 items).
    let pos: string | null = null;
    for (let start = 0; start < 30_000; start += 2000) {
      const itemRows: (typeof items.$inferInsert)[] = [];
      const cellRows: (typeof cells.$inferInsert)[] = [];
      for (let i = start; i < start + 2000; i++) {
        const id = newId();
        pos = rankBetween(pos, null);
        itemRows.push({ id, accountId: acmeId, boardId: perf.id, groupId, position: pos, name: `Item ${i}` });
        const values: [string, unknown][] = [
          ['st', { index: i % 3 }],
          ['due', { date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-15` }],
          ['amt', i % 1000],
        ];
        for (const [key, value] of values)
          cellRows.push({
            itemId: id,
            columnId: colId(key),
            accountId: acmeId,
            boardId: perf.id,
            value: value as Record<string, never>,
          });
      }
      await t.db.insert(items).values(itemRows);
      await t.db.insert(cells).values(cellRows);
    }
    const request = {
      query: { group_by: { column_id: 'st' }, subgroups: [{ column_id: 'due', date_unit: 'month' }] },
      summaries: [{ column_id: 'amt', fn: 'sum' }],
    };
    await as().post(`/boards/${perf.id}/items/outline`, request); // warm-up (caches, the first plan)
    const started = performance.now();
    const res = await as().post(`/boards/${perf.id}/items/outline`, request);
    const ms = performance.now() - started;
    expect(res.status).toBe(200);
    const sections = (await body(res)).sections as Json[];
    expect(sections.filter((s) => s.level === 1).reduce((n, s) => n + s.ids.length, 0)).toBe(30_000);
    console.warn(`[perf] nested outline, 30,000 rows, 2 levels + sum: ${Math.round(ms)} ms (PGlite)`);
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(OUTLINE_TARGET_MS);
  }, 300_000);

  it('30,000 rows in two levels with a sum per section — under a second', () => {
    const env: QueryEnv = {
      columns: [
        {
          id: 'st',
          type: 'status',
          settings: { labels: [0, 1, 2, 3, 4].map((id) => ({ id, label: `L${id}`, color: 'blue' })) },
        },
        { id: 'due', type: 'date', settings: {} },
        { id: 'amt', type: 'numbers', settings: {} },
      ],
      meId: null,
      today: '2026-10-13',
      timezone: 'UTC',
      weekend: 'fri_sat',
      firstDay: 0,
    };
    const rows: QueryRow[] = Array.from({ length: 30_000 }, (_, i) => ({
      id: `i${i}`,
      group_id: 'g',
      parent_item_id: null,
      depth: 0,
      name: `Item ${i}`,
      position: String(i),
      key: null,
      cells: {
        st: { value: { index: i % 5 }, text: `L${i % 5}` },
        due: {
          value: { date: `2026-${String(1 + (i % 12)).padStart(2, '0')}-15` },
          text: null,
        },
        amt: { value: i % 1000, text: String(i % 1000) },
      },
      created_at: '2026-01-01T00:00:00Z',
      created_by: null,
      updated_at: '2026-01-01T00:00:00Z',
    }));
    const base = { timezone: 'UTC', emptyLabel: '', dates: { env, label: (k: string) => k } };
    const started = performance.now();
    const sections = outlineSections(rows, {
      timezone: 'UTC',
      groupOrder: [],
      summaries: [{ field: resolveField('amt', env), fn: 'sum' }],
      levels: [
        { field: resolveField('st', env), opts: groupOptsOf(undefined, base) },
        { field: resolveField('due', env), opts: groupOptsOf({ date_unit: 'month' }, base) },
      ],
    });
    const ms = performance.now() - started;
    expect(sections).toHaveLength(5 + 5 * 12);
    expect(sections.filter((s) => s.level === 1).reduce((n, s) => n + s.ids.length, 0)).toBe(30_000);
    expect(ms, `${Math.round(ms)} ms`).toBeLessThan(1000);
  });
});
