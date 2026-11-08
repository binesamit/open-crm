// SPDX-License-Identifier: AGPL-3.0-only
import {
  applyPlan,
  planQuery,
  querySchema,
  groupRows,
  type QueryEnv,
  type QueryInput,
  type QueryRow,
  resolveField,
  summarize,
  WINDOW_MIN_ITEMS,
} from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Windowed boards (perf review §7.1): `GET items?window=1` answers a big board with its size only, and
 * `POST items/outline` gives the view's ids per section with server-side summaries. The outline must be exactly
 * what the browser computes over the whole board (same engine): same ids in the same order per section, same
 * footer summaries — on the SQL path and on the memory path (formulas).
 */
let t: TestContext;
let admin: string;
let acmeId: string;
let boardId: string;
let g1: string;
let g2: string;
let ownerId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = () => t.api(admin, acmeId);
const N = 36;

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  await t.api(admin).post('/invitations/accept', { token });
  ownerId = (await body(await as().get('/users'))).data[0].user_id;
  const wsId = (await body(await as().get('/workspaces'))).data[0].id;
  boardId = (await body(await as().post('/boards', { name: 'Big', workspace_id: wsId }))).id;
  g1 = (await body(await as().get(`/boards/${boardId}`))).groups[0].id;
  g2 = (await body(await as().post(`/boards/${boardId}/groups`, { title: 'G2', position: 'bottom' }))).id;
  await as().post(`/boards/${boardId}/columns`, { id: 'stage', title: 'Stage', type: 'status' });
  await as().post(`/boards/${boardId}/columns`, { id: 'amount', title: 'Amount', type: 'numbers' });
  await as().post(`/boards/${boardId}/columns`, { id: 'owner', title: 'Owner', type: 'people' });
  await as().post(`/boards/${boardId}/columns`, { id: 'due', title: 'Due', type: 'date' });
  await as().post(`/boards/${boardId}/columns`, {
    id: 'total',
    title: 'Total',
    type: 'formula',
    settings: { formula: '{amount}*2' },
  });
  for (let i = 0; i < N; i++) {
    const cells: Record<string, unknown> = {};
    if (i % 4 !== 3) cells.stage = { index: i % 3 };
    if (i % 5 !== 4) cells.amount = (i * 7) % 23;
    if (i % 2 === 0) cells.owner = { persons_and_teams: [{ id: ownerId, kind: 'person' }] };
    if (i % 3 !== 2) cells.due = { date: `2026-0${1 + (i % 9)}-1${i % 10}` };
    const res = await as().post(`/boards/${boardId}/items`, {
      name: `Deal ${String(i).padStart(2, '0')}${i % 6 === 0 ? ' acme' : ''}`,
      group_id: i % 3 === 0 ? g2 : g1,
      cells,
    });
    expect(res.status).toBe(201);
  }
});
afterAll(() => t.close());

/** What the browser computes over the whole board (BoardPage + BoardTable), as an outline. */
const expected = async (
  query: QueryInput,
  summaries: { column_id: string; fn?: string }[],
  layout: 'groups' | 'flat' = 'groups',
) => {
  const board = await body(await as().get(`/boards/${boardId}`));
  const env: QueryEnv = {
    columns: board.columns.map((c: Json) => ({ id: c.id, type: c.type, settings: c.settings })),
    meId: ownerId,
    teams: [],
    today: '2026-05-15',
    timezone: 'Asia/Jerusalem',
    weekend: 'fri_sat',
    firstDay: 0,
  };
  // The engine's order (the existing query endpoint is the browser's engine on the same rows).
  const ordered = (
    await body(
      await as().post(`/boards/${boardId}/items/query`, {
        ...query,
        group_by: undefined,
        limit: 500,
      }),
    )
  ).data as QueryRow[];
  const sum = (rows: QueryRow[]) =>
    Object.fromEntries(
      summaries.map((s) => [
        s.column_id,
        summarize(resolveField(s.column_id, env), rows, env.timezone, s.fn as never) ?? null,
      ]),
    );
  if (query.group_by) {
    // A grouping by column orders across groups (no group rank): the buckets' members are compared as sets.
    return groupRows(ordered, resolveField(query.group_by.column_id, env), {
      timezone: env.timezone,
      emptyLabel: '',
      nameOf: () => undefined,
    }).map((b) => ({ key: b.key, ids: b.rows.map((r) => r.id), summaries: sum(b.rows) }));
  }
  if (layout === 'flat') {
    // Cards: the engine over the whole board without the group order (BoardPage's `applyPlan` for non-tables).
    const all = (await body(await as().get(`/boards/${boardId}/items`))).data as QueryRow[];
    const flat = applyPlan(all, planQuery(querySchema.parse(query), env), env.timezone);
    return [{ key: '', ids: flat.map((r) => r.id), summaries: sum(flat) }];
  }
  return board.groups
    .map((g: Json) => ordered.filter((r) => r.group_id === g.id))
    .filter((rows: QueryRow[]) => rows.length)
    .map((rows: QueryRow[]) => ({ key: rows[0]!.group_id, ids: rows.map((r) => r.id), summaries: sum(rows) }));
};

