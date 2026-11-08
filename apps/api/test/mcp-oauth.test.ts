// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import {
  auth,
  Client,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { activityLog, auditLog, mcpConnections, oauthTokens } from '../src/db/schema';
import { forgetFailedMetadataForTests, setClientMetadataFetcher } from '../src/modules/oauth/oauth.clients';
import { sha256 } from '../src/lib/tokens';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * OAuth 2.1 for MCP (the planning notes "AGENTS-MCP" מ5): discovery (RFC 9728 / RFC 8414), client registration (DCR and
 * Client ID Metadata Documents), authorize → consent (one account, scopes, boards) → PKCE code exchange, rotating
 * refresh tokens with replay detection, revocation, audience binding, account binding, connected-apps list and
 * disconnect, the audit log — and the official MCP SDK client doing the whole dance on its own.
 */
let t: TestContext;
let admin: string;
let bob: string;
let carol: string;
let gina: string;
let multi: string;
let acmeId: string;
let otherId: string;
let leadsId: string;
let secretId: string;
let otherBoardId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const MCP_URL = `${WEB_ORIGIN}/mcp`;
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

const join = async (email: string) => {
  const token = t.inviteTokenFor(email);
  const cookie = t.cookieFrom(await t.signUpWithPassword(email, token))!;
  await t.api(cookie).post('/invitations/accept', { token });
  return cookie;
};
const fetchApp = (url: string | URL | Request, init?: RequestInit) =>
  t.app.request(url instanceof Request ? url : String(url), init) as Promise<Response>;

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};
const postForm = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) =>
  t.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
  });
const register = async (extra: Json = {}) =>
  t.app.request('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], ...extra }),
  });
const authorize = (params: Record<string, string>) =>
  t.app.request(`/oauth/authorize?${new URLSearchParams(params).toString()}`);

/** A registered client (DCR, public). */
const newClient = async () => (await body(await register())).client_id as string;

/** authorize → the consent request id. */
const startFlow = async (clientId: string, extra: Record<string, string> = {}) => {
  const p = pkce();
  const res = await authorize({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: p.challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    resource: MCP_URL,
    scope: 'boards:read items:write',
    ...extra,
  });
  expect(res.status).toBe(302);
  const loc = new URL(res.headers.get('location')!);
  expect(loc.pathname).toBe('/connect');
  return { requestId: loc.searchParams.get('request')!, ...p };
};

const approve = async (cookie: string, requestId: string, input: Json) =>
  t.api(cookie).post(`/oauth-requests/${requestId}/approve`, input);

const exchange = async (clientId: string, code: string, verifier: string, extra: Record<string, string> = {}) =>
  postForm('/oauth/token', {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: REDIRECT,
    resource: MCP_URL,
    ...extra,
  });

/** The whole flow for a person: register (or reuse) a client, consent, exchange → tokens. */
const connectOauth = async (
  cookie: string,
  accountId: string,
  opts: { groups?: string[]; board_ids?: string[]; clientId?: string; scope?: string } = {},
) => {
  const clientId = opts.clientId ?? (await newClient());
  const { requestId, verifier } = await startFlow(clientId, opts.scope ? { scope: opts.scope } : {});
  const ok = await approve(cookie, requestId, {
    account_id: accountId,
    groups: opts.groups ?? ['write'],
    ...(opts.board_ids ? { board_ids: opts.board_ids } : {}),
  });
  expect(ok.status).toBe(200);
  const to = new URL((await body(ok)).redirect_to);
  expect(to.searchParams.get('state')).toBe('st-123');
  expect(to.searchParams.get('iss')).toBe(WEB_ORIGIN);
  const res = await exchange(clientId, to.searchParams.get('code')!, verifier);
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return { clientId, ...(await body(res)) } as Json;
};

/** The connection behind a token response. */
const connOf = async (tok: Json) =>
  (
    await t.db
      .select()
      .from(oauthTokens)
      .where(eq(oauthTokens.tokenHash, sha256(tok.access_token)))
  )[0]!.connectionId;

