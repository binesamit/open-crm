// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { assets, auditLog, authSessions } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/** Administration A4 + A5 (08 §5, §8, §9, §11): security, sessions, audit log, usage, tidy up. */
let t: TestContext;
let admin: string;
let bob: string; // member
let carol: string; // member
let otherAdmin: string;
let acmeId: string;
let otherId: string;
let ids: Record<'admin' | 'bob' | 'carol', string>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const newAccount = async (owner: string, name: string, slug: string, email: string) =>
  (
    await body(
      await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
    )
  ).account.id as string;
const auditRows = (action: string) =>
  t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, action)));

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = await newAccount(owner, 'Acme', 'acme', 'admin@acme.test');
  admin = await join('admin@acme.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test', 'carol@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  carol = await join('carol@acme.test');
  otherId = await newAccount(owner, 'Other', 'other', 'boss@other.test');
  otherAdmin = await join('boss@other.test');
  const list = (await body(await as(admin).get('/users'))).data as Json[];
  const idOf = (email: string) => list.find((u) => u.email === email)!.user_id as string;
  ids = { admin: idOf('admin@acme.test'), bob: idOf('bob@acme.test'), carol: idOf('carol@acme.test') };
});
afterAll(() => t.close());

describe('security settings — GET/PATCH /security', () => {
  it('admins only; defaults; changes are audited', async () => {
    expect((await as(bob).get('/security')).status).toBe(403);
    expect((await as(bob).patch('/security', { auto_join: true })).status).toBe(403);
    const initial = await body(await as(admin).get('/security'));
    expect(initial).toMatchObject({
      domains: [],
      restrict_members_to_domains: false,
      auto_join: false,
      auto_join_role: 'member',
      guest_domain_policy: { mode: 'any', domains: [] },
    });
    const res = await as(admin).patch('/security', {
      domains: ['acme.test'],
      restrict_members_to_domains: true,
      auto_join: true,
      auto_join_role: 'viewer',
    });
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ domains: ['acme.test'], auto_join: true, auto_join_role: 'viewer' });
    expect((await as(admin).patch('/security', { domains: ['not a domain'] })).status).toBe(400);
    const rows = await auditRows('security.settings_changed');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ fields: expect.arrayContaining(['domains', 'auto_join']) });
    // The account settings keep it (other settings untouched).
    const detail = await body(await as(admin).get('/accounts/me'));
    expect(detail.settings.security).toMatchObject({ auto_join: true });
  });

  it('enforces allowed domains on member invitations and the guest domain policy', async () => {
    let res = await body(await as(admin).post('/users/invite', { emails: ['x@elsewhere.test'], role: 'member' }));
    expect(res.errors).toEqual([{ email: 'x@elsewhere.test', code: 'domain_not_allowed' }]);
    res = await body(await as(admin).post('/users/invite', { emails: ['dan@acme.test'], role: 'viewer' }));
    expect(res.invited).toHaveLength(1);

    await as(admin).patch('/security', { guest_domain_policy: { mode: 'allow_list', domains: ['client.test'] } });
    res = await body(await as(admin).post('/users/invite', { emails: ['g@random.test'], role: 'guest' }));
    expect(res.errors[0].code).toBe('guest_domain_not_allowed');
    res = await body(await as(admin).post('/users/invite', { emails: ['g@client.test'], role: 'guest' }));
    expect(res.invited).toHaveLength(1);

    await as(admin).patch('/security', { guest_domain_policy: { mode: 'block_list', domains: ['gmail.test'] } });
    res = await body(await as(admin).post('/users/invite', { emails: ['g@gmail.test'], role: 'guest' }));
    expect(res.errors[0].code).toBe('guest_domain_blocked');
    res = await body(await as(admin).post('/users/invite', { emails: ['g@acme.test'], role: 'guest' }));
    expect(res.errors[0].code).toBe('guest_domain_not_external');

    // Back to open for the rest of the file.
    await as(admin).patch('/security', {
      restrict_members_to_domains: false,
      guest_domain_policy: { mode: 'any', domains: [] },
    });
  });
});

