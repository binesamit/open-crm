// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HocuspocusProvider } from '@hocuspocus/provider';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { newId } from '@bines/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apiTokens, auditLog, supportAccessGrants, supportRecoveryRequests, users } from '../src/db/schema';
import { COLLAB_PATH, createCollab, type Collab } from '../src/modules/docs/collab';
import { hashToken } from '../src/modules/tokens/tokens.service';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Remote support access: the owner console's two back doors are closed (invite-admin to the owner's
 * own address, the recovery link) unless an admin granted support access — or by the emergency path (notice + wait,
 * cancellable); the grant's lifecycle (grant, enter, revoke, expire); view-only held on REST, MCP and the docs
 * socket; everything in the account's audit log; the IP allowlist's owner exemption as a setting + per-person ones.
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let helper: string; // a person with no membership in Acme (a support email)
let acmeId: string;
let wsId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const PASSWORD = 'correct-horse-battery'; // helpers.signUpWithPassword

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const as = (cookie: string) => t.api(cookie, acmeId);
const audits = (action: string) =>
  t.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.accountId, acmeId), eq(auditLog.action, action)));
const grant = async (input: Json) => {
  const res = await as(admin).post('/support-access', { duration_hours: 24, reason: 'Ticket #12', ...input });
  expect(res.status).toBe(201);
  return body(res);
};
const revoke = async (id: string) => expect((await as(admin).del(`/support-access/${id}`)).status).toBe(200);
const revokeAll = async () => {
  for (const g of (await body(await as(admin).get('/support-access'))).grants as Json[])
    if (g.status === 'active') await revoke(g.id);
};
const authCall = (path: string, payload: unknown, cookie?: string) =>
  t.app.request(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });
const mailsTo = (email: string) => t.mailer.sent.filter((m) => m.to === email);

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  await mk('Helpers', 'helpers', 'helper@support.test');
  admin = await join('admin@acme.test');
  helper = await join('helper@support.test');
  await as(admin).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  wsId = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  await as(admin).post(`/boards/${boardId}/items`, { name: 'Dana Levi' });
});
afterAll(() => t.close());

