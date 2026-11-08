// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Round 15 — dashboards over subitems and the board Dashboard view:
 * - every board-reading widget reads the items, the subitems (the sub-board, its own columns) or both;
 * - the sub-board's columns are offered to the widget pickers (merged by type + title with the board's);
 * - permissions hold: a member sees only subitems under items he may see, a column hidden on the sub-board
 *   adds nothing for him, a private board's subitems are not his;
 * - a board's Dashboard view keeps its widgets in the view settings (validated like a dashboard's) and reads
 *   them through POST /boards/:id/widget-data, narrowed by the view's filter / search.
 */
let t: TestContext;
let admin: string;
let bob: string;
let acmeId: string;
let otherAdmin: string;
let wsId: string;
let bobId: string;
let A: string;
let subA: string;
let C: string;
let dash: Json;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string, account = acmeId) => t.api(cookie, account);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
  return cookie;
};

const LABELS = [
  { id: 0, label: 'Working', color: 'yellow', index: 0 },
  { id: 1, label: 'Done', color: 'forest', index: 1, is_done: true },
];
const status = { type: 'status', title: 'Status' };
const amount = { type: 'numbers', title: 'Amount' };
const sum = { fn: 'sum', column: amount };
const person = (id: string) => ({ persons_and_teams: [{ id, kind: 'person' }] });

const addWidget = async (type: string, settings: Json = {}) => {
  const res = await as(admin).post(`/dashboards/${dash.id}/widgets`, { type, settings });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return body(res);
};
const data = async (cookie: string, widgetId: string) => {
  const res = await as(cookie).post(`/dashboards/${dash.id}/widgets/${widgetId}/data`, {});
  return { status: res.status, ...(await body(res)) } as Json;
};
const boardData = async (cookie: string, boardId: string, widget: Json, query?: Json, account = acmeId) => {
  const res = await as(cookie, account).post(`/boards/${boardId}/widget-data`, { widget, ...(query ? { query } : {}) });
  return { status: res.status, ...(await body(res)) } as Json;
};

