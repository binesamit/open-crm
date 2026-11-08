// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activityLog,
  apiTokens,
  auditLog,
  authSessions,
  automations,
  boardMembers,
  cells,
  webhooks,
} from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';
import { t as i18n, type MessageKey } from '@bines/shared';
/** A server text in Hebrew from the i18n catalog (ANSWERS 6א.4: the server writes no literal text). */
const he = (key: string, vars?: Record<string, string | number>) => i18n(key as MessageKey, vars, 'he');

/** Administration → users (08 §3, account admin A2): edit, role, deactivate, transfer, delete details, bulk, CSV. */
let t: TestContext;
let admin: string; // admin
let bob: string; // member
let carol: string; // member
let vic: string; // viewer
let gus: string; // guest
let otherAdmin: string; // admin of another account
let acmeId: string;
let otherId: string;
let ids: Record<'admin' | 'bob' | 'carol' | 'vic' | 'gus', string>;
let otherUserId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const users = async (query = '') => (await body(await as(admin).get(`/users${query}`))).data as Json[];
const member = async (id: string) => (await users()).find((u) => u.user_id === id)!;

const newAccount = async (owner: string, name: string, slug: string, email: string) =>
  (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name,
        slug,
        first_admin_email: email,
        template_set: 'empty',
      }),
    )
  ).account.id as string;

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = await newAccount(owner, 'Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['vic@acme.test'], role: 'viewer' });
  vic = await join('vic@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['gus@out.test'], role: 'guest' });
  gus = await join('gus@out.test');
  otherId = await newAccount(owner, 'Other', 'other', 'boss@other.test');
  otherAdmin = await join('boss@other.test');
  const list = await users();
  const idOf = (email: string) => list.find((u) => u.email === email)!.user_id as string;
  ids = {
    admin: idOf('admin@acme.test'),
    bob: idOf('bob@acme.test'),
    carol: idOf('carol@acme.test'),
    vic: idOf('vic@acme.test'),
    gus: idOf('gus@out.test'),
  };
  otherUserId = ((await body(await t.api(otherAdmin, otherId).get('/users'))).data as Json[])[0]!.user_id;
});
afterAll(() => t.close());

describe('GET /users — filters and admin fields', () => {
  it('filters by role, status, team and search; admins see teams and last seen', async () => {
    const team = await body(await as(admin).post('/teams', { name: 'Sales', member_ids: [ids.carol] }));
    expect((await users('?role=member')).map((u) => u.email).sort()).toEqual(['bob@acme.test', 'carol@acme.test']);
    expect((await users('?q=VIC')).map((u) => u.email)).toEqual(['vic@acme.test']);
    expect((await users(`?team_id=${team.id}`)).map((u) => u.email)).toEqual(['carol@acme.test']);
    expect((await users('?status=deactivated')).length).toBe(0);
    const carolRow = await member(ids.carol);
    expect(carolRow.teams).toEqual([{ id: team.id, name: 'Sales' }]);
    expect(typeof carolRow.last_seen_at).toBe('string');
    // Members get the list, without the last-seen times.
    const asBob = (await body(await as(bob).get('/users'))).data as Json[];
    expect(asBob.every((u) => u.last_seen_at === null)).toBe(true);
    expect((await as(admin).get('/users?role=boss')).status).toBe(400);
  });
});

describe('PATCH /users/:id', () => {
  it('edits role and profile fields, with activity and audit rows', async () => {
    const res = await as(admin).patch(`/users/${ids.bob}`, {
      title: 'Sales lead',
      department: 'Sales',
      phone: '050-1234567',
      name: 'Bob B',
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ title: 'Sales lead', department: 'Sales', name: 'Bob B' });
    const role = await body(await as(admin).patch(`/users/${ids.vic}`, { role: 'member' }));
    expect(role.role).toBe('member');
    await as(admin).patch(`/users/${ids.vic}`, { role: 'viewer' });
    const events = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'user.updated')));
    expect(events.length).toBe(3);
    const audits = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, 'user.role_changed')));
    expect(audits.length).toBe(2);
  });

  it('never your own role; only admins; other accounts are 404', async () => {
    expect((await as(admin).patch(`/users/${ids.admin}`, { role: 'member' })).status).toBe(403);
    // Your own details are fine.
    expect((await as(admin).patch(`/users/${ids.admin}`, { title: 'Boss' })).status).toBe(200);
    expect((await as(bob).patch(`/users/${ids.carol}`, { title: 'x' })).status).toBe(403);
    expect((await as(vic).patch(`/users/${ids.carol}`, { title: 'x' })).status).toBe(403);
    expect((await as(gus).patch(`/users/${ids.carol}`, { title: 'x' })).status).toBe(403);
    expect((await as(admin).patch(`/users/${otherUserId}`, { title: 'x' })).status).toBe(404);
    expect((await t.api(otherAdmin, otherId).patch(`/users/${ids.bob}`, { title: 'x' })).status).toBe(404);
    expect((await t.api(otherAdmin, acmeId).patch(`/users/${ids.bob}`, { title: 'x' })).status).toBe(404);
  });
});

