// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * D22.7: a guest works in the same app — the same sidebar and screens; the server decides what they get. The
 * sidebar holds only the boards shared with them (and the folders on the way); people lists hold only the people
 * they share boards / items with.
 */
let t: TestContext;
let admin: string;
let g1: string; // a guest
let dana: string;
let acmeId: string;
const id: Record<string, string> = {};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const emails = async (cookie: string) =>
  ((await body(await as(cookie).get('/users'))).data as Json[]).map((u) => u.email as string).sort();

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
  await as(admin).post('/users/invite', {
    emails: ['bob@acme.test', 'dana@acme.test', 'eve@acme.test'],
    role: 'member',
  });
  await join('bob@acme.test');
  dana = await join('dana@acme.test');
  await join('eve@acme.test');

  id.ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  id.ws2 = (await body(await as(admin).post('/workspaces', { name: 'Internal' }))).id;
  id.portal = (await body(await as(admin).post('/folders', { workspace_id: id.ws, name: 'Portal' }))).id;
  id.secret = (await body(await as(admin).post('/folders', { workspace_id: id.ws, name: 'Secret' }))).id;
  const board = async (name: string, extra: Json) =>
    (await body(await as(admin).post('/boards', { name, workspace_id: id.ws, ...extra }))).id as string;
  id.clients = await board('Clients', { folder_id: id.secret });
  id.open = await board('Open board', { kind: 'shareable', folder_id: id.portal });
  id.limited = await board('Limited board', { kind: 'shareable' });
  id.other = await board('Other shareable', { kind: 'shareable', folder_id: id.secret });

  await as(admin).post('/users/invite', {
    emails: ['g1@client.test'],
    role: 'guest',
  });
  g1 = await join('g1@client.test');
  const users = (await body(await as(admin).get('/users'))).data as Json[];
  for (const u of users) id[u.email.split('@')[0]] = u.user_id;
  // Open board: g1 and bob subscribed, view_items all. Limited board: g1 + dana (an owner), only assigned items.
  await as(admin).put(`/boards/${id.open}/members/${id.g1}`, {});
  await as(admin).put(`/boards/${id.open}/members/${id.bob}`, {});
  await as(admin).put(`/boards/${id.limited}/members/${id.g1}`, {});
  await as(admin).put(`/boards/${id.limited}/members/${id.dana}`, { role: 'owner' });
  await as(admin).put(`/boards/${id.limited}/permissions`, { view_items: { mode: 'assigned_or_created' } });
});
afterAll(() => t.close());

describe('the sidebar', () => {
  it('shows a guest only the workspaces and folders that hold their boards', async () => {
    const ws = (await body(await as(g1).get('/workspaces'))).data as Json[];
    expect(ws.map((w) => w.id)).toEqual([id.ws]);
    const tree = await body(await as(g1).get(`/workspaces/${id.ws}/tree`));
    expect((tree.boards as Json[]).map((b) => b.name).sort()).toEqual(['Limited board', 'Open board']);
    expect((tree.folders as Json[]).map((f) => f.name)).toEqual(['Portal']);
    expect(tree.workspace.can_create).toBe(false);
    expect((await as(g1).get(`/workspaces/${id.ws2}/tree`)).status).toBe(404);
    // Staff see the whole structure as before.
    const full = await body(await as(admin).get(`/workspaces/${id.ws}/tree`));
    expect((full.folders as Json[]).map((f) => f.name).sort()).toEqual(['Portal', 'Secret']);
  });
});

describe('people a guest sees', () => {
  it('on a board where they see everything: its subscribers; on a limited board: the people on their items', async () => {
    // Nothing on the limited board yet: only the open board's people (admin = its owner) and themselves.
    expect(await emails(g1)).toEqual(['admin@acme.test', 'bob@acme.test', 'g1@client.test']);
    // Dana comments on g1's item on the limited board — now g1 sees her.
    const mine = (await body(await as(g1).post(`/boards/${id.limited}/items`, { name: 'my request' }))).id;
    expect(await emails(g1)).not.toContain('dana@acme.test');
    expect((await as(dana).post(`/items/${mine}/updates`, { body: 'on it' })).status).toBe(200);
    expect(await emails(g1)).toContain('dana@acme.test');
    // Eve is assigned to it — and appears too.
    const people = (
      await body(await as(admin).post(`/boards/${id.limited}/columns`, { title: 'Owner', type: 'people' }))
    ).id;
    expect(await emails(g1)).not.toContain('eve@acme.test');
    await as(admin).put(`/items/${mine}/cells/${people}`, {
      value: { persons_and_teams: [{ id: id.eve, kind: 'person' }] },
    });
    expect(await emails(g1)).toContain('eve@acme.test');
    // Staff still list everyone.
    expect(await emails(admin)).toHaveLength(5);
  });

  it('the permissions dialog lists only those people for a guest, and no teams', async () => {
    await as(admin).post('/teams', { name: 'Ops', member_ids: [id.dana] });
    const p = await body(await as(g1).get(`/boards/${id.open}/permissions`));
    expect((p.members as Json[]).map((m) => m.email).sort()).toEqual([
      'admin@acme.test',
      'bob@acme.test',
      'g1@client.test',
    ]);
    expect(p.teams).toEqual([]);
    expect(p.can_manage).toBe(false);
    // The people list a guest reads carries names, addresses and faces — no phone, department, title or teams
    // (audit 2026-10-10 security #17); staff still see the whole profile.
    const mine = (await body(await as(g1).get('/users'))).data as Json[];
    expect(mine.length).toBeGreaterThan(0);
    for (const m of mine) expect([m.phone, m.department, m.title, m.teams]).toEqual([null, null, null, []]);
    const dana = ((await body(await as(admin).get('/users'))).data as Json[]).find(
      (m) => m.email === 'dana@acme.test',
    )!;
    expect((dana.teams as Json[]).map((x) => x.name)).toEqual(['Ops']);
  });
});

