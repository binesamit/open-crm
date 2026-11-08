// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditLog } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Product decision — "like shared boards and guests, the same for dashboards and documents": a dashboard is
 * main / private / shareable with owner / editor / viewer members; guests are invited to a shareable dashboard
 * (directly or by email, through the account invitation), see exactly it — in the sidebar, search, favourites and
 * the bell — and its widgets show only boards shared with them, with no trace of the others. Docs: "shared with
 * you" notifications and audit for guests. Sharing with a guest is audited.
 */
let t: TestContext;
let admin: string;
let bob: string; // member
let gus: string; // guest, subscribed to board S
let acmeId: string;
let wsId: string;
let ids: Record<'admin' | 'bob' | 'gus', string>;
let S: string; // shareable board, gus subscribed
let P: string; // private board
let M: string; // main board
let dash: Json;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
  return cookie;
};
const auditRows = (action: string) =>
  t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, action)));
const amount = { type: 'numbers', title: 'Amount' };

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  await as(admin).post('/users/invite', { emails: ['gus@guest.test'], role: 'guest' });
  bob = await join('bob@acme.test');
  gus = await join('gus@guest.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => users.find((u) => u.email === email)!.user_id as string;
  ids = { admin: idOf('admin@acme.test'), bob: idOf('bob@acme.test'), gus: idOf('gus@guest.test') };
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;

  const board = async (name: string, kind: string, amounts: number[]) => {
    const id = (await body(await as(admin).post('/boards', { name, workspace_id: wsId, kind }))).id as string;
    expect((await as(admin).post(`/boards/${id}/columns`, { id: 'amount', ...amount })).status).toBe(201);
    for (const [i, n] of amounts.entries())
      expect((await as(admin).post(`/boards/${id}/items`, { name: `${name} ${i}`, cells: { amount: n } })).status).toBe(
        201,
      );
    return id;
  };
  S = await board('Shared board', 'shareable', [10, 20]);
  P = await board('Private board', 'private', [1000]);
  M = await board('Main board', 'main', [300]);
  expect((await as(admin).post(`/boards/${S}/invite`, { emails: ['gus@guest.test'], role: 'guest' })).status).toBe(200);
});
afterAll(() => t.close());

