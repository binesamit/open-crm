// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Owner fix6-server 3: inviting people to a board and to workspaces — a closed workspace is seen by
 * admins and its members only, so its editors add members, invite new people by email and remove members.
 */
let t: TestContext;
let admin: string;
let bob: string; // member
let carol: string; // member
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string) => t.api(cookie, acmeId);

/** Signs up with the invitation sent to `email` and accepts it. */
const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  expect((await t.api(cookie).post('/invitations/accept', { token })).status).toBe(200);
  return cookie;
};
const userId = async (email: string) =>
  ((await body(await as(admin).get('/users'))).data as Json[]).find((u) => u.email === email)!.user_id as string;
const closedWorkspace = async (name: string) => body(await as(admin).post('/workspaces', { name, kind: 'closed' }));

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
  await as(admin).post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
});
afterAll(() => t.close());

describe('workspace members (closed workspaces)', () => {
  it('the creator is a member; members are added, listed and removed — and that is who sees it', async () => {
    const w = await closedWorkspace('Finance');
    const board = await body(await as(admin).post('/boards', { name: 'Budget', workspace_id: w.id }));
    const list = await body(await as(admin).get(`/workspaces/${w.id}/members`));
    expect(list).toMatchObject({ kind: 'closed', can_manage: true });
    expect(list.members.map((m: Json) => [m.email, m.role])).toEqual([['admin@acme.test', 'owner']]);

    // Bob is not in: the workspace, its tree, its board and its members do not exist for him.
    expect((await as(bob).get(`/workspaces/${w.id}/tree`)).status).toBe(404);
    expect((await as(bob).get(`/boards/${board.id}`)).status).toBe(404);
    expect((await as(bob).get(`/workspaces/${w.id}/members`)).status).toBe(404);
    expect(((await body(await as(bob).get('/workspaces'))).data as Json[]).some((x) => x.id === w.id)).toBe(false);

    const bobId = await userId('bob@acme.test');
    const added = await as(admin).post(`/workspaces/${w.id}/members`, { user_ids: [bobId] });
    expect(added.status).toBe(200);
    expect((await body(added)).members.map((m: Json) => m.email)).toContain('bob@acme.test');
    expect((await as(bob).get(`/workspaces/${w.id}/tree`)).status).toBe(200);
    expect((await as(bob).get(`/boards/${board.id}`)).status).toBe(200);

    // A plain member manages nothing: adding / removing someone else is refused.
    const bobView = await body(await as(bob).get(`/workspaces/${w.id}/members`));
    expect(bobView.can_manage).toBe(false);
    const carolId = await userId('carol@acme.test');
    expect((await as(bob).post(`/workspaces/${w.id}/members`, { user_ids: [carolId] })).status).toBe(403);
    expect((await as(bob).del(`/workspaces/${w.id}/members/${await userId('admin@acme.test')}`)).status).toBe(403);

    expect((await as(admin).del(`/workspaces/${w.id}/members/${bobId}`)).status).toBe(200);
    expect((await as(bob).get(`/workspaces/${w.id}/tree`)).status).toBe(404);
    expect((await as(admin).del(`/workspaces/${w.id}/members/${bobId}`)).status).toBe(404);

    // Nothing to add: a validation error.
    expect((await as(admin).post(`/workspaces/${w.id}/members`, {})).status).toBe(400);
  });

  it('closing an open workspace keeps the one who closes it inside', async () => {
    const w = await body(await as(bob).post('/workspaces', { name: 'Bob open' }));
    expect((await as(carol).get(`/workspaces/${w.id}/tree`)).status).toBe(200);
    expect((await as(bob).patch(`/workspaces/${w.id}`, { kind: 'closed' })).status).toBe(200);
    expect((await as(bob).get(`/workspaces/${w.id}/tree`)).status).toBe(200);
    expect((await as(carol).get(`/workspaces/${w.id}/tree`)).status).toBe(404);
    // Admins always see closed workspaces.
    expect((await as(admin).get(`/workspaces/${w.id}/tree`)).status).toBe(200);
  });

  it('invites a new person by email: on accepting they join the account and the workspace', async () => {
    const w = await closedWorkspace('Legal');
    const res = await body(
      await as(admin).post(`/workspaces/${w.id}/members`, { emails: ['dana@acme.test', 'carol@acme.test'] }),
    );
    expect(res.invited.map((i: Json) => i.email)).toEqual(['dana@acme.test']);
    // Carol is already in the account: she is added at once.
    expect(res.members.map((m: Json) => m.email).sort()).toEqual(['admin@acme.test', 'carol@acme.test']);
    const dana = await join('dana@acme.test');
    expect((await as(dana).get(`/workspaces/${w.id}/tree`)).status).toBe(200);
    expect((await body(await as(admin).get(`/workspaces/${w.id}/members`))).members).toHaveLength(3);
  });

  it('is account-scoped', async () => {
    const w = await closedWorkspace('Scoped');
    const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
    const beta = (
      await body(
        await t.api(owner).post('/platform/accounts', {
          name: 'Beta',
          slug: 'beta-ws',
          first_admin_email: 'admin@beta.test',
          template_set: 'empty',
        }),
      )
    ).account.id as string;
    const betaAdmin = await join('admin@beta.test');
    expect((await t.api(betaAdmin, beta).get(`/workspaces/${w.id}/members`)).status).toBe(404);
    expect((await t.api(betaAdmin, beta).post(`/workspaces/${w.id}/members`, { emails: ['x@beta.test'] })).status).toBe(
      404,
    );
  });
});

