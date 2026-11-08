// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accountMembers } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** 05 §4–7: teams, the permissions dialog, item visibility (404 for hidden items), owner-only columns. */
let t: TestContext;
let admin: string;
let bob: string; // member
let dana: string; // member, in team Sales
let carol: string; // viewer
let acmeId: string;
let ids: Record<'admin' | 'bob' | 'dana' | 'carol', string>;
let boardId: string;
let peopleKey: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const names = async (cookie: string, board = boardId) =>
  ((await body(await as(cookie).get(`/boards/${board}/items`))).data as Json[]).map((i) => i.name).sort();
const assign = (who: { kind: 'person' | 'team'; id: string }) => ({ [peopleKey]: { persons_and_teams: [who] } });

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
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test', 'dana@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  dana = await join('dana@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => users.find((u) => u.email === email)!.user_id as string;
  ids = {
    admin: idOf('admin@acme.test'),
    bob: idOf('bob@acme.test'),
    dana: idOf('dana@acme.test'),
    carol: idOf('carol@acme.test'),
  };
  const ws = (await body(await as(admin).get('/workspaces'))).data[0];
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: ws.id }))).id;
  peopleKey = (await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Owner', type: 'people' }))).id;
});
afterAll(() => t.close());

let sales: Json;

describe('teams', () => {
  it('admins create and edit teams; everyone (not guests) reads them', async () => {
    expect((await as(bob).post('/teams', { name: 'Sales' })).status).toBe(403);
    const res = await as(admin).post('/teams', { name: 'Sales', member_ids: [ids.dana] });
    expect(res.status).toBe(201);
    sales = await body(res);
    expect(sales).toMatchObject({ name: 'Sales', member_ids: [ids.dana] });
    expect((await as(admin).post('/teams', { name: 'sales' })).status).toBe(409);
    const list = (await body(await as(carol).get('/teams'))).data as Json[];
    expect(list.map((x) => x.name)).toEqual(['Sales']);
    const tmp = await body(await as(admin).post('/teams', { name: 'Temp' }));
    expect((await body(await as(admin).patch(`/teams/${tmp.id}`, { member_ids: [ids.bob] }))).member_ids).toEqual([
      ids.bob,
    ]);
    await as(admin).del(`/teams/${tmp.id}`);
    expect(((await body(await as(admin).get('/teams'))).data as Json[]).map((x) => x.name)).toEqual(['Sales']);
  });
});

