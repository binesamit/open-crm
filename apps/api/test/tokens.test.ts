// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { createClient } from '@bines/sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, apiTokens } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';
import { t as i18n, type MessageKey } from '@bines/shared';
/** A server text in Hebrew from the i18n catalog (ANSWERS 6א.4: the server writes no literal text). */
const he = (key: string, vars?: Record<string, string | number>) => i18n(key as MessageKey, vars, 'he');

/** M6 stage 6 — personal API tokens (06 §1.2–1.3, 1.10). */
let t: TestContext;
let admin: string;
let bob: string; // member
let carol: string; // viewer
let acmeId: string;
let otherId: string;
let boardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
/** A request as Make / n8n send it: the bearer token, no cookie, no Origin. */
const withToken = (
  token: string,
  method: string,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  t.app.request(`/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
const mint = async (cookie: string, scopes: string[], name = 'Make') =>
  body(await t.api(cookie, acmeId).post('/auth/tokens', { name, scopes }));

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'admin@other.test');
  admin = await join('admin@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await t.api(admin, acmeId).post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  const wsId = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
  boardId = (await body(await t.api(admin, acmeId).post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
});
afterAll(() => t.close());

describe('API tokens', () => {
  it('is shown once, stored hashed, listed without the secret', async () => {
    const created = await mint(bob, ['boards:read', 'items:write']);
    expect(created.token).toMatch(/^bos_pat_[0-9A-Za-z]{40}$/);
    expect(created.prefix).toBe(created.token.slice(0, 12));
    const row = (await t.db.select().from(apiTokens).where(eq(apiTokens.id, created.id)))[0]!;
    expect(row.tokenHash).not.toContain(created.token.slice(8));
    const list = await body(await t.api(bob, acmeId).get('/auth/tokens'));
    expect(list.data).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.token);
  });

  it('acts as its user in its own account — no cookie, no account header needed', async () => {
    const { token } = await mint(bob, ['boards:read', 'items:write']);
    const me = await body(await withToken(token, 'GET', '/auth/me'));
    expect(me.user.email).toBe('bob@acme.test');
    expect((await withToken(token, 'GET', `/boards/${boardId}`)).status).toBe(200);
    const res = await withToken(token, 'POST', `/boards/${boardId}/items`, { name: 'From Make' });
    expect(res.status).toBe(201);
    const item = await body(res);
    const ev = (await t.db.select().from(activityLog).where(eq(activityLog.itemId, item.id)))[0]!;
    expect(ev.actorId).toBe((await body(await t.api(bob, acmeId).get('/auth/me'))).user.id);
    // A token never reaches another account, whatever the header says.
    expect((await withToken(token, 'GET', `/boards/${boardId}`, undefined, { 'x-account-id': otherId })).status).toBe(
      404,
    );
  });

  it('is limited to its scopes', async () => {
    const { token } = await mint(bob, ['boards:read']);
    expect((await withToken(token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
    expect((await withToken(token, 'POST', `/boards/${boardId}/items/query`, {})).status).toBe(200); // a read
    const denied = await withToken(token, 'POST', `/boards/${boardId}/items`, { name: 'x' });
    expect(denied.status).toBe(403);
    expect((await body(denied)).error).toMatchObject({
      code: 'insufficient_scope',
      details: { required: 'items:write' },
    });
    expect((await withToken(token, 'GET', `/boards/${boardId}/automations`)).status).toBe(403);
    // Never with a token: managing tokens, the owner console.
    expect((await withToken(token, 'GET', '/auth/tokens')).status).toBe(403);
    expect((await withToken(token, 'POST', '/auth/tokens', { name: 'x', scopes: ['admin'] })).status).toBe(403);
    expect((await withToken(token, 'GET', '/platform/accounts')).status).toBe(403);
  });

  it('still obeys the user: a token cannot do what its user may not', async () => {
    // Bob is a member: "admin" is not his to give; and a viewer cannot make tokens at all.
    expect((await t.api(bob, acmeId).post('/auth/tokens', { name: 'x', scopes: ['admin'] })).status).toBe(403);
    expect((await t.api(carol, acmeId).post('/auth/tokens', { name: 'x', scopes: ['boards:read'] })).status).toBe(403);
    const { token } = await mint(admin, ['admin']);
    expect(
      (await withToken(token, 'POST', '/users/invite', { emails: ['dan@acme.test'], role: 'member' })).status,
    ).toBe(200);
  });

  it('a bad, revoked or expired token is a 401', async () => {
    expect((await withToken('bos_pat_nope', 'GET', '/auth/me')).status).toBe(401);
    const a = await mint(bob, ['boards:read'], 'revoke me');
    expect((await t.api(bob, acmeId).call('DELETE', `/auth/tokens/${a.id}`)).status).toBe(200);
    expect((await withToken(a.token, 'GET', '/auth/me')).status).toBe(401);
    const b = await mint(bob, ['boards:read'], 'expire me');
    await t.db
      .update(apiTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(apiTokens.id, b.id));
    expect((await withToken(b.token, 'GET', '/auth/me')).status).toBe(401);
    // Someone else's token: not found for a member, revocable by an admin.
    const c = await mint(bob, ['boards:read'], 'admin revokes');
    expect((await t.api(carol, acmeId).call('DELETE', `/auth/tokens/${c.id}`)).status).toBe(404);
    expect((await body(await t.api(admin, acmeId).get('/auth/tokens?all=true'))).data.map((x: Json) => x.id)).toContain(
      c.id,
    );
    expect((await t.api(admin, acmeId).call('DELETE', `/auth/tokens/${c.id}`)).status).toBe(200);
  });

  it('has a rate limit per token, with RateLimit headers and Retry-After', async () => {
    const a = await mint(bob, ['boards:read'], 'slow');
    await t.db.update(apiTokens).set({ rateLimitPerMinute: 2 }).where(eq(apiTokens.id, a.id));
    const r1 = await withToken(a.token, 'GET', '/auth/me');
    expect(r1.headers.get('ratelimit-limit')).toBe('2');
    expect(r1.headers.get('ratelimit-remaining')).toBe('1');
    expect((await withToken(a.token, 'GET', '/auth/me')).status).toBe(200);
    const r3 = await withToken(a.token, 'GET', '/auth/me');
    expect(r3.status).toBe(429);
    expect(Number(r3.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('session requests are unchanged (no Authorization header)', async () => {
    const res = await t.app.request(`/api/v1/boards/${boardId}`, {
      headers: { origin: WEB_ORIGIN, cookie: bob, 'x-account-id': acmeId },
    });
    expect(res.status).toBe(200);
  });

  it('the SDK connects with a token (how a script or a bridge uses it)', async () => {
    const { token } = await mint(bob, ['boards:read', 'items:write'], 'sdk');
    const os = createClient({ baseUrl: '', token, fetch: async (url, init) => t.app.request(String(url), init) });
    const item = await os.post<Json>(`/boards/${boardId}/items`, { name: 'via SDK' });
    expect(item.name).toBe('via SDK');
    const items = await os.get<Json>(`/boards/${boardId}/items`);
    expect(items.data.map((x: Json) => x.name)).toContain('via SDK');
  });

  it('can be limited to some boards: the others do not exist for it', async () => {
    const wsId = (await body(await t.api(admin, acmeId).get('/workspaces'))).data[0].id;
    const other = (await body(await t.api(admin, acmeId).post('/boards', { name: 'Finance', workspace_id: wsId }))).id;
    expect(
      (await t.api(bob, acmeId).post('/auth/tokens', { name: 'x', scopes: ['boards:read'], board_ids: ['nope'] }))
        .status,
    ).toBe(422);
    const created = await body(
      await t
        .api(bob, acmeId)
        .post('/auth/tokens', { name: 'Leads only', scopes: ['boards:read', 'items:write'], board_ids: [boardId] }),
    );
    expect(created.board_ids).toEqual([boardId]);
    const { token } = created;
    expect((await withToken(token, 'GET', `/boards/${boardId}/items`)).status).toBe(200);
    expect((await withToken(token, 'GET', `/boards/${other}`)).status).toBe(404);
    expect((await withToken(token, 'POST', `/boards/${other}/items`, { name: 'x' })).status).toBe(404);
    const tree = await body(await withToken(token, 'GET', `/workspaces/${wsId}/tree`));
    expect(tree.boards.map((b: Json) => b.id)).toEqual([boardId]);
  });

  it('service tokens: admins make a service identity; it acts as itself, never as a person', async () => {
    expect(
      (await t.api(bob, acmeId).post('/auth/service-tokens', { name: 'Make', scopes: ['boards:read'] })).status,
    ).toBe(403);
    const created = await body(
      await t.api(admin, acmeId).post('/auth/service-tokens', { name: 'Make', scopes: ['boards:read', 'items:write'] }),
    );
    expect(created.token).toMatch(/^bos_svc_[0-9A-Za-z]{40}$/);
    // No own budget: the account's (else the platform's) service-token default applies (ANSWERS 6א.9).
    expect(created).toMatchObject({
      service: true,
      user_name: he('server.serviceUser', { name: 'Make' }),
      rate_limit_per_minute: null,
      limits: { per_minute: 1200, daily: 50_000 },
    });
    const me = await body(await withToken(created.token, 'GET', '/auth/me'));
    expect(me.user.name).toBe(he('server.serviceUser', { name: 'Make' }));
    const item = await body(
      await withToken(created.token, 'POST', `/boards/${boardId}/items`, { name: 'From the service' }),
    );
    const ev = (await t.db.select().from(activityLog).where(eq(activityLog.itemId, item.id)))[0]!;
    expect(ev.actorId).toBe(created.user_id);
    // A member role: no admin-only actions, whatever its scopes.
    expect(
      (await withToken(created.token, 'POST', '/users/invite', { emails: ['x@acme.test'], role: 'member' })).status,
    ).toBe(403);
    // Not a person: not among the members (people pickers).
    expect((await body(await t.api(admin, acmeId).get('/users'))).data.map((m: Json) => m.name)).not.toContain(
      he('server.serviceUser', { name: 'Make' }),
    );
    // Listed for admins with the account's tokens.
    const all = await body(await t.api(admin, acmeId).get('/auth/tokens?all=true'));
    expect(all.data.find((x: Json) => x.id === created.id)).toMatchObject({ service: true });
  });

  it('Idempotency-Key: a retried POST answers the first result instead of doing it twice', async () => {
    const { token } = await mint(bob, ['boards:read', 'items:write'], 'retry');
    const send = (name: string, key = 'retry-1') =>
      withToken(token, 'POST', `/boards/${boardId}/items`, { name }, { 'idempotency-key': key });
    const first = await send('Once only');
    expect(first.status).toBe(201);
    const a = await body(first);
    const again = await send('Once only');
    expect(again.status).toBe(201);
    expect(again.headers.get('idempotent-replayed')).toBe('true');
    expect((await body(again)).id).toBe(a.id);
    const items = await body(await withToken(token, 'GET', `/boards/${boardId}/items`));
    expect(items.data.filter((i: Json) => i.name === 'Once only')).toHaveLength(1);
    // Same key, another request → 409; a new key runs.
    const clash = await send('Something else');
    expect(clash.status).toBe(409);
    expect((await body(clash)).error.code).toBe('idempotency_conflict');
    expect((await send('Something else', 'retry-2')).status).toBe(201);
    // A rejected request is remembered too (like Stripe): the same key gets the same answer.
    const bad = () => withToken(token, 'POST', `/boards/${boardId}/items`, { name: '' }, { 'idempotency-key': 'k3' });
    expect((await bad()).status).toBe(400);
    const replay = await bad();
    expect(replay.status).toBe(400);
    expect(replay.headers.get('idempotent-replayed')).toBe('true');
  });
});

describe('audit 2026-10-10 security #27 — service token board limits', () => {
  it('refuses boards that are not the account’s, like a personal token does', async () => {
    const res = await t.api(admin, acmeId).post('/auth/service-tokens', {
      name: 'Limited',
      scopes: ['boards:read'],
      board_ids: ['01HZZZZZZZZZZZZZZZZZZZZZZZ'],
    });
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toBe('board_not_found');
  });
});