describe('board invite (POST /boards/{id}/invite)', () => {
  it('subscribes account members at once and invites new people; a closed workspace takes them in too', async () => {
    const w = await closedWorkspace('Sales');
    const board = await body(await as(admin).post('/boards', { name: 'Deals', workspace_id: w.id }));
    const res = await as(admin).post(`/boards/${board.id}/invite`, { emails: ['bob@acme.test', 'erez@acme.test'] });
    expect(res.status).toBe(200);
    const out = await body(res);
    expect(out.added.map((x: Json) => x.email)).toEqual(['bob@acme.test']);
    expect(out.invited.map((x: Json) => x.email)).toEqual(['erez@acme.test']);
    expect(out.permissions.members.map((m: Json) => m.email)).toContain('bob@acme.test');
    // Bob sees the board (and so the closed workspace) right away.
    expect((await as(bob).get(`/boards/${board.id}`)).status).toBe(200);
    expect((await as(bob).get(`/workspaces/${w.id}/tree`)).status).toBe(200);

    const erez = await join('erez@acme.test');
    expect((await as(erez).get(`/boards/${board.id}`)).status).toBe(200);
    const members = (await body(await as(admin).get(`/workspaces/${w.id}/members`))).members as Json[];
    expect(members.map((m) => m.email).sort()).toEqual(['admin@acme.test', 'bob@acme.test', 'erez@acme.test']);
  });

  it('subscribing a member from the dialog (PUT members) adds them to the closed workspace too', async () => {
    const w = await closedWorkspace('Ops');
    const board = await body(await as(admin).post('/boards', { name: 'Ops board', workspace_id: w.id }));
    const carolId = await userId('carol@acme.test');
    expect((await as(carol).get(`/boards/${board.id}`)).status).toBe(404);
    expect(
      (await as(admin).put(`/boards/${board.id}/members/${carolId}`, { role: 'subscriber', level: null })).status,
    ).toBe(200);
    expect((await as(carol).get(`/boards/${board.id}`)).status).toBe(200);
  });

  it('guests only on shareable boards; people who may not see the board cannot invite to it', async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
    const main = await body(await as(admin).post('/boards', { name: 'Main', workspace_id: ws }));
    expect((await as(admin).post(`/boards/${main.id}/invite`, { emails: ['g@out.test'], role: 'guest' })).status).toBe(
      422,
    );
    const shared = await body(await as(admin).post('/boards', { name: 'Shared', workspace_id: ws, kind: 'shareable' }));
    const g = await body(
      await as(admin).post(`/boards/${shared.id}/invite`, { emails: ['g@out.test'], role: 'guest' }),
    );
    expect(g.invited.map((x: Json) => x.email)).toEqual(['g@out.test']);
    const guest = await join('g@out.test');
    expect((await as(guest).get(`/boards/${shared.id}`)).status).toBe(200);

    const priv = await closedWorkspace('Private');
    const hidden = await body(await as(admin).post('/boards', { name: 'Hidden', workspace_id: priv.id }));
    expect((await as(carol).post(`/boards/${hidden.id}/invite`, { emails: ['z@acme.test'] })).status).toBe(404);
  });
});