describe('item visibility (view_items: assigned_or_created)', () => {
  let x: Json, z: Json;

  it('only owners/admins change permissions; the dialog shows members and can_manage', async () => {
    expect(
      (await as(bob).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'assigned_or_created' } })).status,
    ).toBe(403);
    const p = await body(await as(admin).get(`/boards/${boardId}/permissions`));
    expect(p).toMatchObject({ permission_set: 'edit_everything', view_items: { mode: 'all' }, can_manage: true });
    expect(p.members.map((m: Json) => [m.email, m.role])).toEqual([['admin@acme.test', 'owner']]);
    expect((await body(await as(bob).get(`/boards/${boardId}/permissions`))).can_manage).toBe(false);
  });

  it('members see what they created or are assigned to (directly or by team); the rest is 404', async () => {
    x = await body(
      await as(admin).post(`/boards/${boardId}/items`, {
        name: 'X bob',
        cells: assign({ kind: 'person', id: ids.bob }),
      }),
    );
    await body(
      await as(admin).post(`/boards/${boardId}/items`, {
        name: 'Y sales',
        cells: assign({ kind: 'team', id: sales.id }),
      }),
    );
    z = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Z nobody' }));
    await body(await as(bob).post(`/boards/${boardId}/items`, { name: 'W by bob' }));
    expect(await names(bob)).toEqual(['W by bob', 'X bob', 'Y sales', 'Z nobody']); // still "all"

    const res = await as(admin).put(`/boards/${boardId}/permissions`, {
      view_items: { mode: 'assigned_or_created', column_ids: 'any_people' },
    });
    expect((await body(res)).view_items.mode).toBe('assigned_or_created');
    expect(await names(bob)).toEqual(['W by bob', 'X bob']);
    expect(await names(dana)).toEqual(['Y sales']);
    expect(await names(carol)).toEqual([]);
    expect(await names(admin)).toEqual(['W by bob', 'X bob', 'Y sales', 'Z nobody']);

    expect((await as(bob).get(`/items/${z.id}`)).status).toBe(404);
    expect((await as(bob).patch(`/items/${z.id}`, { name: 'hack' })).status).toBe(404);
    expect((await as(bob).get(`/items/${z.id}/updates`)).status).toBe(404);
    expect((await as(bob).get(`/items/${x.id}`)).status).toBe(200);
  });

  it('queries, counts, search and bulk respect it too', async () => {
    const q = await body(await as(bob).post(`/boards/${boardId}/items/query`, { query: {} }));
    expect((q.data as Json[]).map((i) => i.name).sort()).toEqual(['W by bob', 'X bob']);
    expect(q.total).toBe(2);
    const found = (await body(await as(bob).get(`/boards/${boardId}/items/search?q=`))).data as Json[];
    expect(found.map((i) => i.name).sort()).toEqual(['W by bob', 'X bob']);
    const bulk = await body(
      await as(bob).post(`/boards/${boardId}/items/bulk`, { item_ids: [x.id, z.id], action: { type: 'archive' } }),
    );
    expect(bulk).toMatchObject({ done: 1, skipped: 1 });
    await as(bob).post(`/activity/${bulk.event_id}/undo`, {});
  });

  it('a subitem is visible when it or its item is', async () => {
    await as(admin).post(`/items/${z.id}/subitems`, { name: 'Z.1' });
    await as(admin).post(`/items/${x.id}/subitems`, { name: 'X.1' });
    const sub = (await body(await as(admin).get(`/boards/${boardId}`))).subitems_board_id;
    expect(await names(bob, sub)).toEqual(['X.1']);
    expect(await names(admin, sub)).toEqual(['X.1', 'Z.1']);
  });

  it('owners see everything; a board keeps an owner', async () => {
    expect((await as(bob).put(`/boards/${boardId}/members/${ids.bob}`, { role: 'owner' })).status).toBe(403);
    await as(admin).put(`/boards/${boardId}/members/${ids.bob}`, { role: 'owner' });
    expect(await names(bob)).toEqual(['W by bob', 'X bob', 'Y sales', 'Z nobody']);
    await as(admin).del(`/boards/${boardId}/members/${ids.admin}`);
    expect((await as(bob).del(`/boards/${boardId}/members/${ids.bob}`)).status).toBe(409); // last owner
    await as(bob).put(`/boards/${boardId}/members/${ids.admin}`, { role: 'owner' });
    await as(admin).put(`/boards/${boardId}/members/${ids.bob}`, { role: 'subscriber' });
    expect(await names(bob)).toEqual(['W by bob', 'X bob']);
  });
});

describe('owner-only columns', () => {
  it('view: others do not get the column; edit: others cannot write it', async () => {
    await as(admin).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'all' } });
    const num = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Price', type: 'numbers' }));
    const item = await body(await as(bob).post(`/boards/${boardId}/items`, { name: 'Priced' }));

    await as(admin).put(`/boards/${boardId}/columns/${num.id}/restriction`, { kind: 'edit' });
    expect((await as(bob).put(`/items/${item.id}/cells/${num.id}`, { value: 5 })).status).toBe(403);
    expect((await as(admin).put(`/items/${item.id}/cells/${num.id}`, { value: 5 })).status).toBe(200);

    await as(admin).put(`/boards/${boardId}/columns/${num.id}/restriction`, { kind: 'view' });
    const cols = (await body(await as(bob).get(`/boards/${boardId}`))).columns.map((c: Json) => c.id);
    expect(cols).not.toContain(num.id);
    expect((await body(await as(bob).get(`/items/${item.id}`))).cells[num.id]).toBeUndefined();
    const p = await body(await as(admin).get(`/boards/${boardId}/permissions`));
    expect(p.column_restrictions).toEqual([{ column_id: num.id, kind: 'view', users: [], teams: [] }]);
    await as(admin).put(`/boards/${boardId}/columns/${num.id}/restriction`, { kind: null });
    expect((await body(await as(bob).get(`/items/${item.id}`))).cells[num.id].value).toEqual(5);
  });

  it('a new item created with cells (a grouped section) writes them; a restricted cell refuses it all', async () => {
    await as(admin).put(`/boards/${boardId}/permissions`, { view_items: { mode: 'all' } });
    const stage = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Stage', type: 'status' }));
    const created = await body(
      await as(bob).post(`/boards/${boardId}/items`, { name: 'Seeded', cells: { [stage.id]: { index: 1 } } }),
    );
    expect(created.cells[stage.id].value).toEqual({ index: 1 });

    await as(admin).put(`/boards/${boardId}/columns/${stage.id}/restriction`, { kind: 'edit' });
    const res = await as(bob).post(`/boards/${boardId}/items`, {
      name: 'Refused',
      cells: { [stage.id]: { index: 1 } },
    });
    expect(res.status).toBe(403);
    expect(await names(bob)).not.toContain('Refused'); // one transaction: no item without its value
    expect((await as(bob).post(`/boards/${boardId}/items`, { name: 'Plain' })).status).toBe(201);
    const own = await as(admin).post(`/boards/${boardId}/items`, {
      name: 'Owner',
      cells: { [stage.id]: { index: 1 } },
    });
    expect(own.status).toBe(201);
    await as(admin).put(`/boards/${boardId}/columns/${stage.id}/restriction`, { kind: null });
  });
});

