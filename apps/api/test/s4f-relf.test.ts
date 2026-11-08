// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * r19relfilter leftovers (the planning notes "RELATION-FILTERS" "מצב מימוש"): the board owners hear when a view a relation
 * column offered its items by is deleted; a board copied together with its linked board (itself), a template made
 * from it and a pack of boards keep their choice filters pointing at the copies.
 */
let t: TestContext;
let admin: string;
let bob: string;
let bobId: string;
let acmeId: string;
let wsId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const newBoard = async (name: string) => body(await as(admin).post('/boards', { name, workspace_id: wsId }));
const getBoard = async (id: string) => body(await as(admin).get(`/boards/${id}`));
const column = async (boardId: string, title: string) =>
  ((await getBoard(boardId)).columns as Json[]).find((c) => c.title === title)!;
const addColumn = async (boardId: string, title: string, type: string, settings?: Json) =>
  (await body(await as(admin).post(`/boards/${boardId}/columns`, { title, type, ...(settings ? { settings } : {}) })))
    .id as string;
const filterOf = (key: string, operator: string, values: unknown[]) => ({
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [{ kind: 'rule', column_id: key, operator, values, negate: false }],
});
const notificationsOf = async (cookie: string) =>
  (await body(await as(cookie).get('/me/notifications'))).data as Json[];

let deals: Json;
let clients: Json;
let rel: string;
let status: string;

beforeAll(async () => {
  t = await createTestContext();
  const ownerCookie = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(ownerCookie).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id;
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  bobId = ((await body(await as(admin).get('/users'))).data as Json[]).find(
    (u) => u.email === 'bob@acme.test',
  )!.user_id;

  deals = await newBoard('Deals');
  clients = await newBoard('Clients');
  status = await addColumn(clients.id, 'State', 'status', {
    labels: [
      { id: 1, label: 'Active', color: 'forest', index: 0 },
      { id: 2, label: 'Inactive', color: 'gray', index: 1 },
    ],
  });
  rel = await addColumn(deals.id, 'Client', 'board_relation', { board_ids: [clients.id], allow_multiple: true });
});
afterAll(() => t.close());

describe('a view a relation column offers its items by is deleted', () => {
  it("tells the column's board owners (not the one who deleted it), with a link to the column", async () => {
    // Bob owns Deals too; the admin (also an owner) deletes the view.
    expect((await as(admin).put(`/boards/${deals.id}/members/${bobId}`, { role: 'owner' })).status).toBe(200);
    const view = await body(
      await as(admin).post(`/boards/${clients.id}/views`, {
        name: 'Active clients',
        type: 'table',
        visibility: 'shared',
        settings: { query: { filter: filterOf(status, 'any_of', ['Active']) } },
      }),
    );
    const unrelated = await body(
      await as(admin).post(`/boards/${clients.id}/views`, { name: 'Unused', type: 'table', visibility: 'shared' }),
    );
    expect(
      (
        await as(admin).patch(`/boards/${deals.id}/columns/${rel}`, {
          settings: {
            board_ids: [clients.id],
            choice_filter: { [clients.id]: { mode: 'view', view_id: view.id } },
          },
        })
      ).status,
    ).toBe(200);

    expect((await as(admin).del(`/views/${unrelated.id}`)).status).toBe(200);
    expect((await notificationsOf(bob)).filter((n) => n.type === 'relation_view_missing')).toEqual([]);

    expect((await as(admin).del(`/views/${view.id}`)).status).toBe(200);
    const mine = (await notificationsOf(bob)).filter((n) => n.type === 'relation_view_missing');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      board: { id: deals.id, name: 'Deals' },
      item: null,
      column_title: 'Client',
      excerpt: 'Deals',
      relation_view: { view_name: 'Active clients', column_key: rel },
      read_at: null,
    });
    expect((await notificationsOf(admin)).filter((n) => n.type === 'relation_view_missing')).toEqual([]);

    // The existing fallback stays: every item is offered, the column says the view is gone.
    const matches = await body(await as(admin).get(`/boards/${deals.id}/columns/${rel}/relation-matches`));
    expect(matches.filters).toEqual([
      expect.objectContaining({ board_id: clients.id, source: 'view', invalid: 'view_missing' }),
    ]);
  });
});

