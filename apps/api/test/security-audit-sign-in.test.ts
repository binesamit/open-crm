// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@bines/shared';
import { authSessions, automations, columns, supportAccessGrants, supportStaff, users } from '../src/db/schema';
import type { Db } from '../src/db/client';
import { personActor } from '../src/modules/ai2/context';
import type { AutomationRow } from '../src/modules/automations/automations.repo';
import { automationActor, memberActor } from '../src/modules/automations/engine/context';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Security audit (docs/SECURITY-REVIEW.md S-52 … S-59)
 * - S-52 an account admin never takes over the sign-in of someone whose sign-in opens more than the account
 *   (support staff, a support grantee or an invitee of another account);
 * - S-53 the account's 2FA requirement holds for OAuth consent, MCP connections and personal API tokens;
 * - S-54 an edit support grant never sets up an outgoing channel (webhooks, outbound automation actions, owner);
 * - S-55 a file in a column hidden from me is not mine to download; S-56 a form's logo is the saver's own upload;
 * - S-57 failed inbound-hook attempts are limited per address only; S-58 a self-registered OAuth app is "unverified".
 */
let t: TestContext;
let owner: string;
let admin: string;
let bob: string;
let acmeId: string;
let otherId: string;
let polId: string;
let boardId: string;
let ids: Record<string, string> = {};
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const as = (cookie: string, accountId = acmeId) => t.api(cookie, accountId);

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const newAccount = async (name: string, slug: string, email: string) => {
  const created = await body(
    await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
  );
  return { id: created.account.id as string, cookie: await join(email) };
};
const refreshIds = async () => {
  const list = (await body(await as(admin).get('/users'))).data as Json[];
  ids = Object.fromEntries(list.map((u) => [u.email, u.user_id]));
};
const reason = async (res: Response) => (await body(res)).error.message as string;

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  ({ id: acmeId, cookie: admin } = await newAccount('Acme', 'acme', 'admin@acme.test'));
  const other = await newAccount('Other', 'other', 'boss@other.test');
  otherId = other.id;
  for (const email of ['bob@acme.test', 'staffy@acme.test', 'granty@acme.test', 'invitee@acme.test', 'plain@acme.test'])
    await as(admin).post('/users/invite', { emails: [email], role: 'member' });
  bob = await join('bob@acme.test');
  for (const email of ['staffy@acme.test', 'granty@acme.test', 'invitee@acme.test', 'plain@acme.test'])
    await join(email);
  await refreshIds();
  const bossId = (await body(await t.api(other.cookie).get('/auth/me'))).user.id as string;

  // staffy is platform support staff (an unverified address still counts).
  await t.db.insert(supportStaff).values({ id: newId(), email: 'Staffy@acme.test', role: 'agent', status: 'active' });
  // granty holds a live email support grant to Other.
  await t.db.insert(supportAccessGrants).values({
    id: newId(),
    accountId: otherId,
    grantedBy: bossId,
    granteeKind: 'email',
    grantedToEmail: 'granty@acme.test',
    scope: 'read',
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  // invitee has a pending invitation to Other.
  expect(
    (await t.api(other.cookie, otherId).post('/users/invite', { emails: ['invitee@acme.test'], role: 'member' }))
      .status,
  ).toBeLessThan(300);

  const ws = (await body(await as(admin).get('/workspaces'))).data[0].id;
  boardId = (await body(await as(admin).post('/boards', { name: 'Leads', workspace_id: ws }))).id;
});
afterAll(() => t.close());