describe('explicit roles and team subscriptions (05 §4)', () => {
  it('an explicit role only lowers what the set gives, and only owners/admins set it', async () => {
    await as(admin).put(`/boards/${boardId}/permissions`, { permission_set: 'edit_everything' });
    expect((await as(bob).post(`/boards/${boardId}/items`, { name: 'Before' })).status).toBe(201);
    expect((await as(bob).put(`/boards/${boardId}/members/${ids.bob}`, { level: 'editor' })).status).toBe(403);
    const p = await body(await as(admin).put(`/boards/${boardId}/members/${ids.bob}`, { level: 'viewer' }));
    expect(p.members.find((m: Json) => m.user_id === ids.bob)).toMatchObject({ role: 'subscriber', level: 'viewer' });
    expect((await as(bob).post(`/boards/${boardId}/items`, { name: 'After' })).status).toBe(403);
    expect((await body(await as(bob).get(`/boards/${boardId}`))).capabilities['item.create']).toBe(false);

    // Never above the set: "editor" on a view-and-comment board stays read-only.
    await as(admin).put(`/boards/${boardId}/members/${ids.bob}`, { level: 'editor' });
    await as(admin).put(`/boards/${boardId}/permissions`, { permission_set: 'view_comment' });
    expect((await as(bob).post(`/boards/${boardId}/items`, { name: 'Capped' })).status).toBe(403);
    await as(admin).put(`/boards/${boardId}/permissions`, { permission_set: 'edit_everything' });
    await as(admin).put(`/boards/${boardId}/members/${ids.bob}`, { level: null });
    expect((await as(bob).post(`/boards/${boardId}/items`, { name: 'Again' })).status).toBe(201);
  });

  it('a team subscription reaches every member; a personal one decides the role', async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0];
    const priv = (
      await body(await as(admin).post('/boards', { name: 'Team room', workspace_id: ws.id, kind: 'private' }))
    ).id as string;
    expect((await as(dana).get(`/boards/${priv}`)).status).toBe(404);
    expect((await as(bob).put(`/boards/${priv}/teams/${sales.id}`, {})).status).toBe(404); // bob cannot see it

    const p = await body(await as(admin).put(`/boards/${priv}/teams/${sales.id}`, {}));
    expect(p.teams).toEqual([{ team_id: sales.id, name: 'Sales', role: 'subscriber', level: null }]);
    expect((await as(dana).post(`/boards/${priv}/items`, { name: 'By dana' })).status).toBe(201);
    const tree = (await body(await as(dana).get(`/workspaces/${ws.id}/tree`))) as Json;
    expect(JSON.stringify(tree)).toContain('Team room');

    await as(admin).put(`/boards/${priv}/teams/${sales.id}`, { level: 'viewer' });
    expect((await as(dana).post(`/boards/${priv}/items`, { name: 'No' })).status).toBe(403);
    // Her own subscription decides over the team's.
    await as(admin).put(`/boards/${priv}/members/${ids.dana}`, {});
    expect((await as(dana).post(`/boards/${priv}/items`, { name: 'Own' })).status).toBe(201);
    await as(admin).del(`/boards/${priv}/members/${ids.dana}`);

    // A team can own the board — then it counts as the owner a board must keep.
    await as(admin).put(`/boards/${priv}/teams/${sales.id}`, { role: 'owner' });
    expect((await as(dana).patch(`/boards/${priv}`, { name: 'Team room 2' })).status).toBe(200);
    expect((await as(admin).del(`/boards/${priv}/members/${ids.admin}`)).status).toBe(200);
    expect((await as(admin).del(`/boards/${priv}/teams/${sales.id}`)).status).toBe(409); // last owner
    await as(admin).put(`/boards/${priv}/members/${ids.admin}`, { role: 'owner' });
    expect((await as(admin).del(`/boards/${priv}/teams/${sales.id}`)).status).toBe(200);
    expect((await as(dana).get(`/boards/${priv}`)).status).toBe(404);
  });
});