describe('the back doors are closed', () => {
  it('invite-admin: never to the owner’s own address, grant or not; audited as the owner’s', async () => {
    const own = await t.api(owner).post(`/platform/accounts/${acmeId}/invite-admin`, { email: OWNER_EMAIL });
    expect(own.status).toBe(403);
    expect((await body(own)).error.message).toBe('support_grant_required');
    // Upper case is the same address.
    expect(
      (await t.api(owner).post(`/platform/accounts/${acmeId}/invite-admin`, { email: OWNER_EMAIL.toUpperCase() }))
        .status,
    ).toBe(403);
    // Someone else: allowed, and the audit row says it came from the owner console.
    const other = await t.api(owner).post(`/platform/accounts/${acmeId}/invite-admin`, { email: 'second@acme.test' });
    expect(other.status).toBe(200);
    const rows = await audits('user.invited');
    expect(
      rows.some(
        (r) => (r.payload as Json).email === 'second@acme.test' && (r.payload as Json).via === 'platform_owner',
      ),
    ).toBe(true);

    // No grant opens it — view or edit (S-51: a membership never comes out of support access).
    const view = await grant({ mode: 'view' });
    expect((await t.api(owner).post(`/platform/accounts/${acmeId}/invite-admin`, { email: OWNER_EMAIL })).status).toBe(
      403,
    );
    await revoke(view.id);
    await as(admin).patch('/security', { support_access: { allow_edit: true } });
    const edit = await grant({ mode: 'edit' });
    expect((await t.api(owner).post(`/platform/accounts/${acmeId}/invite-admin`, { email: OWNER_EMAIL })).status).toBe(
      403,
    );
    await revoke(edit.id);
    await as(admin).patch('/security', { support_access: { allow_edit: false } });
  });

  it('a grant never lists the account’s API tokens (audit 2026-10-10 security #15)', async () => {
    const view = await grant({ mode: 'view' });
    try {
      // Two guards: the path is on support's never-list (404), and the service refuses a support actor (403).
      for (const path of ['/auth/tokens', '/auth/tokens?all=true', '/auth/service-tokens']) {
        const res = await t.api(owner, acmeId).get(path);
        expect([403, 404], path).toContain(res.status);
        expect(JSON.stringify(await body(res))).not.toContain('"data"');
      }
    } finally {
      await revoke(view.id);
    }
  });

  it('a member’s 2FA reset from the console needs an edit grant too (audit 2026-10-10 #26)', async () => {
    const res = await t.api(owner).post(`/platform/accounts/${acmeId}/reset-2fa`, { email: 'bob@acme.test' });
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('support_grant_required');
    await as(admin).patch('/security', { support_access: { allow_edit: true } });
    const edit = await grant({ mode: 'edit' });
    try {
      // Reaches the service: Bob has no second factor to turn off.
      const none = await t.api(owner).post(`/platform/accounts/${acmeId}/reset-2fa`, { email: 'bob@acme.test' });
      expect(none.status).toBe(409);
      expect((await body(none)).error.message).toBe('two_factor_not_enabled');
      expect(
        (await t.api(owner).post(`/platform/accounts/${acmeId}/reset-2fa`, { email: 'nobody@acme.test' })).status,
      ).toBe(404);
    } finally {
      await revoke(edit.id);
      await as(admin).patch('/security', { support_access: { allow_edit: false } });
    }
  });

  it('the recovery link needs an edit grant; without one 403 support_grant_required', async () => {
    const res = await t.api(owner).post(`/platform/accounts/${acmeId}/recovery-link`, { email: 'bob@acme.test' });
    expect(res.status).toBe(403);
    expect(await body(res)).toMatchObject({
      error: { message: 'support_grant_required', details: { emergency_available: true } },
    });
    const view = await grant({ mode: 'view' });
    expect(
      (await t.api(owner).post(`/platform/accounts/${acmeId}/recovery-link`, { email: 'bob@acme.test' })).status,
    ).toBe(403);
    await revoke(view.id);
    await as(admin).patch('/security', { support_access: { allow_edit: true } });
    const edit = await grant({ mode: 'edit' });
    const ok = await t.api(owner).post(`/platform/accounts/${acmeId}/recovery-link`, { email: 'bob@acme.test' });
    expect(ok.status).toBe(200);
    expect((await body(ok)).url).toMatch(/#reset=[\w-]+$/);
    await revoke(edit.id);
    await as(admin).patch('/security', { support_access: { allow_edit: false } });
    // Revoked: closed again.
    expect(
      (await t.api(owner).post(`/platform/accounts/${acmeId}/recovery-link`, { email: 'bob@acme.test' })).status,
    ).toBe(403);
  });
});

describe('the emergency path (notice + wait, cancellable)', () => {
  it('is announced to the admins, waits, can be cancelled by any admin, then is single use', async () => {
    const before = mailsTo('admin@acme.test').length;
    const res = await t
      .api(owner)
      .post(`/platform/accounts/${acmeId}/emergency-recovery`, { email: 'bob@acme.test', reason: 'locked out' });
    expect(res.status).toBe(201);
    const req = await body(res);
    expect(req.status).toBe('waiting');
    // The default wait is 24 hours.
    const wait = Date.parse(req.available_at) - Date.parse(req.created_at);
    expect(Math.round(wait / 3_600_000)).toBe(24);
    // The admins are told at once, with the way to cancel (the Security page).
    expect(mailsTo('admin@acme.test').length).toBe(before + 1);
    expect(t.lastMailTo('admin@acme.test').html).toContain('/a/acme/admin/security');
    expect((await audits('support.emergency_recovery.requested')).length).toBe(1);

    // Too early.
    const early = await t.api(owner).post(`/platform/emergency-recovery/${req.id}/link`);
    expect(early.status).toBe(409);
    expect((await body(early)).error.message).toBe('emergency_waiting');
    // The admin sees it and cancels it (members cannot).
    const seen = (await body(await as(admin).get('/support-access'))).recovery_requests as Json[];
    expect(seen.find((r) => r.id === req.id)?.status).toBe('waiting');
    expect((await as(bob).post(`/support-access/recovery-requests/${req.id}/cancel`)).status).toBe(403);
    expect((await as(admin).post(`/support-access/recovery-requests/${req.id}/cancel`)).status).toBe(200);
    await t.db
      .update(supportRecoveryRequests)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(eq(supportRecoveryRequests.id, req.id));
    const cancelled = await t.api(owner).post(`/platform/emergency-recovery/${req.id}/link`);
    expect(cancelled.status).toBe(409);
    expect((await body(cancelled)).error.message).toBe('emergency_cancelled');
    expect((await audits('support.emergency_recovery.cancelled')).length).toBe(1);

    // A new one, after the wait: the link, once.
    const again = await body(
      await t.api(owner).post(`/platform/accounts/${acmeId}/emergency-recovery`, {
        email: 'bob@acme.test',
        reason: 'still locked out',
      }),
    );
    await t.db
      .update(supportRecoveryRequests)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(eq(supportRecoveryRequests.id, again.id));
    const link = await t.api(owner).post(`/platform/emergency-recovery/${again.id}/link`);
    expect(link.status).toBe(200);
    expect((await body(link)).url).toMatch(/#reset=[\w-]+$/);
    expect((await t.api(owner).post(`/platform/emergency-recovery/${again.id}/link`)).status).toBe(409);
    const rows = await audits('user.recovery_link_created');
    expect(rows.some((r) => (r.payload as Json).emergency_request_id === again.id)).toBe(true);
    // Nobody but the owner.
    expect(
      (
        await t
          .api(admin)
          .post(`/platform/accounts/${acmeId}/emergency-recovery`, { email: 'bob@acme.test', reason: 'x' })
      ).status,
    ).toBe(404);
    const list = await body(await t.api(owner).get(`/platform/accounts/${acmeId}/emergency-recovery`));
    expect((list.data as Json[]).map((r) => r.status).sort()).toEqual(['cancelled', 'used']);
  });

  it('a reset by the recovery link keeps two-factor: the code is still asked', async () => {
    // Bob turns on 2FA.
    const enable = await authCall('/two-factor/enable', { password: PASSWORD }, bob);
    expect(enable.status).toBe(200);
    const { totpURI } = await body(enable);
    const secret = base32(new URL(totpURI).searchParams.get('secret')!);
    expect((await authCall('/two-factor/verify-totp', { code: totp(secret) }, bob)).status).toBe(200);

    const req = await body(
      await t
        .api(owner)
        .post(`/platform/accounts/${acmeId}/emergency-recovery`, { email: 'bob@acme.test', reason: 'lost phone?' }),
    );
    await t.db
      .update(supportRecoveryRequests)
      .set({ availableAt: new Date(Date.now() - 1000) })
      .where(eq(supportRecoveryRequests.id, req.id));
    const { url } = await body(await t.api(owner).post(`/platform/emergency-recovery/${req.id}/link`));
    const token = /#reset=([\w-]+)$/.exec(url)![1]!;
    expect((await authCall('/reset-password', { newPassword: 'a-brand-new-password', token })).status).toBe(200);
    const user = (await t.db.select().from(users).where(eq(users.email, 'bob@acme.test')))[0]!;
    expect(user.twoFactorEnabled).toBe(true);
    const signIn = await authCall('/sign-in/email', { email: 'bob@acme.test', password: 'a-brand-new-password' });
    expect((await body(signIn)).twoFactorRedirect).toBe(true);
    // Back to a session for the tests below.
    const verify = await authCall(
      '/two-factor/verify-totp',
      { code: totp(secret) },
      signIn.headers
        .getSetCookie()
        .map((c) => c.split(';')[0]!)
        .find((c) => c.startsWith('bos.two_factor='))!,
    );
    bob = t.cookieFrom(verify)!;
    expect((await as(bob).get('/accounts/me')).status).toBe(200);
  });
});

describe('grant lifecycle', () => {
  it('admins only; the form’s options come from the owner console and the account (view only by default)', async () => {
    expect((await as(bob).get('/support-access')).status).toBe(403);
    expect((await as(bob).post('/support-access', { duration_hours: 24, reason: 'x' })).status).toBe(403);
    const s = await body(await as(admin).get('/support-access'));
    expect(s.options).toEqual({
      durations_hours: [1, 4, 24, 168],
      default_duration_hours: 24,
      max_hours: 168,
      allow_edit: false,
      platform_durations_hours: [1, 4, 24, 168],
    });
    expect(s.settings).toEqual({ allow_edit: false, max_hours: 168 });
    const edit = await as(admin).post('/support-access', { mode: 'edit', duration_hours: 24, reason: 'x' });
    expect(edit.status).toBe(403);
    expect((await body(edit)).error.message).toBe('support_edit_not_allowed');
    const odd = await as(admin).post('/support-access', { duration_hours: 5, reason: 'x' });
    expect(odd.status).toBe(422);
    // The account may shorten the maximum.
    await as(admin).patch('/security', { support_access: { max_hours: 24 } });
    expect((await body(await as(admin).get('/support-access'))).options.durations_hours).toEqual([1, 4, 24]);
    expect((await as(admin).post('/support-access', { duration_hours: 168, reason: 'x' })).status).toBe(422);
    await as(admin).patch('/security', { support_access: { max_hours: 168 } });
    // A member of the account needs no grant.
    expect(
      (
        await as(admin).post('/support-access', {
          grantee: 'email',
          email: 'bob@acme.test',
          duration_hours: 1,
          reason: 'x',
        })
      ).status,
    ).toBe(422);
    expect((await as(admin).post('/support-access', {})).status).toBe(400);
  });

  it('grant → the owner gets in (as support, view); entry emailed and audited once per session; revoke → out', async () => {
    expect((await as(owner).get('/accounts/me')).status).toBe(404);
    let platform = (await body(await t.api(owner).get('/platform/accounts'))).data as Json[];
    expect(platform.find((a) => a.id === acmeId)!.support).toBeNull();

    const g = await grant({});
    expect(g).toMatchObject({ grantee: 'platform', mode: 'view', status: 'active', reason: 'Ticket #12' });
    expect(Math.round((Date.parse(g.expires_at) - Date.now()) / 3_600_000)).toBe(24);
    expect((await audits('support.granted')).length).toBeGreaterThan(0);

    platform = (await body(await t.api(owner).get('/platform/accounts'))).data as Json[];
    expect(platform.find((a) => a.id === acmeId)!.support).toMatchObject({ grant_id: g.id, mode: 'view' });
    const mine = (await body(await t.api(owner).get('/me/accounts'))).data as Json[];
    expect(mine.find((a) => a.id === acmeId)).toMatchObject({
      role: 'admin',
      support: { grant_id: g.id, mode: 'view' },
    });
    // Nobody else sees it in their switcher.
    expect(((await body(await t.api(helper).get('/me/accounts'))).data as Json[]).some((a) => a.id === acmeId)).toBe(
      false,
    );

    const starts = (await audits('support.session.start')).length;
    const mails = mailsTo('admin@acme.test').length;
    expect((await as(owner).get('/accounts/me')).status).toBe(200);
    expect((await as(owner).get(`/boards/${boardId}`)).status).toBe(200);
    expect((await audits('support.session.start')).length).toBe(starts + 1);
    expect(mailsTo('admin@acme.test').length).toBe(mails + 1);
    // /auth/me carries the banner's flag.
    const me = await body(await as(owner).get('/auth/me'));
    expect(me.account).toMatchObject({
      id: acmeId,
      role: 'admin',
      support: { grant_id: g.id, mode: 'view', expires_at: g.expires_at },
    });
    // A member's /auth/me has none.
    expect((await body(await as(admin).get('/auth/me'))).account.support).toBeNull();
    // Opening the account is not remembered as "last account".
    expect((await t.api(owner).put('/me/last-account', { account_id: acmeId })).status).toBe(200);
    expect((await body(await t.api(owner).get('/auth/me'))).last_account_id).not.toBe(acmeId);

    await revoke(g.id);
    expect((await as(owner).get('/accounts/me')).status).toBe(404);
    expect((await audits('support.revoked')).length).toBeGreaterThan(0);
    const list = (await body(await as(admin).get('/support-access'))).grants as Json[];
    expect(list.find((x) => x.id === g.id)).toMatchObject({ status: 'revoked', revoked_by_name: 'admin' });
  });

  it('expires by itself', async () => {
    const g = await grant({ duration_hours: 1 });
    expect((await as(owner).get('/accounts/me')).status).toBe(200);
    await t.db
      .update(supportAccessGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(supportAccessGrants.id, g.id));
    expect((await as(owner).get('/accounts/me')).status).toBe(404);
    const list = (await body(await as(admin).get('/support-access'))).grants as Json[];
    expect(list.find((x) => x.id === g.id)!.status).toBe('expired');
  });

  it('a grant to a support email lets that person in, nobody else', async () => {
    const g = await grant({ grantee: 'email', email: 'helper@support.test' });
    expect((await as(helper).get('/accounts/me')).status).toBe(200);
    // The platform owner is not that person.
    expect((await as(owner).get('/accounts/me')).status).toBe(404);
    await revoke(g.id);
    expect((await as(helper).get('/accounts/me')).status).toBe(404);
  });
});

describe('view only, on every entrance', () => {
  it('REST: reads (also POST queries) pass; every change is 405 and audited', async () => {
    const g = await grant({});
    expect((await as(owner).get(`/boards/${boardId}`)).status).toBe(200);
    expect((await as(owner).post(`/boards/${boardId}/items/query`, {})).status).toBe(200);
    const write = await as(owner).post(`/boards/${boardId}/items`, { name: 'by support' });
    expect(write.status).toBe(405);
    expect((await body(write)).error.code).toBe('support_read_only');
    expect((await as(owner).patch(`/boards/${boardId}`, { name: 'renamed' })).status).toBe(405);
    expect((await as(owner).post('/support-access', { duration_hours: 24, reason: 'me' })).status).toBe(405);
    const views = await audits('support.view');
    expect(
      views.some((r) => (r.payload as Json).path === `/boards/${boardId}` && (r.payload as Json).via === 'rest'),
    ).toBe(true);
    const refused = await audits('support.refused');
    expect(
      refused.some(
        (r) =>
          (r.payload as Json).path === `/boards/${boardId}/items` && (r.payload as Json).code === 'support_read_only',
      ),
    ).toBe(true);
    await revoke(g.id);
  });

  it('REST, edit: acts as an admin, never on people, security or support access; every change audited', async () => {
    await as(admin).patch('/security', { support_access: { allow_edit: true } });
    const g = await grant({ mode: 'edit' });
    const created = await as(owner).post(`/boards/${boardId}/items`, { name: 'by support' });
    expect(created.status).toBe(201);
    const actions = await audits('support.action');
    expect(
      actions.some(
        (r) => (r.payload as Json).path === `/boards/${boardId}/items` && (r.payload as Json).status === 201,
      ),
    ).toBe(true);
    for (const [method, path, payload] of [
      ['POST', '/users/invite', { emails: ['me@evil.test'], role: 'admin' }],
      ['PATCH', '/security', { support_access: { max_hours: 720 } }],
      ['POST', '/support-access', { duration_hours: 24, reason: 'extend' }],
      ['POST', '/auth/tokens', { name: 'keep', scopes: ['boards:read'] }],
      // Audit 2026-10-10 #9: nothing irreversible, no account-wide maintenance settings.
      ['POST', '/admin/tidy/run', {}],
      ['PUT', '/admin/tidy/rules', {}],
      ['DELETE', '/trash', undefined],
      ['DELETE', '/trash/01M00000000000000000000000', undefined],
      ['PUT', '/conversions/settings', {}],
      ['PUT', '/geo/settings', {}],
    ] as const) {
      const res = await as(owner).call(method, path, payload);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect((await body(res)).error.message).toBe('support_not_allowed');
    }
    await revoke(g.id);
    await as(admin).patch('/security', { support_access: { allow_edit: false } });
  });

  it('MCP: a view grant lists read tools only and refuses writes; audited; revoked → the token is dead', async () => {
    const g = await grant({});
    const ownerRow = (await t.db.select().from(users).where(eq(users.email, OWNER_EMAIL)))[0]!;
    const token = `bos_pat_${newId()}${newId().slice(0, 14)}`;
    await t.db.insert(apiTokens).values({
      id: newId(),
      accountId: acmeId,
      userId: ownerRow.id,
      name: 'Claude Code',
      tokenHash: hashToken(token),
      tokenPrefix: token.slice(0, 12),
      scopes: ['boards:read', 'items:write', 'search'],
    });
    const fetchApp = (url: string | URL | Request, init?: RequestInit) =>
      t.app.request(url instanceof Request ? url : String(url), init) as Promise<Response>;
    const client = new Client({ name: 'bines-test', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${WEB_ORIGIN}/mcp`), {
        fetch: fetchApp,
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('get_board');
    expect(names).not.toContain('create_item');
    const read = (await client.callTool({ name: 'get_board', arguments: { board_id: boardId } })) as Json;
    expect(read.isError).toBeFalsy();
    await client.close();
    const viaMcp = (await audits('support.view')).filter((r) => (r.payload as Json).via === 'mcp');
    expect(viaMcp.some((r) => (r.payload as Json).tool === 'get_board')).toBe(true);
    // REST with the same token: also view only.
    const rest = await t.app.request(`/api/v1/boards/${boardId}/items`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'by token' }),
    });
    expect(rest.status).toBe(405);

    await revoke(g.id);
    const dead = await t.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(dead.status).toBe(404);
  });

  it('docs socket: a view grant connects read-only; revoked → refused', async () => {
    const collab: Collab = createCollab(t.deps, { debounce: 50, maxDebounce: 200 });
    const server: Server = createServer((_req, res) => res.end());
    collab.attach(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}${COLLAB_PATH}`;
    const providers: HocuspocusProvider[] = [];
    const connect = (name: string, cookie: string) => {
      let failure: string | null = null;
      const Ws = class extends WebSocket {
        constructor(u: string | URL) {
          super(u, { headers: { cookie, origin: WEB_ORIGIN } } as unknown as string[]);
        }
      };
      const provider = new HocuspocusProvider({
        url,
        name,
        document: new Y.Doc(),
        token: 'session',
        WebSocketPolyfill: Ws,
        onAuthenticationFailed: ({ reason }: { reason: string }) => {
          failure = reason || 'denied';
        },
      } as ConstructorParameters<typeof HocuspocusProvider>[0]);
      providers.push(provider);
      return { provider, failed: () => failure };
    };
    const until = async (check: () => boolean, ms = 5000) => {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) throw new Error('timed out');
        await new Promise((r) => setTimeout(r, 20));
      }
    };
    try {
      const doc = await body(await as(admin).post(`/workspaces/${wsId}/docs`, { name: 'Runbook' }));
      const g = await grant({});
      const viewer = connect(doc.collab_name, owner);
      await until(() => viewer.provider.isSynced || !!viewer.failed());
      expect(viewer.failed()).toBeNull();
      expect(viewer.provider.authorizedScope).toBe('readonly');
      const docViews = (await audits('support.view')).filter((r) => (r.payload as Json).via === 'docs');
      expect(docViews.some((r) => (r.payload as Json).doc_id === doc.id)).toBe(true);
      await revoke(g.id);
      const refused = connect(doc.collab_name, owner);
      await until(() => !!refused.failed());
    } finally {
      for (const p of providers) p.destroy();
      await collab.close();
      await new Promise((r) => server.close(r));
    }
  });
});

describe('IP allowlist exemptions', () => {
  const from = (cookie: string, ip: string) => ({
    get: (path: string) => as(cookie).call('GET', path, undefined, { 'x-forwarded-for': ip }),
    patch: (path: string, b: unknown) => as(cookie).call('PATCH', path, b, { 'x-forwarded-for': ip }),
    post: (path: string, b: unknown) => as(cookie).call('POST', path, b, { 'x-forwarded-for': ip }),
    del: (path: string) => as(cookie).call('DELETE', path, undefined, { 'x-forwarded-for': ip }),
  });

  it('the owner’s exemption is an owner-console setting (default on); admins exempt people of the account', async () => {
    const on = await from(admin, '203.0.113.5').patch('/security', {
      ip_allowlist: { enabled: true, ranges: ['203.0.113.0/24'] },
    });
    expect(on.status).toBe(200);
    expect((await body(on)).ip_allowlist.exempt_user_ids).toEqual([]);
    const g = await body(
      await from(admin, '203.0.113.5').post('/support-access', { duration_hours: 24, reason: 'locked out' }),
    );
    // Default: the platform owner is not held to it.
    const settings = await body(await t.api(owner).get('/platform/settings'));
    expect(settings.settings.support.owner_ip_exempt).toBe(true);
    expect((await from(owner, '198.51.100.7').get('/accounts/me')).status).toBe(200);
    // Off in the owner console: held like everyone.
    const off = await t.api(owner).patch('/platform/settings', { support: { owner_ip_exempt: false } });
    expect(off.status).toBe(200);
    expect((await from(owner, '198.51.100.7').get('/accounts/me')).status).toBe(403);
    await t.api(owner).patch('/platform/settings', { support: { owner_ip_exempt: true } });
    expect((await from(admin, '203.0.113.5').del(`/support-access/${g.id}`)).status).toBe(200);

    // A person of the account, exempted by the admins.
    expect((await from(bob, '198.51.100.7').get('/accounts/me')).status).toBe(403);
    const ids = Object.fromEntries(
      ((await body(await from(admin, '203.0.113.5').get('/users'))).data as Json[]).map((u) => [u.email, u.user_id]),
    );
    const exempt = await from(admin, '203.0.113.5').patch('/security', {
      ip_allowlist: { exempt_user_ids: [ids['bob@acme.test']] },
    });
    expect(exempt.status).toBe(200);
    expect((await from(bob, '198.51.100.7').get('/accounts/me')).status).toBe(200);
    // Only people of the account.
    const stranger = await from(admin, '203.0.113.5').patch('/security', {
      ip_allowlist: { exempt_user_ids: ['01NOTAMEMBER00000000000000'] },
    });
    expect(stranger.status).toBe(422);
    await from(admin, '203.0.113.5').patch('/security', { ip_allowlist: { enabled: false, exempt_user_ids: [] } });
  });

  it('the owner console sets the durations, the entry email and the emergency wait', async () => {
    const res = await t.api(owner).patch('/platform/settings', {
      support: {
        durations_hours: [2, 1, 2],
        default_duration_hours: 2,
        email_admins_on_entry: false,
        emergency_delay_hours: 48,
      },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).settings.support).toMatchObject({
      durations_hours: [1, 2],
      default_duration_hours: 2,
      email_admins_on_entry: false,
      emergency_delay_hours: 48,
    });
    expect((await body(await as(admin).get('/support-access'))).options).toMatchObject({
      durations_hours: [1, 2],
      default_duration_hours: 2,
    });
    // No entry email now.
    const g = await grant({ duration_hours: 2 });
    const mails = mailsTo('admin@acme.test').length;
    expect((await as(owner).get('/accounts/me')).status).toBe(200);
    expect(mailsTo('admin@acme.test').length).toBe(mails);
    await revoke(g.id);
    const req = await body(
      await t
        .api(owner)
        .post(`/platform/accounts/${acmeId}/emergency-recovery`, { email: 'admin@acme.test', reason: 'x' }),
    );
    expect(Math.round((Date.parse(req.available_at) - Date.parse(req.created_at)) / 3_600_000)).toBe(48);
    await as(admin).post(`/support-access/recovery-requests/${req.id}/cancel`);
    await revokeAll();
  });
});

// ---- TOTP (RFC 6238) ----
function base32(s: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
function totp(secret: Buffer) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
}