describe('S-52 an admin never takes over a sign-in that opens more than the account', () => {
  const guarded = [
    ['staffy@acme.test', 'support_staff'],
    ['granty@acme.test', 'support_grant_elsewhere'],
    ['invitee@acme.test', 'invited_elsewhere'],
  ] as const;

  it('recovery link: refused for support staff, a grantee and an invitee elsewhere; a plain member gets one', async () => {
    for (const [email, why] of guarded) {
      const res = await as(admin).post(`/users/${ids[email]}/recovery-link`);
      expect(res.status, email).toBe(403);
      expect(await reason(res)).toBe(why);
    }
    expect((await as(admin).post(`/users/${ids['plain@acme.test']}/recovery-link`)).status).toBe(200);
  });

  it('2FA reset: the same rule', async () => {
    for (const email of ['staffy@acme.test', 'granty@acme.test', 'invitee@acme.test', 'plain@acme.test'])
      await t.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, ids[email]!));
    for (const [email, why] of guarded) {
      const res = await as(admin).post(`/users/${ids[email]}/reset-2fa`);
      expect(res.status, email).toBe(403);
      expect(await reason(res)).toBe(why);
    }
    expect((await as(admin).post(`/users/${ids['plain@acme.test']}/reset-2fa`)).status).toBe(200);
  });

  it('a revoked or expired grant no longer protects', async () => {
    await t.db
      .update(supportAccessGrants)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(supportAccessGrants.grantedToEmail, 'granty@acme.test'));
    expect((await as(admin).post(`/users/${ids['granty@acme.test']}/recovery-link`)).status).toBe(200);
  });

  it('deactivation keeps the sessions of support staff; deleting their details is refused', async () => {
    const staffyId = ids['staffy@acme.test']!;
    const before = await t.db.select().from(authSessions).where(eq(authSessions.userId, staffyId));
    expect(before.length).toBeGreaterThan(0);
    expect((await as(admin).post(`/users/${staffyId}/deactivate`)).status).toBe(200);
    expect((await t.db.select().from(authSessions).where(eq(authSessions.userId, staffyId))).length).toBe(
      before.length,
    );
    const del = await as(admin).del(`/users/${staffyId}/details`);
    expect(del.status).toBe(403);
    expect(await reason(del)).toBe('support_staff');
    // A plain member: deactivated → signed out → details deleted.
    const plainId = ids['plain@acme.test']!;
    expect((await as(admin).post(`/users/${plainId}/deactivate`)).status).toBe(200);
    expect((await t.db.select().from(authSessions).where(eq(authSessions.userId, plainId))).length).toBe(0);
    expect((await as(admin).del(`/users/${plainId}/details`)).status).toBe(200);
  });
});