describe('column restrictions for listed people and teams (05 §6.1)', () => {
  it('edit: owners plus the listed people and team members write it; view: only they get it', async () => {
    await as(admin).put(`/boards/${boardId}/permissions`, {
      permission_set: 'edit_everything',
      view_items: { mode: 'all' },
    });
    const num = await body(await as(admin).post(`/boards/${boardId}/columns`, { title: 'Budget', type: 'numbers' }));
    const item = await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'Budgeted' }));
    const cell = (who: string, value: number) => as(who).put(`/items/${item.id}/cells/${num.id}`, { value });

    expect(
      (
        await as(admin).put(`/boards/${boardId}/columns/${num.id}/restriction`, {
          kind: 'edit',
          users: ['nobody'],
        })
      ).status,
    ).toBe(422);
    const p = await body(
      await as(admin).put(`/boards/${boardId}/columns/${num.id}/restriction`, {
        kind: 'edit',
        users: [ids.bob],
        teams: [sales.id],
      }),
    );
    expect(p.column_restrictions.find((r: Json) => r.column_id === num.id)).toEqual({
      column_id: num.id,
      kind: 'edit',
      users: [ids.bob],
      teams: [sales.id],
    });
    expect((await cell(bob, 1)).status).toBe(200);
    expect((await cell(dana, 2)).status).toBe(200); // through team Sales
    await as(admin).put(`/boards/${boardId}/columns/${num.id}/restriction`, { kind: 'edit', users: [ids.bob] });
    expect((await cell(dana, 3)).status).toBe(403);
    const col = (who: string) =>
      (async () => (await body(await as(who).get(`/boards/${boardId}`))).columns.find((c: Json) => c.id === num.id))();
    expect((await col(dana)).restricted_edit).toBe(true);
    expect((await col(bob)).restricted_edit).toBe(false);

    await as(admin).put(`/boards/${boardId}/columns/${num.id}/restriction`, { kind: 'view', teams: [sales.id] });
    expect(await col(bob)).toBeUndefined();
    expect(await col(dana)).toBeDefined();
    expect((await body(await as(dana).get(`/items/${item.id}`))).cells[num.id].value).toBe(2);
    expect((await body(await as(bob).get(`/items/${item.id}`))).cells[num.id]).toBeUndefined();
    await as(admin).put(`/boards/${boardId}/columns/${num.id}/restriction`, { kind: null });
  });

  it('edit_assigned: an item assigned to my team is mine to edit', async () => {
    await as(admin).put(`/boards/${boardId}/permissions`, { permission_set: 'edit_assigned' });
    const theirs = await body(
      await as(admin).post(`/boards/${boardId}/items`, {
        name: 'For sales',
        cells: assign({ kind: 'team', id: sales.id }),
      }),
    );
    expect((await as(dana).patch(`/items/${theirs.id}`, { name: 'Sales took it' })).status).toBe(200);
    expect((await as(bob).patch(`/items/${theirs.id}`, { name: 'Not bob' })).status).toBe(403);
    await as(admin).put(`/boards/${boardId}/permissions`, { permission_set: 'edit_everything' });
  });
});

describe('an admin claims a board no owner can act on (05 §4)', () => {
  it('only without an active owner, only admins', async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0];
    const priv = (await body(await as(bob).post('/boards', { name: 'Bob only', workspace_id: ws.id, kind: 'private' })))
      .id as string;
    expect((await body(await as(admin).get(`/boards/${priv}/permissions`))).has_active_owner).toBe(true);
    expect((await as(admin).post(`/boards/${priv}/claim`, {})).status).toBe(409);

    const setStatus = (status: 'active' | 'deactivated') =>
      t.db
        .update(accountMembers)
        .set({ status })
        .where(and(eq(accountMembers.accountId, acmeId), eq(accountMembers.userId, ids.bob)));
    await setStatus('deactivated');
    try {
      expect((await body(await as(admin).get(`/boards/${priv}/permissions`))).has_active_owner).toBe(false);
      expect((await as(admin).get(`/boards/${priv}/items`)).status).toBe(404); // not subscribed yet
      expect((await as(dana).post(`/boards/${priv}/claim`, {})).status).toBe(404); // cannot even see it
      const p = await body(await as(admin).post(`/boards/${priv}/claim`, {}));
      expect(p.has_active_owner).toBe(true);
      expect(p.members.find((m: Json) => m.user_id === ids.admin)).toMatchObject({ role: 'owner' });
      expect((await as(admin).get(`/boards/${priv}/items`)).status).toBe(200);
    } finally {
      await setStatus('active');
    }
  });
});