describe('transfer ownership', () => {
  let boardId: string;
  let peopleKey: string;
  let itemId: string;

  it('moves boards, automations, webhooks, service tokens and assignments in one batch', async () => {
    const ws = (await body(await as(bob).get('/workspaces'))).data[0];
    boardId = (await body(await as(bob).post('/boards', { name: 'Bob board', workspace_id: ws.id }))).id;
    peopleKey = (await body(await as(bob).post(`/boards/${boardId}/columns`, { title: 'Owner', type: 'people' }))).id;
    itemId = (
      await body(
        await as(bob).post(`/boards/${boardId}/items`, {
          name: 'Lead',
          cells: { [peopleKey]: { persons_and_teams: [{ kind: 'person', id: ids.bob }] } },
        }),
      )
    ).id;
    await t.db.insert(automations).values({
      id: '01AUTOBOB00000000000000000',
      accountId: acmeId,
      boardId,
      title: 'Bob automation',
      recipe: { trigger: { type: 'item_created' }, conditions: [], actions: [] },
      ownerId: ids.bob,
      createdBy: ids.bob,
    });
    await t.db.insert(webhooks).values({
      id: '01HOOKBOB00000000000000000',
      accountId: acmeId,
      boardId,
      url: 'https://example.test/hook',
      eventType: 'create_item',
      secret: 's',
      createdBy: ids.bob,
    });
    const svc = await body(
      await as(admin).post('/auth/service-tokens', { name: 'Zapier', scopes: ['boards:read'], role: 'member' }),
    );
    await t.db.update(apiTokens).set({ createdBy: ids.bob }).where(eq(apiTokens.id, svc.id));

    // Not to a viewer, not to themselves, only admins.
    const scope = ['boards', 'automations', 'webhooks', 'service_tokens', 'assignments'];
    expect((await as(admin).post(`/users/${ids.bob}/transfer-ownership`, { to_user_id: ids.vic, scope })).status).toBe(
      422,
    );
    expect((await as(admin).post(`/users/${ids.bob}/transfer-ownership`, { to_user_id: ids.bob, scope })).status).toBe(
      422,
    );
    expect(
      (await as(carol).post(`/users/${ids.bob}/transfer-ownership`, { to_user_id: ids.carol, scope })).status,
    ).toBe(403);
    expect(
      (
        await t
          .api(otherAdmin, otherId)
          .post(`/users/${ids.bob}/transfer-ownership`, { to_user_id: otherUserId, scope })
      ).status,
    ).toBe(404);

    const res = await as(admin).post(`/users/${ids.bob}/transfer-ownership`, { to_user_id: ids.carol, scope });
    expect(res.status).toBe(200);
    const result = await body(res);
    expect(result).toMatchObject({ boards: 1, automations: 1, webhooks: 1, service_tokens: 1, assignments: 1 });

    const owners = await t.db.select().from(boardMembers).where(eq(boardMembers.boardId, boardId));
    expect(owners.find((m) => m.userId === ids.carol)?.role).toBe('owner');
    expect(owners.find((m) => m.userId === ids.bob)?.role).toBe('subscriber');
    const [auto] = await t.db.select().from(automations).where(eq(automations.id, '01AUTOBOB00000000000000000'));
    expect(auto!.ownerId).toBe(ids.carol);
    const [hook] = await t.db.select().from(webhooks).where(eq(webhooks.id, '01HOOKBOB00000000000000000'));
    expect(hook!.createdBy).toBe(ids.carol);
    const [tok] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, svc.id));
    expect(tok!.createdBy).toBe(ids.carol);
    const [cell] = await t.db.select().from(cells).where(eq(cells.itemId, itemId));
    expect(cell!.value).toEqual({ persons_and_teams: [{ kind: 'person', id: ids.carol }] });
    expect(cell!.textValue).toBe('carol');

    const batch = await t.db.select().from(activityLog).where(eq(activityLog.batchId, result.batch_id));
    expect(batch.map((e) => e.type).sort()).toEqual([
      'automation.owner_changed',
      'board.members_changed',
      'cell.changed',
      'token.owner_changed',
      'user.ownership_transferred',
      'webhook.owner_changed',
    ]);
    // Nothing left: a second run moves nothing.
    expect(
      (await body(await as(admin).post(`/users/${ids.bob}/transfer-ownership`, { to_user_id: ids.carol, scope })))
        .batch_id,
    ).toBeNull();
  });
});