const outline = async (query: QueryInput, summaries: { column_id: string; fn?: string }[] = [], extra: Json = {}) => {
  const res = await as().post(`/boards/${boardId}/items/outline`, { query, summaries, ...extra });
  expect(res.status).toBe(200);
  return body(res);
};

describe('GET /boards/:id/items?window=1', () => {
  it('a board above the threshold answers with its size only; at or below it, every row as before', async () => {
    const big = await body(await as().get(`/boards/${boardId}/items?window=1&window_min=10`));
    expect(big).toEqual({ data: [], windowed: { total: N, threshold: 10 } });
    const small = await body(await as().get(`/boards/${boardId}/items?window=1&window_min=${N}`));
    expect(small.windowed).toBeUndefined();
    expect(small.data).toHaveLength(N);
    // Default threshold, and no `window` at all: the whole board (old clients).
    expect(WINDOW_MIN_ITEMS).toBeGreaterThan(N);
    expect((await body(await as().get(`/boards/${boardId}/items?window=1`))).data).toHaveLength(N);
    expect((await body(await as().get(`/boards/${boardId}/items`))).data).toHaveLength(N);
  });

  it('never windows a sub-board (its rows come with their parents)', async () => {
    const parent = (await body(await as().get(`/boards/${boardId}/items`))).data[0];
    for (let i = 0; i < 3; i++) await as().post(`/items/${parent.id}/subitems`, { name: `Sub ${i}` });
    const subId = (await body(await as().get(`/boards/${boardId}`))).subitems_board_id;
    const sub = await body(await as().get(`/boards/${subId}/items?window=1&window_min=1`));
    expect(sub.windowed).toBeUndefined();
    expect(sub.data).toHaveLength(3);
  });
});