const connectMcp = async (token: string) => {
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP_URL), {
      fetch: fetchApp,
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
};
const call = async (client: Client, name: string, args: Json = {}) => {
  const res = (await client.callTool({ name, arguments: args })) as Json;
  const parsed = JSON.parse(res.content[0].text);
  return { isError: !!res.isError, data: (res.structuredContent ?? parsed) as Json, error: parsed.error as Json };
};
const mcpStatus = async (token: string) =>
  (
    await t.app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  ).status;

beforeAll(async () => {
  // Many flows from one address: the per-address limits are tested on their own context below.
  t = await createTestContext({ env: { OAUTH_RATE_PER_MIN: '0', OAUTH_REGISTER_PER_HOUR: '0' } });
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const mk = async (name: string, slug: string, email: string) =>
    (
      await body(
        await t.api(owner).post('/platform/accounts', { name, slug, first_admin_email: email, template_set: 'empty' }),
      )
    ).account.id as string;
  acmeId = await mk('Acme', 'acme', 'admin@acme.test');
  otherId = await mk('Other', 'other', 'multi@x.test');
  admin = await join('admin@acme.test');
  multi = await join('multi@x.test');
  const as = t.api(admin, acmeId);
  await as.post('/users/invite', { emails: ['bob@acme.test'], role: 'member' });
  bob = await join('bob@acme.test');
  await as.post('/users/invite', { emails: ['carol@acme.test'], role: 'viewer' });
  carol = await join('carol@acme.test');
  await as.post('/users/invite', { emails: ['gina@outside.test'], role: 'guest' });
  gina = await join('gina@outside.test');
  // multi@x.test: admin of Other, member of Acme — the account binding cases.
  await as.post('/users/invite', { emails: ['multi@x.test'], role: 'member' });
  const inv = t.inviteTokenFor('multi@x.test');
  await t.api(multi).post('/invitations/accept', { token: inv });
  // Viewers may connect too in Acme (read-only); the "admins only" case flips this.
  await as.patch('/ai/settings', { mcp_roles: ['member', 'viewer'] });
  const wsId = (await body(await as.get('/workspaces'))).data[0].id;
  leadsId = (await body(await as.post('/boards', { name: 'Leads', workspace_id: wsId }))).id;
  secretId = (await body(await as.post('/boards', { name: 'Secret plans', workspace_id: wsId }))).id;
  await as.post(`/boards/${leadsId}/items`, { name: 'Dana Levi' });
  const os = t.api(multi, otherId);
  const otherWs = (await body(await os.get('/workspaces'))).data[0].id;
  otherBoardId = (await body(await os.post('/boards', { name: 'Other board', workspace_id: otherWs }))).id;
});
afterAll(() => t.close());
afterEach(() => {
  setClientMetadataFetcher(null);
  forgetFailedMetadataForTests();
});