describe('copies and templates (the linked board copied together)', () => {
  let tasks: Json;
  let self: string; // tasks → tasks, by the "Open" view
  let byGroup: string; // tasks → tasks, by a filter on the group and the state
  let toClients: string; // tasks → clients, by the "Active" view of Clients
  let open: Json;
  let activeView: Json;
  let tState: string;

  beforeAll(async () => {
    tasks = await newBoard('Tasks');
    tState = await addColumn(tasks.id, 'Stage', 'status', {
      labels: [
        { id: 1, label: 'Open', color: 'yellow', index: 0 },
        { id: 2, label: 'Closed', color: 'forest', index: 1 },
      ],
    });
    open = await body(
      await as(admin).post(`/boards/${tasks.id}/views`, {
        name: 'Open',
        type: 'table',
        visibility: 'shared',
        settings: { query: { filter: filterOf(tState, 'any_of', ['Open']) } },
      }),
    );
    activeView = await body(
      await as(admin).post(`/boards/${clients.id}/views`, {
        name: 'Active',
        type: 'table',
        visibility: 'shared',
        settings: { query: { filter: filterOf(status, 'any_of', ['Active']) } },
      }),
    );
    const group = (await getBoard(tasks.id)).groups[0].id as string;
    self = await addColumn(tasks.id, 'Blocked by', 'board_relation', {
      board_ids: [tasks.id],
      choice_filter: { [tasks.id]: { mode: 'view', view_id: open.id } },
    });
    byGroup = await addColumn(tasks.id, 'Same group', 'board_relation', {
      board_ids: [tasks.id],
      choice_filter: {
        [tasks.id]: {
          mode: 'filter',
          filter: {
            kind: 'group',
            operator: 'and',
            negate: false,
            rules: [
              { kind: 'rule', column_id: '__group__', operator: 'any_of', values: [group], negate: false },
              { kind: 'rule', column_id: tState, operator: 'any_of', values: ['Open'], negate: false },
            ],
          },
        },
      },
    });
    toClients = await addColumn(tasks.id, 'Client', 'board_relation', {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: activeView.id } },
    });
  });

  it('the picker search checks given items (`ids`): which of them the filter offers (the form editor warning)', async () => {
    const item = async (name: string, index: number) =>
      (await body(await as(admin).post(`/boards/${clients.id}/items`, { name, cells: { [status]: { index } } }))).id;
    const yes = await item('Yes Ltd', 1);
    const no = await item('No Ltd', 2);
    const res = await body(
      await as(admin).get(
        `/boards/${clients.id}/items/search?source_board_id=${tasks.id}&column_id=${toClients}&ids=${yes},${no}`,
      ),
    );
    expect(res.data.map((x: Json) => x.id)).toEqual([yes]);
    expect(res.filter).toMatchObject({ source: 'view', label: 'Active', invalid: null });
  });

  it('duplicating a board: links to itself follow to the copy, with the copied view and groups', async () => {
    const copy = await body(await as(admin).post(`/boards/${tasks.id}/duplicate`, { mode: 'structure' }));
    const board = await getBoard(copy.id);
    const views = (await body(await as(admin).get(`/boards/${copy.id}/views`))).data as Json[];
    const copiedOpen = views.find((v) => v.name === 'Open')!;
    expect(copiedOpen.id).not.toBe(open.id);
    const settingsOf = (key: string) => (board.columns as Json[]).find((c) => c.id === key)!.settings;

    expect(settingsOf(self)).toMatchObject({
      board_ids: [copy.id],
      choice_filter: { [copy.id]: { mode: 'view', view_id: copiedOpen.id } },
    });
    expect(settingsOf(self).choice_filter[tasks.id]).toBeUndefined();
    expect(settingsOf(byGroup).choice_filter[copy.id].filter.rules).toEqual([
      expect.objectContaining({ column_id: '__group__', values: [board.groups[0].id] }),
      expect.objectContaining({ column_id: tState, values: ['Open'] }),
    ]);
    // Clients was not copied: the filter stays on the original board and view.
    expect(settingsOf(toClients)).toMatchObject({
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: activeView.id } },
    });
    // The copy's filters run (no "view no longer exists").
    const matches = await body(await as(admin).get(`/boards/${copy.id}/columns/${self}/relation-matches`));
    expect(matches.filters).toEqual([
      expect.objectContaining({ board_id: copy.id, view_id: copiedOpen.id, invalid: null }),
    ]);
    // The original is untouched.
    expect((await column(tasks.id, 'Blocked by')).settings.choice_filter[tasks.id]).toEqual({
      mode: 'view',
      view_id: open.id,
    });
  });

  it('a template keeps links to the board itself (the view as its filter) and makes them on the new board', async () => {
    const tpl = await body(await as(admin).post(`/boards/${tasks.id}/save-as-template`, { name: 'Tasks tpl' }));
    const made = await body(
      await as(admin).post('/boards', { name: 'From tpl', workspace_id: wsId, template_key: tpl.key }),
    );
    const board = await getBoard(made.id);
    const settingsOf = (key: string) => (board.columns as Json[]).find((c) => c.id === key)!.settings;
    // Views are not part of a template: "by the view Open" is kept as that view's filter.
    expect(settingsOf(self).board_ids).toEqual([made.id]);
    expect(settingsOf(self).board_refs).toBeUndefined();
    expect(settingsOf(self).choice_filter).toEqual({
      [made.id]: {
        mode: 'filter',
        filter: expect.objectContaining({ rules: [expect.objectContaining({ column_id: tState, values: ['Open'] })] }),
      },
    });
    expect(settingsOf(byGroup).choice_filter[made.id].filter.rules[0]).toMatchObject({
      column_id: '__group__',
      values: [board.groups[0].id],
    });
    expect(settingsOf(toClients)).toMatchObject({
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: activeView.id } },
    });
    const matches = await body(await as(admin).get(`/boards/${made.id}/columns/${self}/relation-matches`));
    expect(matches.filters).toEqual([expect.objectContaining({ board_id: made.id, source: 'filter', invalid: null })]);
  });

  it('a pack of boards links its boards by template refs, filters included', async () => {
    const res = await as(admin).post('/extensions/packs/export', {
      key: 'relf-pack',
      name: 'Relf',
      board_ids: [tasks.id, clients.id],
      include_automations: false,
    });
    expect(res.status).toBe(200);
    const manifest = await body(res);
    const tasksTpl = (manifest.data.board_templates as Json[]).find((x) => x.name === 'Tasks')!;
    const clientsKey = (manifest.data.board_templates as Json[]).find((x) => x.name === 'Clients')!.key;
    const col = (key: string) => (tasksTpl.columns as Json[]).find((c) => c.id === key)!.settings;
    expect(col(toClients)).toMatchObject({ board_ids: [], board_refs: [`@${clientsKey}`] });
    expect(col(toClients).choice_filter).toEqual({
      [`@${clientsKey}`]: {
        mode: 'filter',
        filter: expect.objectContaining({
          rules: [expect.objectContaining({ column_id: status, values: ['Active'] })],
        }),
      },
    });
    expect(col(self)).toMatchObject({ board_ids: [], board_refs: ['@self'] });
  });
});