describe('deactivate / activate', () => {
  it('cuts the person off this account, revokes their tokens, turns off what they still own', async () => {
    const pat = await body(await as(bob).post('/auth/tokens', { name: 'mine', scopes: ['boards:read'] }));
    await t.db.insert(automations).values({
      id: '01AUTOBOB20000000000000000',
      accountId: acmeId,
      title: 'Still Bob',
      recipe: { trigger: { type: 'item_created' }, conditions: [], actions: [] },
      ownerId: ids.bob,
    });
    expect((await as(bob).post(`/users/${ids.carol}/deactivate`, {})).status).toBe(403);
    expect((await as(admin).post(`/users/${ids.admin}/deactivate`, {})).status).toBe(403);
    expect((await t.api(otherAdmin, otherId).post(`/users/${ids.bob}/deactivate`, {})).status).toBe(404);

    const res = await as(admin).post(`/users/${ids.bob}/deactivate`, {});
    expect(res.status).toBe(200);
    expect((await body(res)).user).toMatchObject({ status: 'deactivated' });
    // Signed out (no other account) — and even a live session could not enter this account.
    expect((await as(bob).get('/users')).status).toBe(401);
    const [tok] = await t.db.select().from(apiTokens).where(eq(apiTokens.id, pat.id));
    expect(tok!.revokedAt).not.toBeNull();
    const [auto] = await t.db.select().from(automations).where(eq(automations.id, '01AUTOBOB20000000000000000'));
    expect(auto).toMatchObject({ isActive: false, deactivatedReason: 'owner_deactivated' });
    // Bob has no other account: his sessions end.
    expect((await t.db.select().from(authSessions).where(eq(authSessions.userId, ids.bob))).length).toBe(0);
    // Still listed (greyed in people cells) with the deactivation time.
    expect((await users('?status=deactivated')).map((u) => u.user_id)).toEqual([ids.bob]);
    const audit = await t.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, 'user.deactivated')));
    expect(audit.length).toBe(1);

    const back = await as(admin).post(`/users/${ids.bob}/activate`);
    expect(back.status).toBe(200);
    expect((await body(back)).status).toBe('active');
  });

  it('deactivate can transfer first, in the same request', async () => {
    await t.db
      .update(automations)
      .set({ isActive: true, deactivatedReason: null })
      .where(eq(automations.ownerId, ids.bob));
    const res = await as(admin).post(`/users/${ids.bob}/deactivate`, {
      transfer: { to_user_id: ids.carol, scope: ['automations'] },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).transfer).toMatchObject({ automations: 1 });
    const [auto] = await t.db.select().from(automations).where(eq(automations.id, '01AUTOBOB20000000000000000'));
    expect(auto).toMatchObject({ ownerId: ids.carol, isActive: true });
  });
});

describe('DELETE /users/:id/details', () => {
  it('only after deactivation; anonymises the person, the content stays', async () => {
    expect((await as(admin).del(`/users/${ids.carol}/details`, {})).status).toBe(409);
    expect((await as(carol).del(`/users/${ids.bob}/details`, {})).status).toBe(403);
    expect((await t.api(otherAdmin, otherId).del(`/users/${ids.bob}/details`, {})).status).toBe(404);
    expect((await as(admin).del(`/users/${ids.bob}/details?display=everyone`)).status).toBe(400);
    const res = await as(admin).del(`/users/${ids.bob}/details`);
    expect(res.status).toBe(200);
    const row = await body(res);
    expect(row).toMatchObject({
      name: he('server.deletedUser'),
      title: null,
      phone: null,
      department: null,
      anonymised: true,
    });
    expect(row.email).toMatch(/^deleted\+[0-9a-z]+@anon\.invalid$/);
    // Activation after anonymising is refused.
    expect((await as(admin).post(`/users/${ids.bob}/activate`)).status).toBe(409);
    const ev = await t.db
      .select()
      .from(activityLog)
      .where(and(eq(activityLog.accountId, acmeId), eq(activityLog.type, 'user.anonymised')));
    expect(ev.length).toBe(1);
    expect(JSON.stringify(ev[0]!.payload)).not.toContain('bob@acme.test');
  });

  it('can keep the first name', async () => {
    await as(admin).post('/users/invite', { emails: ['eve@acme.test'], role: 'member' });
    await join('eve@acme.test');
    const eve = (await users('?q=eve'))[0]!.user_id as string;
    await as(admin).patch(`/users/${eve}`, { name: 'Eve Adams' });
    await as(admin).post(`/users/${eve}/deactivate`, {});
    const row = await body(await as(admin).del(`/users/${eve}/details?display=first_name`));
    expect(row).toMatchObject({ name: 'Eve', anonymised: true, status: 'deactivated' });
  });

  it('is refused while the person is active in another account', async () => {
    await t.api(otherAdmin, otherId).post('/users/invite', { emails: ['vic@acme.test'], role: 'member' });
    const token = t.inviteTokenFor('vic@acme.test');
    await t.api(vic).post('/invitations/accept', { token });
    await as(admin).post(`/users/${ids.vic}/deactivate`, {});
    expect((await body(await as(admin).del(`/users/${ids.vic}/details`, {}))).error.code).toBe('user_active_elsewhere');
    await as(admin).post(`/users/${ids.vic}/activate`);
  });
});