// ---- OAuth helpers (as mcp-oauth.test.ts) ----
const MCP_URL = `${WEB_ORIGIN}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const newClient = async () =>
  (
    await body(
      await t.app.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT] }),
      }),
    )
  ).client_id as string;
const startFlow = async (clientId: string) => {
  const p = pkce();
  const res = await t.app.request(
    `/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: p.challenge,
      code_challenge_method: 'S256',
      state: 'st',
      resource: MCP_URL,
      scope: 'boards:read',
    }).toString()}`,
  );
  expect(res.status).toBe(302);
  return { requestId: new URL(res.headers.get('location')!).searchParams.get('request')!, ...p };
};
const connectOauth = async (cookie: string, accountId: string) => {
  const clientId = await newClient();
  const { requestId, verifier } = await startFlow(clientId);
  const ok = await t.api(cookie).post(`/oauth-requests/${requestId}/approve`, { account_id: accountId, groups: [] });
  expect(ok.status).toBe(200);
  const code = new URL((await body(ok)).redirect_to).searchParams.get('code')!;
  const res = await t.app.request('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
      resource: MCP_URL,
    }).toString(),
  });
  expect(res.status).toBe(200);
  return (await body(res)).access_token as string;
};
const mcpCall = (bearer: string) =>
  t.app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
const restWithToken = (token: string) =>
  t.app.request('/api/v1/workspaces', { headers: { authorization: `Bearer ${token}` } });

describe('S-53 the account’s 2FA requirement holds for OAuth, MCP and personal tokens', () => {
  let polAdmin: string;
  let pm: string;
  let pmId: string;
  let pat: string;
  let oat: string;

  beforeAll(async () => {
    ({ id: polId, cookie: polAdmin } = await newAccount('Policy', 'policy', 'admin@pol.test'));
    await as(polAdmin, polId).post('/users/invite', { emails: ['pm@pol.test'], role: 'member' });
    pm = await join('pm@pol.test');
    pmId = (await body(await t.api(pm).get('/auth/me'))).user.id;
    // Made before the policy.
    pat = (await body(await as(pm, polId).post('/auth/tokens', { name: 'cli', scopes: ['boards:read'] }))).token;
    oat = await connectOauth(pm, polId);
    expect((await restWithToken(pat)).status).toBe(200);
    expect((await mcpCall(pat)).status).not.toBe(403);
    expect((await mcpCall(oat)).status).not.toBe(403);
    const set = await as(polAdmin, polId).patch('/security', { two_factor: { mode: 'required_all', grace_days: 0 } });
    expect(set.status).toBe(200);
  });

  it('a personal token stops with two_factor_required (REST and MCP); an OAuth connection made before stops too', async () => {
    const rest = await restWithToken(pat);
    expect(rest.status).toBe(403);
    expect(await reason(rest)).toBe('two_factor_required');
    for (const bearer of [pat, oat]) {
      const res = await mcpCall(bearer);
      expect(res.status).toBe(403);
      expect(await reason(res)).toBe('two_factor_required');
    }
  });

  it('a new consent: the account is marked two_factor_required and approving it is refused', async () => {
    const { requestId } = await startFlow(await newClient());
    const req = await body(await t.api(pm).get(`/oauth-requests/${requestId}`));
    expect(req.accounts.find((a: Json) => a.id === polId)).toMatchObject({
      allowed: false,
      reason: 'two_factor_required',
    });
    const res = await t.api(pm).post(`/oauth-requests/${requestId}/approve`, { account_id: polId, groups: [] });
    expect(res.status).toBe(403);
    expect(await reason(res)).toBe('two_factor_required');
  });

  it('once the person turns 2FA on, the token and the connection work again', async () => {
    await t.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, pmId));
    expect((await restWithToken(pat)).status).toBe(200);
    expect((await mcpCall(pat)).status).not.toBe(403);
    expect((await mcpCall(oat)).status).not.toBe(403);
  });
});

describe('S-54 an edit support grant never sets up an outgoing channel', () => {
  let support: ReturnType<typeof as>;
  let hookId: string;
  let autoId: string;
  const hookAction = { type: 'webhook', url: 'https://hooks.example.com/abc' };

  beforeAll(async () => {
    await as(admin).patch('/security', { support_access: { allow_edit: true } });
    const g = await as(admin).post('/support-access', { mode: 'edit', duration_hours: 24, reason: 'audit test' });
    expect(g.status).toBe(201);
    support = as(owner);
    const hook = await as(admin).post(`/boards/${boardId}/webhooks`, {
      url: 'http://127.0.0.1:9/hook',
      event: 'item_created',
      skip_handshake: true,
    });
    expect(hook.status).toBe(201);
    hookId = (await body(hook)).id;
    const auto = await as(admin).post(`/boards/${boardId}/automations`, {
      recipe: { trigger: { type: 'item_created' }, actions: [hookAction] },
    });
    expect(auto.status).toBe(201);
    autoId = (await body(auto)).id;
  });

  it('S-65: MCP servers and AI connections — never added by support access (they would outlive it)', async () => {
    const server = await support.post('/mcp-servers', {
      key: 'evil',
      name: 'Evil',
      url: 'https://mcp.example.com/mcp',
    });
    expect(server.status).toBe(403);
    expect(await reason(server)).toBe('support_not_allowed');
    const conn = await support.post('/ai/connections', {
      name: 'Evil',
      provider: 'openai_compatible',
      base_url: 'https://llm.example.com/v1',
      api_key: 'sk-evil-0000000000',
    });
    expect(conn.status).toBe(403);
  });

  it('webhooks: create, change and rotate are refused; reading works', async () => {
    const create = await support.post(`/boards/${boardId}/webhooks`, {
      url: 'http://127.0.0.1:9/evil',
      event: 'item_created',
      skip_handshake: true,
    });
    expect(create.status).toBe(403);
    expect(await reason(create)).toBe('support_not_allowed');
    const patch = await support.patch(`/webhooks/${hookId}`, { url: 'http://127.0.0.1:9/evil', skip_handshake: true });
    expect(patch.status).toBe(403);
    expect((await support.post(`/webhooks/${hookId}/rotate-secret`)).status).toBe(403);
    expect((await support.get(`/webhooks/${hookId}`)).status).toBe(200);
  });

  it('automations: no new or changed outbound action, no owner change; everything else still works', async () => {
    for (const action of [
      { type: 'webhook', url: 'https://evil.example.com/x' },
      { type: 'send_email', to: ['x@evil.example.com'], subject: 's', body_html: 'b' },
    ]) {
      const res = await support.post(`/boards/${boardId}/automations`, {
        recipe: { trigger: { type: 'item_created' }, actions: [action] },
      });
      expect(res.status, action.type).toBe(403);
      expect(await reason(res)).toBe('support_not_allowed');
    }
    // A normal automation is a normal edit.
    const plain = await support.post(`/boards/${boardId}/automations`, {
      recipe: { trigger: { type: 'item_created' }, actions: [{ type: 'archive_item' }] },
    });
    expect(plain.status).toBe(201);
    // The existing webhook action as it is: saving (e.g. a new title) is fine.
    expect(
      (
        await support.patch(`/automations/${autoId}`, {
          title: 'renamed',
          recipe: { trigger: { type: 'item_created' }, actions: [hookAction] },
        })
      ).status,
    ).toBe(200);
    // Pointing it elsewhere is not.
    const moved = await support.patch(`/automations/${autoId}`, {
      recipe: { trigger: { type: 'item_created' }, actions: [{ ...hookAction, url: 'https://evil.example.com/y' }] },
    });
    expect(moved.status).toBe(403);
    expect(await reason(moved)).toBe('support_not_allowed');
    const owned = await support.patch(`/automations/${autoId}`, { owner_id: ids['bob@acme.test'] });
    expect(owned.status).toBe(403);
    expect(await reason(owned)).toBe('support_not_allowed');
    // Removing the outbound action is allowed.
    expect(
      (
        await support.patch(`/automations/${autoId}`, {
          recipe: { trigger: { type: 'item_created' }, actions: [{ type: 'archive_item' }] },
        })
      ).status,
    ).toBe(200);
    const row = (await t.db.select().from(automations).where(eq(automations.id, autoId)))[0]!;
    expect(row.ownerId).not.toBe(ids['bob@acme.test']);
  });

  it('tokens, OAuth / MCP servers, flow connections and extensions stay session-only (refused)', async () => {
    for (const [method, path] of [
      ['POST', '/auth/tokens'],
      ['POST', '/auth/service-tokens'],
      ['POST', '/mcp-servers'],
      ['POST', '/flow-connections'],
      ['POST', '/extensions/install'],
    ] as const) {
      const res = await support.call(method, path, {});
      expect(res.status, path).toBe(403);
    }
  });
});

describe('Low findings', () => {
  const upload = async (cookie: string, name: string) => {
    const pre = await body(await as(cookie).post('/files/presign', { name, size: 100, mime: 'image/png' }));
    const key = (
      await t.db.execute<{ storage_key: string }>(sql`select storage_key from assets where id = ${pre.file_id}`)
    ).rows[0]!.storage_key;
    t.storage.markUploaded(key, 100, 'image/png');
    expect((await as(cookie).post(`/files/${pre.file_id}/complete`)).status).toBe(200);
    return pre.file_id as string;
  };

  it('S-55 a file in a column hidden from me is not reachable through GET /files/:id', async () => {
    await as(admin).post(`/boards/${boardId}/columns`, { id: 'docs', title: 'מסמכים', type: 'file' });
    const itemId = (await body(await as(admin).post(`/boards/${boardId}/items`, { name: 'חוזה' }))).id;
    const fileId = await upload(admin, 'contract.png');
    expect((await as(admin).post(`/items/${itemId}/cells/docs/files`, { file_ids: [fileId] })).status).toBe(200);
    expect((await as(bob).get(`/files/${fileId}`)).status).toBe(200);
    await t.db
      .update(columns)
      .set({ restrictedView: { users: [ids['admin@acme.test']!], teams: [] } })
      .where(and(eq(columns.boardId, boardId), eq(columns.key, 'docs')));
    expect((await as(bob).get(`/items/${itemId}`)).status).toBe(200);
    expect((await as(bob).get(`/files/${fileId}`)).status).toBe(404);
    expect((await as(admin).get(`/files/${fileId}`)).status).toBe(200);
  });

  it('S-56 a form’s logo / cover is the saver’s own upload, never another file of the account', async () => {
    const viewId = (await body(await as(admin).post(`/boards/${boardId}/views`, { type: 'form', name: 'טופס' }))).id;
    expect((await as(admin).get(`/views/${viewId}/form`)).status).toBe(200); // opens the form
    const bobs = await upload(bob, 'private.png');
    const theirs = await as(admin).patch(`/views/${viewId}/form`, { settings: { logo_asset_id: bobs } });
    expect(theirs.status).toBe(422);
    const mine = await upload(admin, 'logo.png');
    expect((await as(admin).patch(`/views/${viewId}/form`, { settings: { cover_asset_id: mine } })).status).toBe(200);
  });

  it('S-57 failed inbound-hook attempts from many addresses never lock out the real caller', async () => {
    const id = newId();
    const secret = 'the-right-secret-456';
    await t.db.insert(automations).values({
      id,
      accountId: acmeId,
      boardId,
      title: 'inbound',
      recipe: { trigger: { type: 'webhook_in', secret }, actions: [{ type: 'set_item_name', name: 'x' }] } as never,
      isActive: true,
      ownerId: ids['admin@acme.test']!,
      createdBy: ids['admin@acme.test']!,
    });
    const inbound = (s: string, ip: string) =>
      t.app.request(`/api/v1/hooks/in/${id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, 'x-bines-secret': s },
        body: '{}',
      });
    for (let i = 0; i < 25; i++) expect((await inbound('wrong-guess', `198.51.100.${i + 1}`)).status).toBe(401);
    expect((await inbound(secret, '192.0.2.77')).status).toBe(202);
  });

  it('S-58 a self-registered OAuth app is marked unverified on the consent screen', async () => {
    const { requestId } = await startFlow(await newClient());
    const req = await body(await t.api(bob).get(`/oauth-requests/${requestId}`));
    expect(req.client).toMatchObject({ kind: 'dcr', verified: false });
  });

  it('S-59 background actors (automations, AI) never carry the platform-owner flag', async () => {
    const bobId = ids['bob@acme.test']!;
    await t.db.update(users).set({ isPlatformOwner: true }).where(eq(users.id, bobId));
    try {
      const db = t.db as unknown as Db;
      const row = { accountId: acmeId, ownerId: bobId, createdBy: bobId } as AutomationRow;
      const auto = await automationActor(db, row, 'run-1');
      expect(auto.user.isPlatformOwner).toBe(false);
      expect((await personActor(db, acmeId, bobId, 'req-1')).user.isPlatformOwner).toBe(false);
      const adminActor = await automationActor(
        db,
        { ...row, ownerId: ids['admin@acme.test']!, createdBy: ids['admin@acme.test']! } as AutomationRow,
        'run-2',
      );
      expect((await memberActor(db, adminActor, bobId)).actor!.user.isPlatformOwner).toBe(false);
    } finally {
      await t.db.update(users).set({ isPlatformOwner: false }).where(eq(users.id, bobId));
    }
  });
});