describe('what stays closed', () => {
  it('boards not shared with them, the activity log and other staff-only data', async () => {
    expect((await as(g1).get(`/boards/${id.other}`)).status).toBe(404);
    expect((await as(g1).get(`/boards/${id.clients}`)).status).toBe(404);
    const item = (await body(await as(admin).post(`/boards/${id.open}/items`, { name: 'x' }))).id;
    expect((await as(g1).get(`/items/${item}/activity`)).status).toBe(403);
    expect((await as(g1).get(`/boards/${id.open}/activity`)).status).toBe(403);
    expect((await as(g1).get('/users/invitations')).status).toBe(403);
    expect((await as(g1).post('/boards', { name: 'x', workspace_id: id.ws })).status).toBe(403);
  });

  it('trash: a guest has none — no list, no restore (even of what they deleted before)', async () => {
    expect((await as(g1).get('/trash')).status).toBe(403);
    expect((await as(g1).post('/trash/01J9Z0000000000000000000ZZ/restore')).status).toBe(403);
  });

  it('API tokens: a guest can neither list nor create them (only their own profile)', async () => {
    expect((await as(g1).get('/auth/tokens')).status).toBe(403);
    expect((await as(g1).post('/auth/tokens', { name: 'mine', scopes: ['boards:read'] })).status).toBe(403);
  });
});

describe('inviting a guest from a board', () => {
  it('subscribes them to the board on accepting; guests only to shareable boards', async () => {
    const invite = (body: Json) => as(admin).post('/users/invite', { role: 'guest', ...body });
    // Not shareable → refused.
    expect((await invite({ emails: ['g2@client.test'], board_ids: [id.clients] })).status).toBe(422);
    const res = await invite({ emails: ['g2@client.test'], board_ids: [id.limited] });
    expect(res.status).toBe(200);
    const g2 = await join('g2@client.test');
    const tree = await body(await as(g2).get(`/workspaces/${id.ws}/tree`));
    expect((tree.boards as Json[]).map((b) => b.name)).toEqual(['Limited board']);
  });
});

describe('changing the board type', () => {
  it('a main board becomes shareable — then a guest can be invited to it; owners / admins only', async () => {
    const board = (await body(await as(admin).post('/boards', { name: 'Imported', workspace_id: id.ws }))).id;
    const parent = (await body(await as(admin).post(`/boards/${board}/items`, { name: 'Task' }))).id;
    const sub = (await body(await as(admin).post(`/items/${parent}/subitems`, { name: 'Sub task' }))).id;
    const invite = () =>
      as(admin).post('/users/invite', { emails: ['g4@client.test'], role: 'guest', board_ids: [board] });
    expect((await invite()).status).toBe(422);
    expect((await as(dana).patch(`/boards/${board}`, { kind: 'shareable' })).status).toBe(403);
    const res = await as(admin).patch(`/boards/${board}`, { kind: 'shareable' });
    expect(res.status).toBe(200);
    expect((await body(res)).kind).toBe('shareable');
    expect((await invite()).status).toBe(200);
    const g4 = await join('g4@client.test');
    expect((await as(g4).get(`/boards/${board}/items`)).status).toBe(200);
    // Its subitems come along (the sub-board has the same type).
    expect((await body(await as(g4).get(`/items/${sub}`))).name).toBe('Sub task');
    // Back to main: the guest no longer sees it.
    await as(admin).patch(`/boards/${board}`, { kind: 'main' });
    expect((await as(g4).get(`/boards/${board}/items`)).status).toBe(404);
  });
});