describe('POST /boards/:id/items/outline', () => {
  const footer = [
    { column_id: 'stage' },
    { column_id: 'amount' },
    { column_id: 'amount', fn: 'max' },
    { column_id: 'due' },
    { column_id: 'owner' },
  ];
  const strip = (o: Json) => o.sections.map((s: Json) => ({ key: s.key, ids: s.ids, summaries: s.summaries }));

  it('by board group, unfiltered: every id in board order with the footer summaries', async () => {
    const o = await outline({}, footer);
    expect(o.total).toBe(N);
    expect(o.grouped_by).toBeUndefined();
    expect(strip(o)).toEqual(await expected({}, footer));
    expect(o.sections.map((s: Json) => s.key)).toEqual([g1, g2]);
    const battery = o.sections[0].summaries.stage;
    expect(battery.kind).toBe('battery');
    expect(battery.total).toBe(o.sections[0].ids.length);
  });

  it('filter + sort + search run on the server (SQL path) — the same as the engine', async () => {
    const queries: QueryInput[] = [
      {
        filter: {
          kind: 'group',
          operator: 'and',
          negate: false,
          rules: [{ column_id: 'stage', operator: 'any_of', values: [1] }],
        },
      },
      { sort: [{ column_id: 'amount', direction: 'desc' }] },
      { search: 'acme', sort: [{ column_id: 'due', direction: 'asc' }] },
      { person: 'me' },
    ];
    for (const q of queries)
      expect(strip(await outline(q, footer)), JSON.stringify(q)).toEqual(await expected(q, footer));
  });

  it('a formula filter / sort runs in memory — same outline', async () => {
    const q: QueryInput = {
      filter: {
        kind: 'group',
        operator: 'and',
        negate: false,
        rules: [{ column_id: 'total', operator: 'greater_than', values: [10] }],
      },
      sort: [{ column_id: 'total', direction: 'desc' }],
    };
    const sums = [...footer, { column_id: 'total' }];
    expect(strip(await outline(q, sums))).toEqual(await expected(q, sums));
  });

  it('grouped by a column: buckets in the engine order, labels and colours from the column', async () => {
    for (const column_id of ['stage', 'owner', 'amount']) {
      const q: QueryInput = { group_by: { column_id }, sort: [{ column_id: 'amount', direction: 'asc' }] };
      const o = await outline(q, footer);
      expect(o.grouped_by).toBe(column_id);
      const want = await expected(q, footer);
      expect(o.sections.map((s: Json) => s.key)).toEqual(want.map((s: Json) => s.key));
      for (const [i, s] of want.entries()) expect(new Set(o.sections[i].ids)).toEqual(new Set(s.ids));
      expect(o.sections.at(-1).key).toBe('__empty__');
    }
    const stage = await outline({ group_by: { column_id: 'stage' } });
    expect(stage.sections[0].color).toBe('yellow'); // a palette key (D-PAL)
    // Kanban lanes: by its lane column, whatever the view's grouping.
    const lanes = await outline({}, [], { lanes_by: 'stage', layout: 'flat' });
    expect(lanes.sections.map((s: Json) => s.key).sort()).toEqual(['0', '1', '2', '__empty__']);
  });

  it('flat layout (Cards / Calendar): one section across groups; group summary next to each title', async () => {
    const o = await outline({ sort: [{ column_id: 'amount', direction: 'desc' }] }, [], { layout: 'flat' });
    expect(o.sections).toHaveLength(1);
    expect(strip(o)).toEqual(await expected({ sort: [{ column_id: 'amount', direction: 'desc' }] }, [], 'flat'));
    const withTitle = await outline({}, [], { group_summary: { column_id: 'amount', fn: 'sum' } });
    expect(withTitle.sections[0].group_summary).toMatchObject({ kind: 'value', fn: 'sum' });
  });

  it('ignores summaries of unknown columns; an unknown grouping column is a 422', async () => {
    const o = await outline({}, [{ column_id: 'nope' }]);
    expect(o.sections[0].summaries).toEqual({});
    const bad = await as().post(`/boards/${boardId}/items/outline`, { query: {}, lanes_by: 'nope' });
    expect(bad.status).toBe(422);
  });
});

describe('POST /boards/:id/items/bulk-query', () => {
  it('runs one batch on every match (rows the browser never loaded too), undoable as one', async () => {
    const q: QueryInput = {
      filter: {
        kind: 'group',
        operator: 'and',
        negate: false,
        rules: [{ column_id: 'stage', operator: 'any_of', values: [2] }],
      },
    };
    const before = await outline(q);
    const n = before.total as number;
    expect(n).toBeGreaterThan(0);
    const res = await as().post(`/boards/${boardId}/items/bulk-query`, {
      query: q,
      action: { type: 'set_cell', column_id: 'amount', value: 1000 },
    });
    expect(res.status).toBe(200);
    const result = await body(res);
    expect(result.done).toBe(n);
    const rows = (await body(await as().get(`/boards/${boardId}/items`))).data as Json[];
    const changed = rows.filter((r) => r.cells.amount?.value === 1000);
    expect(changed.map((r) => r.id).sort()).toEqual([...before.sections.flatMap((s: Json) => s.ids)].sort());
    expect((await as().post(`/activity/${result.event_id}/undo`)).status).toBe(200);
    const after = (await body(await as().get(`/boards/${boardId}/items`))).data as Json[];
    expect(after.filter((r) => r.cells.amount?.value === 1000)).toHaveLength(0);
  });
});