describe('bulk, resend, CSV', () => {
  it('bulk role / deactivate / activate skip yourself and report it', async () => {
    const res = await as(admin).post('/users/bulk', { op: 'set_role', role: 'viewer', ids: [ids.vic, ids.admin] });
    expect(await body(res)).toEqual({ done: 1, skipped: [{ id: ids.admin, code: 'self' }] });
    const off = await body(await as(admin).post('/users/bulk', { op: 'deactivate', ids: [ids.vic, otherUserId] }));
    expect(off).toEqual({ done: 1, skipped: [{ id: otherUserId, code: 'not_found' }] });
    expect((await member(ids.vic)).status).toBe('deactivated');
    expect((await body(await as(admin).post('/users/bulk', { op: 'activate', ids: [ids.vic] }))).done).toBe(1);
    expect((await as(carol).post('/users/bulk', { op: 'activate', ids: [ids.vic] })).status).toBe(403);
    expect((await as(admin).post('/users/bulk', { op: 'nope', ids: [ids.vic] })).status).toBe(400);
  });

  it('resends an invitation with a fresh link; bulk resend takes invitation ids', async () => {
    const inv = (await body(await as(admin).post('/users/invite', { emails: ['dan@acme.test'], role: 'member' })))
      .invited[0];
    const first = t.inviteTokenFor('dan@acme.test');
    const res = await as(admin).post(`/users/invitations/${inv.id}/resend`);
    expect(res.status).toBe(200);
    const again = await body(res);
    expect(again.emailed).toBe(true);
    expect(again.invitation.id).toBe(inv.id); //: the same invitation, a fresh link
    expect(t.inviteTokenFor('dan@acme.test')).not.toBe(first);
    const pending = (await body(await as(admin).get('/users/invitations'))).data as Json[];
    expect(pending.map((p) => p.id)).toEqual([again.invitation.id]);
    expect((await as(carol).post(`/users/invitations/${again.invitation.id}/resend`)).status).toBe(403);
    expect((await t.api(otherAdmin, otherId).post(`/users/invitations/${again.invitation.id}/resend`)).status).toBe(
      404,
    );
    const bulk = await body(await as(admin).post('/users/bulk', { op: 'resend', ids: [again.invitation.id] }));
    expect(bulk).toEqual({ done: 1, skipped: [] });
  });

  it('exports the people as CSV (admins)', async () => {
    const res = await as(admin).get('/users/export.csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('carol@acme.test');
    expect(text).toContain('Sales');
    expect(text).not.toContain('boss@other.test');
    expect((await as(carol).get('/users/export.csv')).status).toBe(403);
  });
});

describe('default transfer user (account setting)', () => {
  it('admins read and set it; it must be an active admin or member', async () => {
    expect(await body(await as(admin).get('/accounts/me/default-transfer-user'))).toEqual({ user_id: null });
    expect((await as(admin).patch('/accounts/me/default-transfer-user', { user_id: ids.gus })).status).toBe(422);
    expect((await as(admin).patch('/accounts/me/default-transfer-user', { user_id: otherUserId })).status).toBe(422);
    expect((await as(carol).patch('/accounts/me/default-transfer-user', { user_id: ids.carol })).status).toBe(403);
    expect((await as(carol).get('/accounts/me/default-transfer-user')).status).toBe(403);
    const res = await as(admin).patch('/accounts/me/default-transfer-user', { user_id: ids.carol });
    expect(await body(res)).toEqual({ user_id: ids.carol });
    expect(await body(await as(admin).get('/accounts/me/default-transfer-user'))).toEqual({ user_id: ids.carol });
    // Other account: its own setting.
    expect(await body(await t.api(otherAdmin, otherId).get('/accounts/me/default-transfer-user'))).toEqual({
      user_id: null,
    });
    // Account settings keep it (the general PATCH does not drop it).
    await as(admin).patch('/accounts/me', { name: 'Acme Ltd' });
    expect(await body(await as(admin).get('/accounts/me/default-transfer-user'))).toEqual({ user_id: ids.carol });
    await as(admin).patch('/accounts/me/default-transfer-user', { user_id: null });
  });
});