describe('sessions — /security/sessions', () => {
  it("lists the account's sign-ins (mine marked current); admins only; not other accounts'", async () => {
    expect((await as(bob).get('/security/sessions')).status).toBe(403);
    const list = (await body(await as(admin).get('/security/sessions'))).data as Json[];
    const users = new Set(list.map((s) => s.user_id));
    expect(users.has(ids.bob)).toBe(true);
    expect(users.has(ids.carol)).toBe(true);
    expect(list.find((s) => s.current)?.user_id).toBe(ids.admin);
    expect(list.every((s) => !('token' in s))).toBe(true);
    // The other account's admin is not a member here.
    const others = (await body(await t.api(otherAdmin, otherId).get('/security/sessions'))).data as Json[];
    expect(others.some((s) => s.user_id === ids.bob)).toBe(false);
  });

  it('signs one session out (audited); never my current one; another account cannot', async () => {
    const list = (await body(await as(admin).get('/security/sessions'))).data as Json[];
    const bobs = list.find((s) => s.user_id === ids.bob)!;
    const mine = list.find((s) => s.current)!;
    expect((await as(admin).del(`/security/sessions/${mine.id}`)).status).toBe(403);
    expect((await t.api(otherAdmin, otherId).del(`/security/sessions/${bobs.id}`)).status).toBe(404);
    expect((await as(bob).del(`/security/sessions/${bobs.id}`)).status).toBe(403);
    const res = await as(admin).del(`/security/sessions/${bobs.id}`);
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ signed_out: 1 });
    expect((await t.api(bob).get('/auth/me')).status).toBe(401);
    expect(await t.db.select().from(authSessions).where(eq(authSessions.id, bobs.id))).toHaveLength(0);
    const rows = await auditRows('session.signed_out');
    expect(rows[0]).toMatchObject({ targetType: 'user', targetId: ids.bob });
    bob = (await t.signInWithMagicLink('bob@acme.test')).cookie!;
  });

  it('signs everyone out except me', async () => {
    const res = await as(admin).post('/security/sessions/sign-out-all');
    expect(res.status).toBe(200);
    expect((await body(res)).signed_out).toBeGreaterThanOrEqual(2);
    expect((await t.api(carol).get('/auth/me')).status).toBe(401);
    expect((await as(admin).get('/security/sessions')).status).toBe(200);
    const left = (await body(await as(admin).get('/security/sessions'))).data as Json[];
    expect(left.every((s) => s.user_id === ids.admin)).toBe(true);
    expect(await auditRows('session.signed_out_all')).toHaveLength(1);
    bob = (await t.signInWithMagicLink('bob@acme.test')).cookie!;
    carol = (await t.signInWithMagicLink('carol@acme.test')).cookie!;
  });
});

describe('audit — token writes and GET /audit', () => {
  it('token create / revoke write audit rows', async () => {
    const created = await body(await as(bob).post('/auth/tokens', { name: 'Script', scopes: ['boards:read'] }));
    expect((await as(bob).del(`/auth/tokens/${created.id}`)).status).toBe(200);
    expect((await auditRows('token.created')).some((r) => r.targetId === created.id)).toBe(true);
    expect((await auditRows('token.revoked')).some((r) => r.targetId === created.id)).toBe(true);
  });

  it('role change is audited and shows in the log with names', async () => {
    await as(admin).patch(`/users/${ids.carol}`, { role: 'viewer' });
    await as(admin).patch(`/users/${ids.carol}`, { role: 'member' });
    const page = await body(await as(admin).get('/audit?event=user.role_changed'));
    expect(page.total).toBe(2);
    expect(page.data[0]).toMatchObject({ event: 'user.role_changed', actor_name: 'admin', target_name: 'carol' });
    expect(page.events).toEqual(expect.arrayContaining(['user.role_changed', 'token.created', 'user.invited']));
  });

  it('filters by person and days, pages, exports CSV; admins only; account isolation', async () => {
    expect((await as(bob).get('/audit')).status).toBe(403);
    const byBob = await body(await as(admin).get(`/audit?actor_id=${ids.bob}`));
    expect(byBob.data.length).toBeGreaterThan(0);
    expect(byBob.data.every((e: Json) => e.actor_id === ids.bob)).toBe(true);
    const all = await body(await as(admin).get('/audit?page_size=2'));
    expect(all.data).toHaveLength(2);
    expect(all.total).toBeGreaterThan(2);
    const page2 = await body(await as(admin).get('/audit?page_size=2&page=2'));
    expect(page2.data[0].id).not.toBe(all.data[0].id);
    const today = new Date().toISOString().slice(0, 10);
    expect((await body(await as(admin).get(`/audit?from=${today}&to=${today}`))).total).toBe(all.total);
    expect((await body(await as(admin).get('/audit?to=2000-01-01'))).total).toBe(0);
    expect((await as(admin).get('/audit?from=nope')).status).toBe(400);
    // Another account sees only its own rows.
    const other = await body(await t.api(otherAdmin, otherId).get('/audit'));
    expect(other.data.some((e: Json) => e.event === 'user.role_changed')).toBe(false);
    const csv = await as(admin).get('/audit/export.csv?event=user.role_changed');
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    const text = await csv.text();
    expect(text).toContain('user.role_changed');
    expect(text.trim().split('\r\n')).toHaveLength(3);
    expect((await as(bob).get('/audit/export.csv')).status).toBe(403);
  });
});

let mainBoard: string;
let privateBoard: string;