describe('dashboards are shared like boards', () => {
  it('a shareable dashboard takes guests (never as owners); private / main ones do not', async () => {
    const res = await as(admin).post(`/workspaces/${wsId}/dashboards`, {
      name: 'Client view',
      kind: 'shareable',
      board_ids: [S, P, M],
    });
    expect(res.status).toBe(201);
    dash = await body(res);
    // `kind` is the real kind; `sharing` is its deprecated alias (one release).
    expect(dash).toMatchObject({ kind: 'shareable', sharing: 'shareable' });
    expect(await body(await as(admin).get(`/dashboards/${dash.id}`))).toMatchObject({ kind: 'shareable' });
    expect((await as(gus).get(`/dashboards/${dash.id}`)).status).toBe(404); // not invited yet

    const put = (members: Json[]) => as(admin).put(`/dashboards/${dash.id}/members`, { members });
    const owner = { type: 'user', id: ids.admin, level: 'owner' };
    expect((await put([owner, { type: 'user', id: ids.gus, level: 'owner' }])).status).toBe(400); // guest_cannot_own
    expect((await put([owner, { type: 'user', id: ids.gus, level: 'viewer' }])).status).toBe(200);

    const priv = await body(
      await as(admin).post(`/workspaces/${wsId}/dashboards`, { name: 'Inside', kind: 'private' }),
    );
    expect(
      (
        await as(admin).put(`/dashboards/${priv.id}/members`, {
          members: [owner, { type: 'user', id: ids.gus, level: 'viewer' }],
        })
      ).status,
    ).toBe(400);
    const inv = await as(admin).post(`/dashboards/${priv.id}/invite`, { emails: ['gus@guest.test'], role: 'guest' });
    expect(inv.status).toBe(422);
  });

  it('the guest sees the dashboard — and only the boards shared with them, without a trace of the others', async () => {
    const mine = await body(await as(gus).get(`/dashboards/${dash.id}`));
    expect(mine.capabilities).toEqual({ 'dashboard.read': true, 'dashboard.edit': false, 'dashboard.manage': false });
    expect(mine.boards.map((b: Json) => b.id)).toEqual([S]);
    expect(mine.hidden_boards).toBe(0);
    expect(mine.settings.board_ids).toEqual([S]);
    expect(JSON.stringify(mine)).not.toContain(P);
    expect(JSON.stringify(mine)).not.toContain(M);

    // A widget over every source: the guest gets the shared board's numbers only.
    const w = await body(
      await as(admin).post(`/dashboards/${dash.id}/widgets`, {
        type: 'numbers',
        settings: {
          measure: { fn: 'sum', column: { ...amount, keys: { [P]: 'amount', [M]: 'amount', [S]: 'amount' } } },
        },
      }),
    );
    const forAdmin = await body(await as(admin).post(`/dashboards/${dash.id}/widgets/${w.id}/data`, {}));
    expect(forAdmin.data.value).toBe(10 + 20 + 1000 + 300);
    const forGus = await body(await as(gus).post(`/dashboards/${dash.id}/widgets/${w.id}/data`, {}));
    expect(forGus.data.value).toBe(30);
    expect(forGus.boards.map((b: Json) => b.id)).toEqual([S]);
    expect(forGus.hidden_boards).toBe(0);
    expect(JSON.stringify(forGus)).not.toContain(P);
    // The widget's settings as the guest reads them name no hidden board either.
    const again = await body(await as(gus).get(`/dashboards/${dash.id}`));
    const widget = again.widgets.find((x: Json) => x.id === w.id);
    expect(Object.keys(widget.settings.measure.column.keys)).toEqual([S]);
    // Columns of the sources: only the shared board.
    const cols = await body(await as(gus).get(`/dashboards/${dash.id}/columns`));
    expect(cols.boards.map((b: Json) => b.id)).toEqual([S]);

    // Members by name only (no emails) for a guest.
    const members = (await body(await as(gus).get(`/dashboards/${dash.id}/members`))).data as Json[];
    expect(members.every((m) => m.email === null)).toBe(true);
    // A viewer guest cannot change anything; a guest never invites.
    expect((await as(gus).post(`/dashboards/${dash.id}/widgets`, { type: 'text' })).status).toBe(403);
    expect((await as(gus).post(`/dashboards/${dash.id}/invite`, { emails: ['x@guest.test'] })).status).toBe(403);
  });

  it('a guest editor edits — and their save never drops the boards they cannot see', async () => {
    expect(
      (
        await as(admin).put(`/dashboards/${dash.id}/members`, {
          members: [
            { type: 'user', id: ids.admin, level: 'owner' },
            { type: 'user', id: ids.gus, level: 'editor' },
          ],
        })
      ).status,
    ).toBe(200);
    const mine = await body(await as(gus).get(`/dashboards/${dash.id}`));
    expect(mine.capabilities).toEqual({ 'dashboard.read': true, 'dashboard.edit': true, 'dashboard.manage': false });
    // The guest saves the sources as they see them (S only): P and M stay on the dashboard.
    const saved = await as(gus).patch(`/dashboards/${dash.id}`, {
      settings: { board_ids: [S] },
      name: 'Client view 2',
    });
    expect(saved.status).toBe(200);
    const full = await body(await as(admin).get(`/dashboards/${dash.id}`));
    expect(full.name).toBe('Client view 2');
    expect(full.settings.board_ids.sort()).toEqual([S, P, M].sort());
    // A widget edited by the guest keeps its hidden column choices.
    const w = full.widgets.find((x: Json) => x.type === 'numbers');
    const asGuest = (await body(await as(gus).get(`/dashboards/${dash.id}`))).widgets.find((x: Json) => x.id === w.id);
    expect(
      (await as(gus).patch(`/dashboard-widgets/${w.id}`, { title: 'Total', settings: asGuest.settings })).status,
    ).toBe(200);
    const after = (await body(await as(admin).get(`/dashboards/${dash.id}`))).widgets.find((x: Json) => x.id === w.id);
    expect(Object.keys(after.settings.measure.column.keys).sort()).toEqual([S, P, M].sort());
    // Editors do not manage: no kind change, no sharing, no delete.
    expect((await as(gus).patch(`/dashboards/${dash.id}`, { kind: 'main' })).status).toBe(403);
    expect((await as(gus).del(`/dashboards/${dash.id}`)).status).toBe(403);
    // A member editor (not a guest) too.
    expect(
      (
        await as(admin).put(`/dashboards/${dash.id}/members`, {
          members: [
            { type: 'user', id: ids.admin, level: 'owner' },
            { type: 'user', id: ids.gus, level: 'editor' },
            { type: 'user', id: ids.bob, level: 'editor' },
          ],
        })
      ).status,
    ).toBe(200);
    expect((await as(bob).post(`/dashboards/${dash.id}/widgets`, { type: 'text' })).status).toBe(201);
    expect((await as(bob).put(`/dashboards/${dash.id}/members`, { members: [] })).status).toBe(403);
  });

  it('the guest finds it in the sidebar, search, favourites and the bell', async () => {
    const workspaces = (await body(await as(gus).get('/workspaces'))).data as Json[];
    expect(workspaces.map((w) => w.id)).toContain(wsId);
    const tree = await body(await as(gus).get(`/workspaces/${wsId}/tree`));
    expect(tree.entities.map((e: Json) => e.id)).toEqual([dash.id]);
    expect(tree.entities[0]).toMatchObject({ type: 'dashboard', kind: 'shareable', can_update: false });
    expect(tree.boards.map((b: Json) => b.id)).toEqual([S]);

    const found = await body(await as(gus).get('/search?q=Client'));
    expect(found.dashboards.map((d: Json) => d.id)).toEqual([dash.id]);
    const notFound = await body(await as(gus).get('/search?q=Inside'));
    expect(notFound.dashboards).toEqual([]);

    expect((await as(gus).put('/me/favorites', { items: [{ type: 'dashboard', id: dash.id }] })).status).toBe(200);
    expect((await body(await as(gus).get('/me/favorites'))).data.map((f: Json) => f.id)).toEqual([dash.id]);

    const bell = (await body(await as(gus).get('/me/notifications'))).data as Json[];
    const shared = bell.find((n) => n.type === 'dashboard_shared');
    expect(shared).toMatchObject({ dashboard: { id: dash.id }, actor: { id: ids.admin } });
    // Bob was added as an editor later: he heard about it too.
    const bobs = (await body(await as(bob).get('/me/notifications'))).data as Json[];
    expect(bobs.some((n) => n.type === 'dashboard_shared' && n.dashboard?.id === dash.id)).toBe(true);
  });

  it('turning it private takes it away from the guest everywhere (and audits it)', async () => {
    expect((await as(admin).patch(`/dashboards/${dash.id}`, { kind: 'private' })).status).toBe(200);
    expect((await as(gus).get(`/dashboards/${dash.id}`)).status).toBe(404);
    const tree = await body(await as(gus).get(`/workspaces/${wsId}/tree`));
    expect(tree.entities).toEqual([]);
    const bell = (await body(await as(gus).get('/me/notifications'))).data as Json[];
    expect(bell.some((n) => n.type === 'dashboard_shared')).toBe(false);
    expect((await auditRows('share.kind_changed')).map((r) => (r.payload as Json).to)).toContain('private');
    expect((await as(admin).patch(`/dashboards/${dash.id}`, { kind: 'shareable' })).status).toBe(200);
    expect((await as(gus).get(`/dashboards/${dash.id}`)).status).toBe(200);
  });

  it('inviting by email: a new guest joins the account and the dashboard (never as owner); audited', async () => {
    const res = await as(admin).post(`/dashboards/${dash.id}/invite`, {
      emails: ['newbie@guest.test', 'bob@acme.test'],
      role: 'guest',
      level: 'owner',
    });
    expect(res.status).toBe(200);
    const r = await body(res);
    expect(r.invited.map((x: Json) => x.email)).toEqual(['newbie@guest.test']);
    expect(r.errors).toEqual([{ email: 'bob@acme.test', code: 'already_member' }]);
    const newbie = await join('newbie@guest.test');
    const d = await body(await as(newbie).get(`/dashboards/${dash.id}`));
    expect(d.capabilities['dashboard.edit']).toBe(true);
    expect(d.capabilities['dashboard.manage']).toBe(false);
    // newbie is subscribed to no board: the widgets show nothing, the sources are not named.
    expect(d.boards).toEqual([]);
    expect(d.settings.board_ids).toEqual([]);
    const level = ((await body(await as(admin).get(`/dashboards/${dash.id}/members`))).data as Json[]).find(
      (m) => m.email === 'newbie@guest.test',
    )?.level;
    expect(level).toBe('editor');

    const added = await auditRows('share.guest_added');
    expect(added.some((a) => (a.payload as Json).via === 'invitation' && a.targetId === dash.id)).toBe(true);
    expect(added.some((a) => (a.payload as Json).user_id === ids.gus && a.targetType === 'dashboard')).toBe(true);

    // Removing the guest is audited too.
    expect(
      (
        await as(admin).put(`/dashboards/${dash.id}/members`, {
          members: [{ type: 'user', id: ids.admin, level: 'owner' }],
        })
      ).status,
    ).toBe(200);
    const removed = await auditRows('share.guest_removed');
    expect(removed.map((a) => (a.payload as Json).user_id)).toEqual(expect.arrayContaining([ids.gus]));
    expect((await as(gus).get(`/dashboards/${dash.id}`)).status).toBe(404);
  });
});