beforeAll(async () => {
  t = await createTestContext();
  const ownerCookie = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const account = async (slug: string, email: string) =>
    (
      await body(
        await t.api(ownerCookie).post('/platform/accounts', {
          name: slug,
          slug,
          first_admin_email: email,
          template_set: 'empty',
        }),
      )
    ).account.id as string;
  acmeId = await account('acme', 'admin@acme.test');
  await account('other', 'admin@other.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  bobId = users.find((u) => u.email === 'bob@acme.test')!.user_id as string;
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;

  const board = async (name: string, kind = 'main') => {
    const id = (await body(await as(admin).post('/boards', { name, workspace_id: wsId, kind }))).id as string;
    for (const [key, c, settings] of [
      ['status', status, { labels: LABELS }],
      ['amount', amount, {}],
      ['owner', { type: 'people', title: 'Owner' }, {}],
    ] as [string, Json, Json][])
      expect((await as(admin).post(`/boards/${id}/columns`, { id: key, ...c, settings })).status).toBe(201);
    return id;
  };
  A = await board('Projects');
  C = await board('Secret', 'private');
  // Members see only the items they are assigned to (and their subitems — D14).
  expect(
    (await as(admin).put(`/boards/${A}/permissions`, { view_items: { mode: 'assigned_or_created' } })).status,
  ).toBe(200);
  const item = async (boardId: string, name: string, cells: Json) => {
    const res = await as(admin).post(`/boards/${boardId}/items`, { name, cells });
    expect(res.status).toBe(201);
    return (await body(res)).id as string;
  };
  const a1 = await item(A, 'a1', { status: { index: 1 }, amount: 100, owner: person(bobId) });
  const a2 = await item(A, 'a2', { status: { index: 0 }, amount: 50 });
  await item(A, 'a3', { status: { index: 1 }, amount: 30 });
  const c1 = await item(C, 'c1', { status: { index: 1 }, amount: 1000 });

  // The first subitem creates the sub-board; then its own columns, titled like the board's.
  const first = await body(await as(admin).post(`/items/${a1}/subitems`, { name: 'a1.s1' }));
  subA = (await body(await as(admin).get(`/boards/${A}`))).subitems_board_id as string;
  expect(subA).toBeTruthy();
  for (const [key, c, settings] of [
    ['sstatus', status, { labels: LABELS }],
    ['samount', amount, {}],
  ] as [string, Json, Json][])
    expect((await as(admin).post(`/boards/${subA}/columns`, { id: key, ...c, settings })).status).toBe(201);
  const cell = async (id: string, key: string, value: unknown) =>
    expect((await as(admin).put(`/items/${id}/cells/${key}`, { value })).status).toBe(200);
  await cell(first.id, 'sstatus', { index: 1 });
  await cell(first.id, 'samount', 7);
  const sub = async (parent: string, name: string, cells: Json) =>
    expect((await as(admin).post(`/items/${parent}/subitems`, { name, cells })).status).toBe(201);
  await sub(a1, 'a1.s2', { sstatus: { index: 0 }, samount: 3 });
  await sub(a2, 'a2.s1', { sstatus: { index: 1 }, samount: 20 });
  await as(admin).post(`/items/${c1}/subitems`, { name: 'c1.s1' });

  dash = await body(await as(admin).post(`/workspaces/${wsId}/dashboards`, { name: 'Ops', board_ids: [A, C] }));
});
afterAll(() => t.close());

describe('widgets over subitems', () => {
  it('the pickers get the sub-board too, its columns merged with the board’s by type + title', async () => {
    const cols = await body(await as(admin).get(`/dashboards/${dash.id}/columns`));
    const sub = cols.boards.find((b: Json) => b.id === subA);
    expect(sub).toMatchObject({ name: 'Projects', subitems_of: A, views: [] });
    expect(cols.boards.find((b: Json) => b.id === A).subitems_of).toBeNull();
    const merged = cols.columns.find((c: Json) => c.type === 'numbers' && c.title === 'Amount');
    expect(merged.keys[A]).toBe('amount');
    expect(merged.keys[subA]).toBe('samount');
  });

  it('numbers: items, subitems or both of every source board', async () => {
    const items = await addWidget('numbers', { measure: sum, board_ids: [A] });
    const subs = await addWidget('numbers', { measure: sum, board_ids: [A], source: 'subitems' });
    const all = await addWidget('numbers', { measure: sum, board_ids: [A], source: 'both' });
    expect(items.settings.source).toBe('items');
    expect((await data(admin, items.id)).data.value).toBe(180);
    const s = await data(admin, subs.id);
    expect(s.data.value).toBe(7 + 3 + 20);
    expect(s.data.items).toBe(3);
    expect((await data(admin, all.id)).data.value).toBe(180 + 30);
  });

  it('a chart groups subitems by a sub-board column; "by board" puts them under their board', async () => {
    const byStatus = await addWidget('chart', {
      source: 'subitems',
      board_ids: [A],
      x: { kind: 'column', column: status },
    });
    const rows = (await data(admin, byStatus.id)).data.rows as Json[];
    expect(Object.fromEntries(rows.map((r) => [r.label, r.values.value]))).toEqual({ Done: 2, Working: 1 });
    const byBoard = await addWidget('chart', { source: 'both', board_ids: [A], x: { kind: 'board' } });
    const b = (await data(admin, byBoard.id)).data.rows as Json[];
    expect(b).toEqual([expect.objectContaining({ key: A, label: 'Projects', values: { value: 6 } })]);
  });

  it('a table names each subitem’s parent and links it over its board', async () => {
    const w = await addWidget('table', { source: 'subitems', board_ids: [A], columns: [amount] });
    const rows = (await data(admin, w.id)).data.rows as Json[];
    const s2 = rows.find((r) => r.name === 'a1.s2')!;
    expect(s2).toMatchObject({ parent_name: 'a1', board_id: A, board_name: 'Projects' });
    expect(s2.cells[0].text).toBe('3');
  });

  it('permissions: only subitems under items he may see, not hidden columns, not private boards', async () => {
    const w = await addWidget('numbers', { source: 'subitems' }); // all sources (A and C), count
    const forAdmin = await data(admin, w.id);
    expect(forAdmin.data.value).toBe(4); // three on A, one on C
    const forBob = await data(bob, w.id);
    expect(forBob.hidden_boards).toBe(1); // C is private
    expect(forBob.data.value).toBe(2); // a1's subitems only (a1 is his)

    const amountSum = await addWidget('numbers', { source: 'subitems', measure: sum, board_ids: [A] });
    expect((await data(bob, amountSum.id)).data.value).toBe(10);
    // The board's amount column hidden from members: with items and subitems, Bob sums the subitems' only (the
    // sub-board has its own column); the admin still gets both.
    const both = await addWidget('numbers', { source: 'both', measure: sum, board_ids: [A] });
    expect((await data(bob, both.id)).data.value).toBe(100 + 10);
    expect((await as(admin).put(`/boards/${A}/columns/amount/restriction`, { kind: 'view' })).status).toBe(200);
    expect((await data(bob, both.id)).data.value).toBe(10);
    expect((await data(admin, both.id)).data.value).toBe(180 + 30);
    const cols = await body(await as(bob).get(`/dashboards/${dash.id}/columns`));
    expect(cols.boards.find((b: Json) => b.id === A).columns.map((c: Json) => c.id)).not.toContain('amount');
    expect(cols.boards.find((b: Json) => b.id === subA).columns.map((c: Json) => c.id)).toContain('samount');
    expect((await as(admin).put(`/boards/${A}/columns/amount/restriction`, { kind: null })).status).toBe(200);
  });
});

describe('the board Dashboard view', () => {
  const numbersSub = { type: 'numbers', settings: { source: 'subitems', measure: sum } };

  it('reads one board through the same engine, narrowed by the view’s filter and search', async () => {
    const whole = await boardData(admin, A, numbersSub);
    expect(whole).toMatchObject({ status: 200, type: 'numbers', hidden_boards: 0 });
    expect(whole.boards).toEqual([{ id: A, name: 'Projects' }]);
    expect(whole.data.value).toBe(30);
    // The view shows the "Done" items (a1, a3): only the subitems under them count.
    const done = {
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [{ kind: 'rule', column_id: 'status', operator: 'any_of', values: ['Done'] }],
      },
    };
    expect((await boardData(admin, A, numbersSub, done)).data.value).toBe(10);
    expect((await boardData(admin, A, numbersSub, { search: 'a2' })).data.value).toBe(20);
    // Items: the view's filter applies to them directly.
    expect(
      (await boardData(admin, A, { type: 'numbers', settings: { measure: sum, source: 'both' } }, done)).data.value,
    ).toBe(100 + 30 + 10);
    // Per viewer: Bob gets his part only.
    expect((await boardData(bob, A, numbersSub)).data.value).toBe(10);
  });

  it('is a board read: a sub-board, another account or an unknown widget type are refused', async () => {
    expect((await boardData(admin, subA, numbersSub)).status).toBe(400);
    expect((await boardData(otherAdmin, A, numbersSub, undefined, acmeId)).status).toBe(404);
    expect((await boardData(admin, A, { type: 'board_view', settings: {} })).status).toBe(400);
    expect((await boardData(admin, A, { type: 'numbers', settings: { measure: { fn: 'sum' } } })).status).toBe(400);
    const cols = await body(await as(admin).get(`/boards/${A}/widget-columns`));
    expect(cols.boards.map((b: Json) => [b.id, b.subitems_of])).toEqual([
      [A, null],
      [subA, A],
    ]);
  });

  it('keeps its widgets in the view settings, validated like a dashboard’s', async () => {
    const widget = { id: 'w1', type: 'numbers', position: { x: 0, y: 0, w: 3, h: 2 }, settings: { source: 'both' } };
    const res = await as(admin).post(`/boards/${A}/views`, {
      type: 'dashboard',
      name: 'Overview',
      settings: { dashboard: { widgets: [widget] } },
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
    const view = await body(res);
    expect(view.type).toBe('dashboard');
    expect(view.settings.dashboard.apply_view_filter).toBe(true);
    expect(view.settings.dashboard.widgets[0].settings).toMatchObject({
      source: 'both',
      measure: { fn: 'count', column: null },
    });
    const bad = { ...widget, settings: { measure: { fn: 'sum' } } };
    expect((await as(admin).patch(`/views/${view.id}`, { settings: { dashboard: { widgets: [bad] } } })).status).toBe(
      400,
    );
    expect(
      (
        await as(admin).patch(`/views/${view.id}`, {
          settings: { dashboard: { widgets: [{ ...widget, type: 'board_view' }] } },
        })
      ).status,
    ).toBe(400);
    const saved = await as(admin).patch(`/views/${view.id}`, {
      settings: { dashboard: { widgets: [widget, { ...widget, id: 'w2', type: 'text' }], apply_view_filter: false } },
    });
    expect(saved.status).toBe(200);
    const listed = (await body(await as(bob).get(`/boards/${A}/views`))).data as Json[];
    const mine = listed.find((v) => v.id === view.id)!;
    expect(mine.settings.dashboard.widgets.map((w: Json) => w.id)).toEqual(['w1', 'w2']);
    expect(mine.settings.dashboard.apply_view_filter).toBe(false);
  });
});