describe('tidy up — /admin/boards', () => {
  beforeAll(async () => {
    const ws = (await body(await as(admin).get('/workspaces'))).data[0];
    mainBoard = (await body(await as(bob).post('/boards', { name: 'Leads', workspace_id: ws.id }))).id;
    await as(bob).post(`/boards/${mainBoard}/items`, { name: 'One' });
    await as(bob).post(`/boards/${mainBoard}/items`, { name: 'Two' });
    privateBoard = (
      await body(await as(bob).post('/boards', { name: 'Bob only', workspace_id: ws.id, kind: 'private' }))
    ).id;
  });

  it('lists every board with owners and items; private ones as metadata; admins only', async () => {
    expect((await as(bob).get('/admin/boards')).status).toBe(403);
    const list = (await body(await as(admin).get('/admin/boards'))).data as Json[];
    const main = list.find((b) => b.id === mainBoard)!;
    expect(main).toMatchObject({
      name: 'Leads',
      kind: 'main',
      items_count: 2,
      has_active_owner: true,
      archived_at: null,
      content_access: true,
    });
    expect(main.owners).toEqual([{ user_id: ids.bob, name: 'bob', active: true }]);
    const priv = list.find((b) => b.id === privateBoard)!;
    expect(priv).toMatchObject({ name: 'Bob only', kind: 'private', content_access: false });
    const other = (await body(await t.api(otherAdmin, otherId).get('/admin/boards'))).data as Json[];
    expect(other.some((b) => b.id === mainBoard)).toBe(false);
  });

  it('transfers ownership of one board (audited)', async () => {
    expect(
      (await as(admin).post(`/admin/boards/${mainBoard}/transfer-ownership`, { to_user_id: 'nobody' })).status,
    ).toBe(422);
    const res = await as(admin).post(`/admin/boards/${mainBoard}/transfer-ownership`, { to_user_id: ids.carol });
    expect(res.status).toBe(200);
    expect((await body(res)).owners).toEqual([{ user_id: ids.carol, name: 'carol', active: true }]);
    const kept = await body(
      await as(admin).post(`/admin/boards/${mainBoard}/transfer-ownership`, {
        to_user_id: ids.bob,
        keep_current_owners: true,
      }),
    );
    expect(kept.owners.map((o: Json) => o.user_id).sort()).toEqual([ids.bob, ids.carol].sort());
    expect(await auditRows('board.ownership_transferred')).toHaveLength(2);
    expect(
      (await t.api(otherAdmin, otherId).post(`/admin/boards/${mainBoard}/transfer-ownership`, { to_user_id: ids.bob }))
        .status,
    ).toBe(404);
  });

  it('archives and deletes (to the trash), audited; another account gets 404', async () => {
    expect((await t.api(otherAdmin, otherId).post(`/admin/boards/${privateBoard}/archive`)).status).toBe(404);
    expect((await as(bob).post(`/admin/boards/${privateBoard}/archive`)).status).toBe(403);
    expect((await as(admin).post(`/admin/boards/${privateBoard}/archive`)).status).toBe(200);
    let list = (await body(await as(admin).get('/admin/boards'))).data as Json[];
    expect(list.find((b) => b.id === privateBoard)!.archived_at).not.toBeNull();
    expect((await as(admin).del(`/admin/boards/${privateBoard}`)).status).toBe(200);
    list = (await body(await as(admin).get('/admin/boards'))).data as Json[];
    expect(list.some((b) => b.id === privateBoard)).toBe(false);
    expect(await auditRows('board.archived')).toHaveLength(1);
    expect((await auditRows('board.deleted'))[0]).toMatchObject({ targetId: privateBoard });
    const trash = await body(await as(admin).get('/trash'));
    expect(JSON.stringify(trash)).toContain(privateBoard);
  });
});

describe('usage — GET /usage', () => {
  it('admins only; numbers from the tables', async () => {
    expect((await as(bob).get('/usage')).status).toBe(403);
    await t.db.insert(assets).values({
      id: newId(),
      accountId: acmeId,
      fileName: 'a.pdf',
      size: 1234,
      uploadStatus: 'uploaded',
      storageKey: 'k',
    });
    const usage = await body(await as(admin).get('/usage'));
    expect(usage).toMatchObject({
      days: 30,
      api_calls: null,
      storage_bytes: 1234,
      files: 1,
      items_total: 2,
      members_total: 3,
    });
    expect(usage.active_users).toBeGreaterThanOrEqual(3);
    expect(usage.daily).toHaveLength(30);
    expect(usage.boards_total).toBeGreaterThanOrEqual(1);
    expect((await body(await as(admin).get('/usage?days=7'))).daily).toHaveLength(7);
    expect((await as(admin).get('/usage?days=500')).status).toBe(400);
    const other = await body(await t.api(otherAdmin, otherId).get('/usage'));
    expect(other.storage_bytes).toBe(0);
  });
});