describe('docs: shared with you, audited', () => {
  it('adding someone to a doc notifies them; a guest is audited and sees it in search', async () => {
    const doc = await body(
      await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Proposal for client', kind: 'shareable' }),
    );
    const res = await as(admin).put(`/docs/${doc.id}/members`, {
      members: [
        { type: 'user', id: ids.admin, level: 'owner' },
        { type: 'user', id: ids.gus, level: 'viewer' },
      ],
    });
    expect(res.status).toBe(200);
    const bell = (await body(await as(gus).get('/me/notifications'))).data as Json[];
    expect(bell.find((n) => n.type === 'doc_shared')).toMatchObject({ doc: { id: doc.id } });
    expect((await auditRows('share.guest_added')).some((a) => a.targetId === doc.id)).toBe(true);
    const found = await body(await as(gus).get('/search?q=Proposal'));
    expect(found.docs.map((d: Json) => d.id)).toEqual([doc.id]);
    // A viewer guest only reads.
    const d = await body(await as(gus).get(`/docs/${doc.id}`));
    expect(d.capabilities['doc.edit']).toBe(false);

    // Invite by email: bob (already in the account) joins at once and hears about it.
    const inv = await body(
      await as(admin).post(`/docs/${doc.id}/invite`, { emails: ['bob@acme.test'], role: 'member', level: 'editor' }),
    );
    expect(inv.added.map((x: Json) => x.user_id)).toEqual([ids.bob]);
    const bobs = (await body(await as(bob).get('/me/notifications'))).data as Json[];
    expect(bobs.some((n) => n.type === 'doc_shared' && n.doc?.id === doc.id)).toBe(true);
  });
});
