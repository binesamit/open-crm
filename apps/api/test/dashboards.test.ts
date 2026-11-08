// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext, WEB_ORIGIN } from './helpers';

/**
 * M8 ד4–ד5 — dashboards: a workspace object (tree, permissions D25, trash), widgets from a registry on a grid, and
 * data computed per viewer across boards: each board's access, `view_items` and column rules apply, so a
 * restricted member sees other numbers than an admin. Live refresh through the dashboard stream.
 */
let t: TestContext;
let admin: string;
let bob: string; // member — A shows him only his items; C is private (not his)
let vera: string; // account viewer
let gus: string; // guest
let acmeId: string;
let otherAdmin: string;
let otherId: string;
let wsId: string;
let ids: Record<'admin' | 'bob' | 'gus', string>;
let A: string;
let B: string;
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

const STATUS_A = [
  { id: 0, label: 'Working', color: 'yellow', index: 0 },
  { id: 1, label: 'Done', color: 'forest', index: 1, is_done: true },
];
// The same labels with other ids on board B: widgets meet them by text.
const STATUS_B = [
  { id: 3, label: 'Done', color: 'forest', index: 0, is_done: true },
  { id: 4, label: 'Blocked', color: 'crimson', index: 1 },
];
const status = { type: 'status', title: 'Status' };
const amount = { type: 'numbers', title: 'Amount' };
const owner = { type: 'people', title: 'Owner' };
const due = { type: 'date', title: 'Due' };