describe('MCP OAuth — discovery', () => {
  it('serves protected resource metadata (both well-known forms) pointing at our authorization server', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const res = await t.app.request(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      const prm = await body(res);
      expect(prm).toMatchObject({ resource: MCP_URL, authorization_servers: [WEB_ORIGIN] });
      expect(prm.scopes_supported).toContain('boards:read');
      expect(prm.scopes_supported).not.toContain('offline_access');
    }
  });

  it('serves RFC 8414 metadata with PKCE S256, CIMD and the iss parameter', async () => {
    const m = await body(await t.app.request('/.well-known/oauth-authorization-server'));
    expect(m).toMatchObject({
      issuer: WEB_ORIGIN,
      authorization_endpoint: `${WEB_ORIGIN}/oauth/authorize`,
      token_endpoint: `${WEB_ORIGIN}/oauth/token`,
      registration_endpoint: `${WEB_ORIGIN}/oauth/register`,
      revocation_endpoint: `${WEB_ORIGIN}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      grant_types_supported: ['authorization_code', 'refresh_token', 'client_credentials'], // + extension servers (ת6)
    });
  });

  it('a 401 from /mcp names the resource metadata and the scopes', async () => {
    const res = await t.app.request('/mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
    const h = res.headers.get('www-authenticate')!;
    expect(h).toContain(`resource_metadata="${WEB_ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(h).toMatch(/scope="[^"]*boards:read[^"]*"/);
    expect(h).not.toContain('invalid_token');
    expect(await mcpStatus('bos_oat_unknown')).toBe(401);
  });
});

describe('MCP OAuth — client registration', () => {
  it('registers public clients and confidential ones (secret shown once, stored hashed)', async () => {
    const pub = await register();
    expect(pub.status).toBe(201);
    const p = await body(pub);
    expect(p.client_id).toMatch(/^bos_cli_/);
    expect(p.client_secret).toBeUndefined();
    expect(p.token_endpoint_auth_method).toBe('none');
    const conf = await body(await register({ token_endpoint_auth_method: 'client_secret_post' }));
    expect(conf.client_secret).toMatch(/^bos_cs_/);
  });

  it('refuses unsafe redirect URIs', async () => {
    for (const uri of ['http://evil.example/cb', 'javascript:alert(1)', 'https://x.example/cb#frag', 'nope']) {
      const res = await register({ redirect_uris: [uri] });
      expect(res.status).toBe(400);
      expect((await body(res)).error).toBe('invalid_redirect_uri');
    }
    expect((await register({ redirect_uris: ['http://127.0.0.1:33418/callback'] })).status).toBe(201);
    expect((await register({ redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] })).status).toBe(201);
  });

  it('accepts a Client ID Metadata Document and checks it', async () => {
    const id = 'https://chat.example/oauth/client.json';
    setClientMetadataFetcher(async (url) => ({
      status: 200,
      body: JSON.stringify({
        client_id: url,
        client_name: 'Example Chat',
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: 'none',
      }),
    }));
    const { requestId } = await startFlow(id);
    const req = await body(await t.api(bob).get(`/oauth-requests/${requestId}`));
    expect(req.client).toMatchObject({ name: 'Example Chat', host: 'chat.example', kind: 'cimd' });

    // A document whose client_id is not its own URL is refused (error page, no redirect to the client).
    setClientMetadataFetcher(async () => ({
      status: 200,
      body: JSON.stringify({ client_id: 'https://other.example/x.json', client_name: 'X', redirect_uris: [REDIRECT] }),
    }));
    const bad = await authorize({
      response_type: 'code',
      client_id: 'https://evil.example/oauth/client.json',
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    expect(bad.headers.get('location')).toBe(`${WEB_ORIGIN}/connect?error=invalid_client`);
  });
});

describe('MCP OAuth — authorize request validation', () => {
  it('never redirects to an unknown client or an unregistered redirect URI', async () => {
    const unknown = await authorize({ response_type: 'code', client_id: 'bos_cli_nope', redirect_uri: REDIRECT });
    expect(unknown.headers.get('location')).toBe(`${WEB_ORIGIN}/connect?error=invalid_client`);
    const clientId = await newClient();
    const wrong = await authorize({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://claude.ai/api/mcp/other',
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    expect(wrong.headers.get('location')).toBe(`${WEB_ORIGIN}/connect?error=invalid_redirect_uri`);
  });

  it('PKCE S256 and state are mandatory; a foreign resource is refused — errors go back with state + iss', async () => {
    // A verified (CIMD) client gets the RFC redirect with the error; a self-registered one gets our error page
    // (audit 2026-10-10 security #11 — its redirect URI is whatever its registrant typed).
    const clientId = 'https://chat.example/oauth/client.json';
    setClientMetadataFetcher(async (url) => ({
      status: 200,
      body: JSON.stringify({ client_id: url, client_name: 'Chat', redirect_uris: [REDIRECT] }),
    }));
    const base = {
      response_type: 'code',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      state: 'abc',
    };
    const errOf = async (params: Record<string, string>) => {
      const loc = new URL((await authorize(params)).headers.get('location')!);
      expect(loc.origin + loc.pathname).toBe(REDIRECT);
      expect(loc.searchParams.get('iss')).toBe(WEB_ORIGIN);
      return { error: loc.searchParams.get('error'), state: loc.searchParams.get('state') };
    };
    const dcr = await authorize({ ...base, client_id: await newClient(), state: '' });
    expect(dcr.headers.get('location')).toBe(`${WEB_ORIGIN}/connect?error=invalid_request`);
    const { code_challenge: _c, ...noChallenge } = base;
    expect(await errOf(noChallenge)).toEqual({ error: 'invalid_request', state: 'abc' });
    expect((await errOf({ ...base, code_challenge_method: 'plain' })).error).toBe('invalid_request');
    const { state: _s, ...noState } = base;
    expect((await errOf(noState)).error).toBe('invalid_request');
    expect((await errOf({ ...base, resource: 'https://elsewhere.example/mcp' })).error).toBe('invalid_target');
    expect((await errOf({ ...base, response_type: 'token' })).error).toBe('unsupported_response_type');
    // The canonical URI in another case / with a trailing slash is the same resource.
    const ok = await authorize({ ...base, resource: `${MCP_URL.replace('http://localhost', 'HTTP://LOCALHOST')}/` });
    expect(new URL(ok.headers.get('location')!).pathname).toBe('/connect');
  });
});

describe('MCP OAuth — consent, code exchange, account binding', () => {
  it('the consent request lists my accounts and whether each may connect', async () => {
    const { requestId } = await startFlow(await newClient());
    expect((await t.api(undefined).get(`/oauth-requests/${requestId}`)).status).toBe(401);
    const req = await body(await t.api(multi).get(`/oauth-requests/${requestId}`));
    expect(req.client).toMatchObject({ name: 'Claude', kind: 'dcr', host: 'claude.ai' });
    expect(req.redirect_host).toBe('claude.ai');
    expect(req.requested_groups).toEqual(['read', 'write']);
    const ids = req.accounts.map((a: Json) => a.id).sort();
    expect(ids).toEqual([acmeId, otherId].sort());
    expect(req.accounts.every((a: Json) => a.allowed)).toBe(true);
    // Audit 2026-10-10 #3: the request is bound to who opened it first — another person gets 404.
    expect((await t.api(gina).get(`/oauth-requests/${requestId}`)).status).toBe(404);
    expect((await approve(gina, requestId, { account_id: acmeId, groups: [] })).status).toBe(404);
    const own = await startFlow(await newClient());
    const g = await body(await t.api(gina).get(`/oauth-requests/${own.requestId}`));
    expect(g.accounts).toEqual([
      expect.objectContaining({ id: acmeId, allowed: false, reason: 'guests_cannot_use_tokens' }),
    ]);
  });

  it('full flow: consent → PKCE exchange → the token works on /mcp, bound to the chosen account only', async () => {
    const tok = await connectOauth(multi, otherId);
    expect(tok).toMatchObject({ token_type: 'Bearer', expires_in: 3600 });
    expect(tok.access_token).toMatch(/^bos_oat_/);
    expect(tok.refresh_token).toMatch(/^bos_ort_/);
    expect(tok.scope.split(' ')).toEqual(expect.arrayContaining(['boards:read', 'items:write', 'updates:write']));
    expect(tok.scope).not.toContain('automations:write');
    const client = await connectMcp(tok.access_token);
    const me = await call(client, 'whoami');
    expect(me.data).toMatchObject({ user: { email: 'multi@x.test' }, account: { id: otherId }, role: 'admin' });
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain('create_item');
    expect(names).not.toContain('create_automation');
    // The same person's other account does not exist for this connection.
    expect((await call(client, 'get_board', { board_id: leadsId })).error.code).toBe('not_found');
    expect((await call(client, 'get_board', { board_id: otherBoardId })).isError).toBe(false);
    // Writes are marked as coming from the app.
    const created = await call(client, 'create_item', { board_id: otherBoardId, name: 'From Claude' });
    expect(created.isError).toBe(false);
    const ev = (await t.db.select().from(activityLog).where(eq(activityLog.itemId, created.data.id)))[0]!;
    expect((ev.payload as Json).meta).toMatchObject({ via: 'mcp', mcp: { client: 'Claude' } });
    await client.close();
    // Hashed at rest: the token itself is nowhere in the table.
    const rows = await t.db.select().from(oauthTokens);
    expect(rows.some((r) => r.tokenHash === tok.access_token)).toBe(false);
    expect(rows.some((r) => r.tokenHash === sha256(tok.access_token))).toBe(true);
  });

  it('automations and a board limit come from the consent screen', async () => {
    const tok = await connectOauth(admin, acmeId, {
      groups: ['write', 'automations'],
      board_ids: [leadsId],
      scope: 'boards:read items:write automations:write',
    });
    expect(tok.scope).toContain('automations:write');
    const client = await connectMcp(tok.access_token);
    expect((await client.listTools()).tools.map((x) => x.name)).toContain('create_automation');
    const found = await call(client, 'search_boards', { query: 'e' });
    expect(found.data.boards.map((b: Json) => b.id)).toEqual([leadsId]);
    expect((await call(client, 'get_board', { board_id: secretId })).error.code).toBe('not_found');
    await client.close();
  });

  it('refuses what the person may not grant: viewers write, guests, other accounts, foreign boards', async () => {
    const clientId = await newClient();
    // Each person their own request (a request belongs to whoever opened it first — audit #3).
    const fresh = async () => (await startFlow(clientId)).requestId;
    const { requestId } = await startFlow(clientId);
    expect((await approve(carol, requestId, { account_id: acmeId, groups: ['write'] })).status).toBe(403);
    expect((await approve(gina, await fresh(), { account_id: acmeId, groups: [] })).status).toBe(403);
    const bobs = await fresh();
    expect((await approve(bob, bobs, { account_id: otherId, groups: [] })).status).toBe(404);
    const foreign = await approve(bob, bobs, { account_id: acmeId, groups: [], board_ids: [otherBoardId] });
    expect(foreign.status).toBe(422);
    // A viewer may connect read-only.
    const ok = await approve(carol, requestId, { account_id: acmeId, groups: [] });
    expect(ok.status).toBe(200);
    // Decided: the request is gone.
    expect((await approve(carol, requestId, { account_id: acmeId, groups: [] })).status).toBe(404);
  });

  it('members cannot connect when the account allows only admins; MCP off refuses everyone', async () => {
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: [] });
    const { requestId } = await startFlow(await newClient());
    const req = await body(await t.api(bob).get(`/oauth-requests/${requestId}`));
    expect(req.accounts[0]).toMatchObject({ allowed: false, reason: 'mcp_role_not_allowed' });
    expect((await approve(bob, requestId, { account_id: acmeId, groups: [] })).status).toBe(403);
    await t.api(admin, acmeId).patch('/ai/settings', { mcp_roles: ['member', 'viewer'] });
  });

  it('deny sends access_denied back with the state', async () => {
    const { requestId } = await startFlow(await newClient());
    const res = await t.api(bob).post(`/oauth-requests/${requestId}/deny`);
    const to = new URL((await body(res)).redirect_to);
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('state')).toBe('st-123');
    expect(to.searchParams.get('iss')).toBe(WEB_ORIGIN);
  });

  it('the code needs the right verifier, client, redirect and resource — and works once', async () => {
    const clientId = await newClient();
    const other = await newClient();
    const { requestId, verifier } = await startFlow(clientId);
    const to = new URL((await body(await approve(bob, requestId, { account_id: acmeId, groups: [] }))).redirect_to);
    const code = to.searchParams.get('code')!;
    const err = async (res: Response) => ({ status: res.status, error: (await body(res)).error });
    expect(await err(await exchange(clientId, code, pkce().verifier))).toEqual({ status: 400, error: 'invalid_grant' });
    expect(await err(await exchange(other, code, verifier))).toEqual({ status: 400, error: 'invalid_grant' });
    expect(await err(await exchange(clientId, code, verifier, { redirect_uri: 'https://claude.ai/x' }))).toEqual({
      status: 400,
      error: 'invalid_grant',
    });
    expect(await err(await exchange(clientId, code, verifier, { resource: 'https://elsewhere.example/mcp' }))).toEqual({
      status: 400,
      error: 'invalid_target',
    });
    const good = await exchange(clientId, code, verifier);
    expect(good.status).toBe(200);
    const { access_token } = await body(good);
    expect(await mcpStatus(access_token)).toBe(200);
    // A replayed code: refused, and what it produced is revoked.
    expect(await err(await exchange(clientId, code, verifier))).toEqual({ status: 400, error: 'invalid_grant' });
    expect(await mcpStatus(access_token)).toBe(401);
  });

  it('confidential clients must authenticate at the token endpoint', async () => {
    const reg = await body(await register({ token_endpoint_auth_method: 'client_secret_basic' }));
    const { requestId, verifier } = await startFlow(reg.client_id);
    const code = new URL(
      (await body(await approve(bob, requestId, { account_id: acmeId, groups: [] }))).redirect_to,
    ).searchParams.get('code')!;
    const noSecret = await exchange(reg.client_id, code, verifier);
    expect(noSecret.status).toBe(401);
    expect((await body(noSecret)).error).toBe('invalid_client');
    const basic = Buffer.from(`${reg.client_id}:${reg.client_secret}`).toString('base64');
    const ok = await postForm(
      '/oauth/token',
      { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT },
      { authorization: `Basic ${basic}` },
    );
    expect(ok.status).toBe(200);
  });
});

describe('MCP OAuth — tokens: audience, refresh, revocation, disconnect', () => {
  it('an access token is for /mcp only: the REST API refuses it, and a token for another resource is refused', async () => {
    const tok = await connectOauth(bob, acmeId);
    const rest = await t.app.request('/api/v1/boards', {
      headers: { authorization: `Bearer ${tok.access_token}`, 'x-account-id': acmeId },
    });
    expect(rest.status).toBe(401);
    expect(await mcpStatus(tok.access_token)).toBe(200);
    await t.db
      .update(oauthTokens)
      .set({ resource: 'https://other-server.example/mcp' })
      .where(eq(oauthTokens.tokenHash, sha256(tok.access_token)));
    expect(await mcpStatus(tok.access_token)).toBe(401);
  });

  it('refresh rotates; a replayed refresh token ends the connection', async () => {
    const tok = await connectOauth(bob, acmeId);
    const r1 = await postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: tok.clientId,
      resource: MCP_URL,
    });
    expect(r1.status).toBe(200);
    const next = await body(r1);
    expect(next.refresh_token).not.toBe(tok.refresh_token);
    expect(await mcpStatus(next.access_token)).toBe(200);
    // Asking for more than was consented is refused.
    const wider = await postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: next.refresh_token,
      client_id: tok.clientId,
      scope: 'automations:write',
    });
    expect((await body(wider)).error).toBe('invalid_scope');
    // The old refresh token again: replay → the whole connection is revoked.
    const replay = await postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: tok.clientId,
    });
    expect((await body(replay)).error).toBe('invalid_grant');
    expect(await mcpStatus(next.access_token)).toBe(401);
    const audit = await t.db.select().from(auditLog).where(eq(auditLog.action, 'mcp.token_replay'));
    expect(audit.length).toBeGreaterThan(0);
  });

  it('revocation (RFC 7009): an access token alone, or the refresh token = the whole connection', async () => {
    const tok = await connectOauth(bob, acmeId);
    const r = await postForm('/oauth/revoke', { token: tok.access_token, client_id: tok.clientId });
    expect(r.status).toBe(200);
    expect(await mcpStatus(tok.access_token)).toBe(401);
    // Another client cannot revoke it; unknown tokens answer 200 all the same.
    const tok2 = await connectOauth(bob, acmeId);
    expect((await postForm('/oauth/revoke', { token: tok2.access_token, client_id: await newClient() })).status).toBe(
      200,
    );
    expect(await mcpStatus(tok2.access_token)).toBe(200);
    expect((await postForm('/oauth/revoke', { token: 'bos_ort_nope', client_id: tok2.clientId })).status).toBe(200);
    await postForm('/oauth/revoke', { token: tok2.refresh_token, client_id: tok2.clientId });
    expect(await mcpStatus(tok2.access_token)).toBe(401);
    const conn = (
      await t.db
        .select()
        .from(mcpConnections)
        .where(eq(mcpConnections.id, await connOf(tok2)))
    )[0]!;
    expect(conn.revokedAt).not.toBeNull();
  });

  it('connected apps: listed per person, admins see everyone, disconnect stops the token at once (audited)', async () => {
    const mine = await connectOauth(bob, acmeId);
    const admins = await connectOauth(admin, acmeId);
    const mineId = await connOf(mine);
    const list = await body(await t.api(bob, acmeId).get('/mcp-connections'));
    const bobId = list.data.find((c: Json) => c.id === mineId).user_id;
    expect(list.data.every((c: Json) => c.user_id === bobId)).toBe(true);
    expect(list.data.find((c: Json) => c.id === mineId)).toMatchObject({
      client_name: 'Claude',
      client_host: 'claude.ai',
      board_ids: null,
    });
    expect((await t.api(bob, acmeId).get('/mcp-connections?all=true')).status).toBe(403);
    const all = await body(await t.api(admin, acmeId).get('/mcp-connections?all=true'));
    const adminsId = await connOf(admins);
    const adminsConn = all.data.find((c: Json) => c.id === adminsId);
    expect(adminsConn).toBeDefined();
    expect(all.data.some((c: Json) => c.id === mineId)).toBe(true);
    // A member cannot disconnect someone else's app; a guest has none.
    expect((await t.api(bob, acmeId).del(`/mcp-connections/${adminsConn.id}`)).status).toBe(404);
    expect((await t.api(gina, acmeId).get('/mcp-connections')).status).toBe(403);
    // Not with an API token.
    const pat = (await body(await t.api(admin, acmeId).post('/auth/tokens', { name: 'x', scopes: ['admin'] }))).token;
    const viaPat = await t.app.request('/api/v1/mcp-connections', { headers: { authorization: `Bearer ${pat}` } });
    expect(viaPat.status).toBe(403);
    // Disconnect (my own; then the admin disconnects bob's next one).
    expect((await t.api(bob, acmeId).del(`/mcp-connections/${mineId}`)).status).toBe(200);
    expect(await mcpStatus(mine.access_token)).toBe(401);
    expect(await mcpStatus(admins.access_token)).toBe(200);
    expect((await body(await t.api(bob, acmeId).get('/mcp-connections'))).data.some((c: Json) => c.id === mineId)).toBe(
      false,
    );
    const again = await connectOauth(bob, acmeId);
    expect((await t.api(admin, acmeId).del(`/mcp-connections/${await connOf(again)}`)).status).toBe(200);
    expect(await mcpStatus(again.access_token)).toBe(401);
    const actions = (await t.db.select().from(auditLog).where(eq(auditLog.accountId, acmeId))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['mcp.connected', 'mcp.disconnected']));
  });

  it('reconnecting the same app to the same account replaces the old connection', async () => {
    const clientId = await newClient();
    const first = await connectOauth(bob, acmeId, { clientId });
    const second = await connectOauth(bob, acmeId, { clientId });
    expect(await mcpStatus(first.access_token)).toBe(401);
    expect(await mcpStatus(second.access_token)).toBe(200);
  });

  it("a viewer's connection gets the read tools only", async () => {
    const tok = await connectOauth(carol, acmeId, { groups: [] });
    const client = await connectMcp(tok.access_token);
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).not.toContain('create_item');
    await client.close();
  });
});