const addWidget = async (cookie: string, type: string, settings: Json = {}, title = '') => {
  const res = await as(cookie).post(`/dashboards/${dash.id}/widgets`, { type, settings, title });
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201);
  return body(res);
};
const data = async (cookie: string, widgetId: string, filter?: Json, dashboardId = dash.id) => {
  const res = await as(cookie).post(`/dashboards/${dashboardId}/widgets/${widgetId}/data`, filter ? { filter } : {});
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
  otherId = await account('other', 'admin@other.test');
  admin = await join('admin@acme.test');
  otherAdmin = await join('admin@other.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await as(admin).post('/users/invite', { emails: ['vera@acme.test'], role: 'viewer' });
  await as(admin).post('/users/invite', { emails: ['gus@guest.test'], role: 'guest' });
  bob = await join('bob@acme.test');
  vera = await join('vera@acme.test');
  gus = await join('gus@guest.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => users.find((u) => u.email === email)!.user_id as string;
  ids = { admin: idOf('admin@acme.test'), bob: idOf('bob@acme.test'), gus: idOf('gus@guest.test') };
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;

  const board = async (name: string, keys: [string, string, string, string], labels: Json[], kind = 'main') => {
    const id = (await body(await as(admin).post('/boards', { name, workspace_id: wsId, kind }))).id as string;
    const cols: [string, Json, Json][] = [
      [keys[0], status, { labels }],
      [keys[1], amount, {}],
      [keys[2], owner, {}],
      [keys[3], due, {}],
    ];
    for (const [key, c, settings] of cols)
      expect((await as(admin).post(`/boards/${id}/columns`, { id: key, ...c, settings })).status).toBe(201);
    return id;
  };
  A = await board('Alpha board', ['status', 'amount', 'owner', 'due'], STATUS_A);
  B = await board('Beta board', ['stage', 'sum', 'who', 'when'], STATUS_B);
  C = await board('Secret board', ['status', 'amount', 'owner', 'due'], STATUS_A, 'private');
  // On A, members see only the items they are assigned to or created.
  expect(
    (await as(admin).put(`/boards/${A}/permissions`, { view_items: { mode: 'assigned_or_created' } })).status,
  ).toBe(200);

  const person = (id: string) => ({ persons_and_teams: [{ id, kind: 'person' }] });
  const item = async (boardId: string, name: string, cells: Json) =>
    expect((await as(admin).post(`/boards/${boardId}/items`, { name, cells })).status).toBe(201);
  await item(A, 'a1', { status: { index: 1 }, amount: 100, owner: person(ids.bob), due: { date: '2026-10-05' } });
  await item(A, 'a2', { status: { index: 0 }, amount: 50, owner: person(ids.admin), due: { date: '2026-10-20' } });
  await item(A, 'a3', { status: { index: 1 }, amount: 30 });
  await item(B, 'b1', { stage: { index: 3 }, sum: 10, who: person(ids.bob), when: { date: '2026-11-02' } });
  await item(B, 'b2', { stage: { index: 4 }, sum: 5, who: person(ids.admin) });
  await item(C, 'c1', { status: { index: 1 }, amount: 1000 });
});
afterAll(() => t.close());

describe('dashboards in the workspace (D25)', () => {
  it('members create; the dashboard is in the sidebar tree for the workspace, not for guests', async () => {
    expect((await as(vera).post(`/workspaces/${wsId}/dashboards`, {})).status).toBe(403);
    expect((await as(gus).post(`/workspaces/${wsId}/dashboards`, {})).status).toBe(404);
    const res = await as(admin).post(`/workspaces/${wsId}/dashboards`, { name: 'Sales', board_ids: [A, B, C] });
    expect(res.status).toBe(201);
    dash = await body(res);
    expect(dash).toMatchObject({ name: 'Sales', kind: 'main', hidden_boards: 0, widgets: [] });
    expect(dash.boards.map((b: Json) => b.id)).toEqual([A, B, C]);
    expect(dash.capabilities).toEqual({ 'dashboard.read': true, 'dashboard.edit': true, 'dashboard.manage': true });

    const tree = await body(await as(bob).get(`/workspaces/${wsId}/tree`));
    expect(tree.entities.find((e: Json) => e.id === dash.id)).toMatchObject({
      type: 'dashboard',
      name: 'Sales',
      can_update: false,
    });
    // Bob sees the main dashboard read-only — and only the boards he may read.
    const mine = await body(await as(bob).get(`/dashboards/${dash.id}`));
    expect(mine.capabilities['dashboard.edit']).toBe(false);
    expect(mine.boards.map((b: Json) => b.id)).toEqual([A, B]);
    expect(mine.hidden_boards).toBe(1);
    expect((await as(vera).get(`/dashboards/${dash.id}`)).status).toBe(200);
    expect((await as(gus).get(`/dashboards/${dash.id}`)).status).toBe(404);
    expect((await as(otherAdmin, otherId).get(`/dashboards/${dash.id}`)).status).toBe(404);
    // A board one cannot read is never added by them.
    const bobs = await body(await as(bob).post(`/workspaces/${wsId}/dashboards`, { name: 'Mine' }));
    expect((await as(bob).patch(`/dashboards/${bobs.id}`, { settings: { board_ids: [C] } })).status).toBe(400);
    expect((await as(bob).patch(`/dashboards/${bobs.id}`, { settings: { board_ids: [A] } })).status).toBe(200);
  });

  it('the sources picker lists every board I may read, from all workspaces, in one call', async () => {
    const names = async (cookie: string, account = acmeId) => {
      const res = await as(cookie, account).get('/dashboards/source-options');
      expect(res.status).toBe(200);
      return ((await body(res)).data as Json[]).map((b) => b.name as string);
    };
    const adminSees = await names(admin);
    expect(adminSees).toEqual(expect.arrayContaining(['Alpha board', 'Beta board', 'Secret board']));
    expect((await body(await as(admin).get('/dashboards/source-options'))).data[0]).toMatchObject({
      workspace_id: wsId,
    });
    // Bob does not read the private board; another account's admin sees none of acme's boards.
    const bobSees = await names(bob);
    expect(bobSees).toEqual(expect.arrayContaining(['Alpha board', 'Beta board']));
    expect(bobSees).not.toContain('Secret board');
    expect(await names(otherAdmin, otherId)).not.toContain('Alpha board');
  });

  it('GET /boards: the boards of every workspace I see in one call — exactly what the trees show', async () => {
    const viaTrees = async (cookie: string) => {
      const ws = (await body(await as(cookie).get('/workspaces'))).data as Json[];
      const ids: string[] = [];
      for (const w of ws) {
        const tree = await body(await as(cookie).get(`/workspaces/${w.id as string}/tree`));
        ids.push(...(tree.boards as Json[]).map((b) => b.id as string));
      }
      return ids.sort();
    };
    for (const cookie of [admin, bob]) {
      const res = await as(cookie).get('/boards');
      expect(res.status).toBe(200);
      const list = (await body(res)).data as Json[];
      expect(list.map((b) => b.id as string).sort()).toEqual(await viaTrees(cookie));
      expect(list[0]).toMatchObject({ workspace_id: expect.any(String), kind: expect.any(String) });
    }
    const bobNames = ((await body(await as(bob).get('/boards'))).data as Json[]).map((b) => b.name);
    expect(bobNames).not.toContain('Secret board');
    const otherNames = ((await body(await as(otherAdmin, otherId).get('/boards'))).data as Json[]).map((b) => b.name);
    expect(otherNames).not.toContain('Alpha board');
  });

  it('a private dashboard is seen only by who is invited; guests cannot be invited', async () => {
    const p = await body(await as(admin).post(`/workspaces/${wsId}/dashboards`, { name: 'Private', kind: 'private' }));
    expect((await as(bob).get(`/dashboards/${p.id}`)).status).toBe(404);
    const tree = await body(await as(bob).get(`/workspaces/${wsId}/tree`));
    expect(tree.entities.some((e: Json) => e.id === p.id)).toBe(false);
    const put = (members: Json[]) => as(admin).put(`/dashboards/${p.id}/members`, { members });
    expect(
      (
        await put([
          { type: 'user', id: ids.gus, level: 'viewer' },
          { type: 'user', id: ids.admin, level: 'owner' },
        ])
      ).status,
    ).toBe(400);
    expect((await put([{ type: 'user', id: ids.bob, level: 'viewer' }])).status).toBe(400); // keeps an owner
    expect(
      (
        await put([
          { type: 'user', id: ids.admin, level: 'owner' },
          { type: 'user', id: ids.bob, level: 'viewer' },
        ])
      ).status,
    ).toBe(200);
    expect((await body(await as(bob).get(`/dashboards/${p.id}`))).capabilities['dashboard.edit']).toBe(false);
    expect((await as(bob).post(`/dashboards/${p.id}/widgets`, { type: 'text' })).status).toBe(403);
  });
});

describe('widget registry and grid', () => {
  it('validates types and settings', async () => {
    expect((await as(admin).post(`/dashboards/${dash.id}/widgets`, { type: 'nope' })).status).toBe(400);
    expect(
      (await as(admin).post(`/dashboards/${dash.id}/widgets`, { type: 'chart', settings: { chart_type: '3d' } }))
        .status,
    ).toBe(400);
    const text = await addWidget(admin, 'text', { text: 'שלום' }, 'Notes');
    expect(text).toMatchObject({ type: 'text', title: 'Notes', settings: { text: 'שלום' } });
    expect(text.position).toEqual({ x: 0, y: 0, w: 4, h: 2 });
    const res = await as(admin).patch(`/dashboard-widgets/${text.id}`, { settings: { text: 'x'.repeat(6000) } });
    expect(res.status).toBe(400);
  });

  it('a move pushes what it lands on down; only owners change the layout; removing can be undone', async () => {
    const d = await body(await as(admin).get(`/dashboards/${dash.id}`));
    const first = d.widgets[0];
    const second = await addWidget(admin, 'text', {});
    expect(second.position.y).toBe(2); // under the first
    expect((await as(bob).put(`/dashboards/${dash.id}/layout`, { widgets: [] })).status).toBe(403);
    const res = await as(admin).put(`/dashboards/${dash.id}/layout`, {
      widgets: [
        { id: second.id, position: { x: 0, y: 0, w: 6, h: 2 } },
        { id: first.id, position: { x: 2, y: 0, w: 4, h: 2 } },
      ],
    });
    expect(res.status).toBe(200);
    const placed = new Map(((await body(res)).widgets as Json[]).map((w) => [w.id, w.position]));
    expect(placed.get(second.id)).toEqual({ x: 0, y: 0, w: 6, h: 2 });
    expect(placed.get(first.id)).toEqual({ x: 2, y: 2, w: 4, h: 2 });
    expect((await as(admin).del(`/dashboard-widgets/${second.id}`)).status).toBe(200);
    expect((await body(await as(admin).get(`/dashboards/${dash.id}`))).widgets).toHaveLength(1);
    expect((await as(admin).post(`/dashboard-widgets/${second.id}/restore`)).status).toBe(200);
    expect((await body(await as(admin).get(`/dashboards/${dash.id}`))).widgets).toHaveLength(2);
    await as(admin).del(`/dashboard-widgets/${second.id}`);
  });
});

describe('widget data — per viewer, across boards', () => {
  it('numbers: sums every readable board; a restricted member gets only his items', async () => {
    const w = await addWidget(admin, 'numbers', { measure: { fn: 'sum', column: amount } });
    const forAdmin = await data(admin, w.id);
    expect(forAdmin).toMatchObject({ status: 200, hidden_boards: 0, truncated: false });
    expect(forAdmin.data.value).toBe(100 + 50 + 30 + 10 + 5 + 1000);
    expect(forAdmin.data.per_board).toEqual([
      { board_id: A, value: 180, items: 3 },
      { board_id: B, value: 15, items: 2 },
      { board_id: C, value: 1000, items: 1 },
    ]);
    const forBob = await data(bob, w.id);
    expect(forBob.hidden_boards).toBe(1);
    expect(forBob.data.value).toBe(100 + 10 + 5); // a1 on A (his), all of B, nothing of C
    expect(forBob.boards.map((b: Json) => b.id)).toEqual([A, B]);
    expect((await data(gus, w.id)).status).toBe(404);

    // Count with a widget filter: "Status is Done" (a label text — each board's own id).
    const done = await addWidget(admin, 'numbers', {
      filter: { operator: 'and', rules: [{ column: status, operator: 'any_of', values: ['Done'] }] },
    });
    expect((await data(admin, done.id)).data.value).toBe(4); // a1, a3, b1, c1
    // The dashboard's filter bar (a search) narrows every widget.
    expect((await data(admin, done.id, { search: 'a1' })).data.value).toBe(1);
    // A chosen subset of the sources.
    await as(admin).patch(`/dashboard-widgets/${done.id}`, {
      settings: { board_ids: [B], filter: { rules: [{ column: status, operator: 'any_of', values: ['Done'] }] } },
    });
    expect((await data(admin, done.id)).data.value).toBe(1);
  });

  it('numbers match the board group footer (same engine)', async () => {
    const w = await addWidget(admin, 'numbers', {
      board_ids: [A],
      measure: { fn: 'avg', column: amount },
    });
    expect((await data(admin, w.id)).data.value).toBeCloseTo((100 + 50 + 30) / 3);
    const median = await addWidget(admin, 'numbers', { board_ids: [A], measure: { fn: 'median', column: amount } });
    expect((await data(admin, median.id)).data.value).toBe(50);
  });

  it('battery: status segments merged by label across boards', async () => {
    const w = await addWidget(admin, 'battery', { column: status });
    const d = (await data(admin, w.id)).data;
    expect(d.total).toBe(6);
    expect(d.segments.map((s: Json) => [s.label, s.count])).toEqual([
      ['Working', 1],
      ['Done', 4],
      ['Blocked', 1],
    ]);
    const forBob = (await data(bob, w.id)).data;
    expect(forBob.total).toBe(3);
  });

  it('chart: count per board, a stacked chart by status, sums by a label column', async () => {
    const byBoard = await addWidget(admin, 'chart', { chart_type: 'bar', x: { kind: 'board' } });
    expect((await data(admin, byBoard.id)).data.rows.map((r: Json) => [r.label, r.values.value])).toEqual([
      ['Alpha board', 3],
      ['Beta board', 2],
      ['Secret board', 1],
    ]);
    const stacked = await addWidget(admin, 'chart', {
      chart_type: 'stacked_bar',
      x: { kind: 'board' },
      series: { kind: 'column', column: status },
    });
    const s = (await data(admin, stacked.id)).data;
    expect(s.series.map((x: Json) => x.label).sort()).toEqual(['Blocked', 'Done', 'Working']);
    const alpha = s.rows.find((r: Json) => r.key === A);
    const doneKey = s.series.find((x: Json) => x.label === 'Done').key;
    expect(alpha.values[doneKey]).toBe(2);
    const sums = await addWidget(admin, 'chart', {
      chart_type: 'pie',
      x: { kind: 'column', column: status },
      measure: { fn: 'sum', column: amount },
    });
    const pie = (await data(admin, sums.id)).data.rows.map((r: Json) => [r.label, r.values.value, r.color]);
    expect(pie).toContainEqual(['Done', 100 + 30 + 10 + 1000, 'forest']);
    expect(pie).toContainEqual(['Blocked', 5, 'crimson']);
    const byMonth = await addWidget(admin, 'chart', {
      chart_type: 'line',
      x: { kind: 'column', column: due, date_unit: 'month' },
    });
    expect((await data(admin, byMonth.id)).data.rows.map((r: Json) => [r.key, r.values.value])).toEqual([
      ['2026-10', 2],
      ['2026-11', 1],
      ['__empty__', 3],
    ]);
  });

  it('table, calendar and workload show only what the viewer may see', async () => {
    const table = await addWidget(admin, 'table', { columns: [status, amount] });
    const rows = (await data(bob, table.id)).data;
    expect(rows.rows.map((r: Json) => r.name).sort()).toEqual(['a1', 'b1', 'b2']);
    expect(rows.columns).toEqual([
      { title: 'Status', type: 'status' },
      { title: 'Amount', type: 'numbers' },
    ]);
    const b1 = rows.rows.find((r: Json) => r.name === 'b1');
    expect(b1.cells[0]).toEqual({ text: 'Done', color: 'forest' });

    const cal = await addWidget(admin, 'calendar', { date_column: due, color_column: status });
    const items = (await data(admin, cal.id)).data.items;
    expect(items.map((i: Json) => [i.name, i.from])).toEqual([
      ['a1', '2026-10-05'],
      ['a2', '2026-10-20'],
      ['b1', '2026-11-02'],
    ]);
    expect((await data(bob, cal.id)).data.items.map((i: Json) => i.name)).toEqual(['a1', 'b1']);

    const load = await addWidget(admin, 'workload', { people_column: owner, measure: { fn: 'sum', column: amount } });
    const people = (await data(admin, load.id)).data.people;
    expect(people.map((p: Json) => [p.id, p.total])).toEqual([
      [ids.bob, 110],
      [ids.admin, 55],
      ['__empty__', 1030],
    ]);
  });

  it('an embedded board view shows the board to whoever reads it, nothing to others', async () => {
    expect((await as(bob).post(`/dashboards/${dash.id}/widgets`, { type: 'board_view' })).status).toBe(403);
    const w = await addWidget(admin, 'board_view', { board_id: C });
    const forAdmin = await data(admin, w.id);
    expect(forAdmin.data.rows.map((r: Json) => r.name)).toEqual(['c1']);
    const forBob = await data(bob, w.id);
    expect(forBob).toMatchObject({ data: null, hidden_boards: 1 });
  });

  it('cross-board time report = the sum of the board reports (closes M3)', async () => {
    for (const id of [A, B])
      await as(admin).post(`/boards/${id}/columns`, { id: 'time', title: 'Time', type: 'time_tracking' });
    const itemOf = async (boardId: string, name: string) =>
      ((await body(await as(admin).get(`/boards/${boardId}/items`))).data as Json[]).find((i) => i.name === name)!.id;
    const log = (itemId: string, minutes: number, cookie = admin) =>
      as(cookie).post(`/items/${itemId}/time/entries`, {
        column_id: 'time',
        started_at: '2026-09-01T08:00:00Z',
        duration_s: minutes * 60,
      });
    expect((await log(await itemOf(A, 'a1'), 60)).status).toBe(201);
    expect((await log(await itemOf(A, 'a2'), 30)).status).toBe(201);
    expect((await log(await itemOf(B, 'b1'), 45)).status).toBe(201);
    const w = await addWidget(admin, 'time_report', { group_by: 'board', range: 'all' });
    const r = (await data(admin, w.id)).data;
    const perBoard = async (id: string) =>
      (await body(await as(admin).get(`/boards/${id}/time/report?group_by=user`))).total_s as number;
    expect(r.total_s).toBe((await perBoard(A)) + (await perBoard(B)));
    expect(r.rows.map((x: Json) => [x.label, x.duration_s])).toEqual([
      ['Alpha board', 90 * 60],
      ['Beta board', 45 * 60],
    ]);
    // By a column (a "client" column — here the status) and for a restricted viewer.
    const byCol = await addWidget(admin, 'time_report', { group_by: 'column', column: status, range: 'all' });
    expect((await data(admin, byCol.id)).data.rows.map((x: Json) => [x.label, x.duration_s])).toEqual([
      ['Done', 105 * 60],
      ['Working', 30 * 60],
    ]);
    expect((await data(bob, w.id)).data.total_s).toBe((60 + 45) * 60); // a2 is not his
  });
});

describe('drill-down: the items behind a clicked value', () => {
  const items = async (cookie: string, widgetId: string, pick: Json = {}, extra: Json = {}) => {
    const res = await as(cookie).post(`/dashboards/${dash.id}/widgets/${widgetId}/items`, { pick, ...extra });
    return { status: res.status, ...(await body(res)) } as Json;
  };
  const names = (r: Json) => (r.data as Json[]).map((x) => x.name).sort();

  it('numbers, battery, chart and workload list the items each value is made of, as the viewer sees them', async () => {
    const sum = await addWidget(admin, 'numbers', { measure: { fn: 'sum', column: amount } });
    expect(names(await items(admin, sum.id))).toEqual(['a1', 'a2', 'a3', 'b1', 'b2', 'c1']);
    // A restricted member: his items only (a1 on A, all of B, nothing of C) — like the number itself.
    expect(names(await items(bob, sum.id))).toEqual(['a1', 'b1', 'b2']);
    const first = (await items(admin, sum.id)).data[0];
    expect(first).toMatchObject({ board_id: A, board_name: 'Alpha board', parent_name: null });

    const battery = await addWidget(admin, 'battery', { column: status });
    expect(names(await items(admin, battery.id, { segment: 'done' }))).toEqual(['a1', 'a3', 'b1', 'c1']);
    expect(names(await items(admin, battery.id, { segment: 'blocked' }))).toEqual(['b2']);

    const stacked = await addWidget(admin, 'chart', {
      chart_type: 'stacked_bar',
      x: { kind: 'board' },
      series: { kind: 'column', column: status },
    });
    expect(names(await items(admin, stacked.id, { x: A }))).toEqual(['a1', 'a2', 'a3']);
    expect(names(await items(admin, stacked.id, { x: A, series: 'done' }))).toEqual(['a1', 'a3']);
    // "Other": the buckets that are none of the shown ones.
    expect(names(await items(admin, stacked.id, { not_x: [A, B] }))).toEqual(['c1']);

    const load = await addWidget(admin, 'workload', { people_column: owner, measure: { fn: 'count', column: null } });
    expect(names(await items(admin, load.id, { person: ids.bob }))).toEqual(['a1', 'b1']);
    expect(names(await items(admin, load.id, { person: '__empty__' }))).toEqual(['a3', 'c1']);
  });

  it('pages, follows the filter bar, and is off when the widget says so', async () => {
    const all = await addWidget(admin, 'numbers', {});
    const page1 = await items(admin, all.id, {}, { limit: 4 });
    expect(page1).toMatchObject({ status: 200, total: 6, next_cursor: '4' });
    const page2 = await items(admin, all.id, {}, { limit: 4, cursor: page1.next_cursor });
    expect(page2.data).toHaveLength(2);
    expect(page2.next_cursor).toBeNull();
    expect(names(await items(admin, all.id, {}, { filter: { search: 'b1' } }))).toEqual(['b1']);
    await as(admin).patch(`/dashboard-widgets/${all.id}`, { settings: { drill: false } });
    expect((await items(admin, all.id)).status).toBe(400);
    // A widget that lists its items itself opens them directly.
    const table = await addWidget(admin, 'table', {});
    expect((await items(admin, table.id)).status).toBe(400);
    expect((await items(gus, all.id)).status).toBe(404);
  });
});

describe('live refresh and trash', () => {
  it('the dashboard stream sends board events without item ids, and dashboard changes', async () => {
    const res = await t.app.request(`/api/v1/dashboards/${dash.id}/events?account_id=${acmeId}`, {
      headers: { origin: WEB_ORIGIN, cookie: bob },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: Json[] = [];
    let buf = '';
    let stop = false;
    void (async () => {
      while (!stop) {
        const chunk = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        let cut: number;
        while ((cut = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, cut);
          buf = buf.slice(cut + 2);
          const line = block.split('\n').find((l) => l.startsWith('data:'));
          if (line) events.push(JSON.parse(line.slice(5).trim()) as Json);
        }
      }
    })();
    const waitFor = async (pred: (e: Json) => boolean) => {
      for (let i = 0; i < 60; i++) {
        const hit = events.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no event; got ${JSON.stringify(events.map((e) => e.type))}`);
    };
    await waitFor((e) => e.type === 'ready');
    const b2 = ((await body(await as(admin).get(`/boards/${B}/items`))).data as Json[]).find((i) => i.name === 'b2')!;
    await as(admin).put(`/items/${b2.id}/cells/sum`, { value: 7 });
    const e = await waitFor((x) => x.type.startsWith('cell.') && x.board_id === B);
    expect(e.item_id ?? null).toBeNull();
    expect(e.actor_id ?? null).toBeNull();
    const w = (await body(await as(admin).get(`/dashboards/${dash.id}`))).widgets[0];
    await as(admin).patch(`/dashboard-widgets/${w.id}`, { title: 'Renamed' });
    await waitFor((x) => x.type === 'dashboard.widget_updated');
    stop = true;
    await reader.cancel().catch(() => {});
  });

  it('delete goes to trash and restores into the tree; a workspace with a dashboard is not empty', async () => {
    const d = await body(await as(admin).post(`/workspaces/${wsId}/dashboards`, { name: 'Temp' }));
    expect((await as(bob).del(`/dashboards/${d.id}`)).status).toBe(403);
    const del = await body(await as(admin).del(`/dashboards/${d.id}`));
    expect(del.ok).toBe(true);
    expect((await as(admin).get(`/dashboards/${d.id}`)).status).toBe(404);
    const entry = ((await body(await as(admin).get('/trash'))).data as Json[]).find((x) => x.object_id === d.id)!;
    expect(entry.object_type).toBe('dashboard');
    expect((await as(admin).post(`/trash/${entry.id}/restore`)).status).toBe(200);
    expect((await as(admin).get(`/dashboards/${d.id}`)).status).toBe(200);
    const copy = await body(await as(admin).post(`/dashboards/${dash.id}/duplicate`, {}));
    expect(copy.widgets.length).toBe((await body(await as(admin).get(`/dashboards/${dash.id}`))).widgets.length);
  });
});