describe('MCP OAuth — the official SDK client', () => {
  it('discovers, registers, authorizes with PKCE + resource, exchanges and calls tools on its own', async () => {
    let redirectedTo: URL | null = null;
    let verifier = '';
    let tokens: Json | undefined;
    let info: Json | undefined;
    const provider: OAuthClientProvider = {
      get redirectUrl() {
        return REDIRECT;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: 'SDK test',
          redirect_uris: [REDIRECT],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
        };
      },
      clientInformation: () => info as never,
      saveClientInformation: (i) => {
        info = i as Json;
      },
      tokens: () => tokens as never,
      saveTokens: (x) => {
        tokens = x as Json;
      },
      redirectToAuthorization: (url) => {
        redirectedTo = url;
      },
      saveCodeVerifier: (v) => {
        verifier = v;
      },
      codeVerifier: () => verifier,
      // We require state (CSRF protection on the client's callback).
      state: () => 'sdk-state',
    };
    expect(await auth(provider, { serverUrl: MCP_URL, fetchFn: fetchApp })).toBe('REDIRECT');
    const authUrl = redirectedTo! as URL;
    expect(authUrl.searchParams.get('resource')).toBe(MCP_URL);
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256');
    // The browser: our authorize endpoint → consent → the app's callback.
    const res = await t.app.request(`${authUrl.pathname}${authUrl.search}`);
    const requestId = new URL(res.headers.get('location')!).searchParams.get('request')!;
    const to = new URL(
      (await body(await approve(bob, requestId, { account_id: acmeId, groups: ['write'] }))).redirect_to,
    );
    expect(
      await auth(provider, {
        serverUrl: MCP_URL,
        fetchFn: fetchApp,
        authorizationCode: to.searchParams.get('code')!,
        iss: to.searchParams.get('iss')!,
      }),
    ).toBe('AUTHORIZED');
    expect(tokens!.access_token).toMatch(/^bos_oat_/);
    const client = new Client({ name: 'sdk-oauth', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: fetchApp, authProvider: provider }),
    );
    const me = await client.callTool({ name: 'whoami', arguments: {} });
    expect(JSON.stringify(me.structuredContent)).toContain('bob@acme.test');
    await client.close();
  });
});

describe('MCP OAuth — rate limits', () => {
  // Boots its own PGlite (all migrations) inside the test, which under a loaded runner exceeds the 30s test timeout.
  it('limits registrations and token calls per client address', async () => {
    const own = await createTestContext({ env: { OAUTH_RATE_PER_MIN: '3', OAUTH_REGISTER_PER_HOUR: '2' } });
    try {
      const reg = () =>
        own.app.request('/oauth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ redirect_uris: [REDIRECT] }),
        });
      expect((await reg()).status).toBe(201);
      expect((await reg()).status).toBe(201);
      const third = await reg();
      expect(third.status).toBe(429);
      expect(third.headers.get('retry-after')).toBeTruthy();
      const token = () =>
        own.app.request('/oauth/token', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'grant_type=refresh_token&refresh_token=x&client_id=y',
        });
      for (let i = 0; i < 3; i++) expect((await token()).status).toBe(401);
      expect((await token()).status).toBe(429);
    } finally {
      await own.close();
    }
  }, 120_000);
});

describe('MCP OAuth — audit 2026-10-10 lows (#11 pre-consent errors, #24 metadata fetch)', () => {
  it('a self-registered (DCR) client gets pre-consent errors on our page, never a 302 to its own URI', async () => {
    const clientId = await newClient();
    const res = await authorize({
      response_type: 'token',
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      state: 's',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${WEB_ORIGIN}/connect?error=unsupported_response_type`);
  });

  it('a metadata URL that failed is not fetched again for a while', async () => {
    let fetches = 0;
    setClientMetadataFetcher(async () => {
      fetches++;
      throw new Error('connection refused');
    });
    const params = {
      response_type: 'code',
      client_id: 'https://down.example/oauth/client.json',
      redirect_uri: REDIRECT,
      code_challenge: pkce().challenge,
      code_challenge_method: 'S256',
      state: 's',
    };
    for (let i = 0; i < 3; i++)
      expect((await authorize(params)).headers.get('location')).toBe(`${WEB_ORIGIN}/connect?error=invalid_client`);
    expect(fetches).toBe(1);
  });
});
