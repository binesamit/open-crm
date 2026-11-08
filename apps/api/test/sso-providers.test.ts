// SPDX-License-Identifier: AGPL-3.0-only
import { eq, like } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authSessions, authVerifications, platformSettings, users } from '../src/db/schema';
import { createSecretBox } from '../src/lib/secrets';
import {
  buildSocialProviders,
  classifyTokenAnswer,
  MICROSOFT_CONSUMER_TENANT,
  microsoftEmailVerified,
  resolveProviders,
} from '../src/modules/platform/login-providers';
import { signInMethodOf } from '../src/auth/sign-in-method';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Plan — sign-in providers (owner console → "ספקי התחברות") and the account's SSO policy
 * - the owner saves Google / Microsoft credentials; the secret is sealed and never returned;
 * - GET /auth/config and Better Auth follow the console at once (no restart), the environment is the fallback;
 * - Microsoft's provider shape (tenant, return address, scopes, no photo);
 * - the provider's callback still needs an invitation and a provider-verified email, and still asks for the code
 *   of a person with two-factor on — the session that follows remembers which door it came through;
 * - "test connection" reads the provider's answer;
 * - an account may require Google / Microsoft sign-in: 403 sso_required for other sessions, never locking out the
 *   admin who saves it, the platform owner always exempt.
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const GOOGLE_SECRET = 'GOCSPX-super-secret-value-1234';
const MS_SECRET = 'ms~secret~value~abcd';

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((c) => !c.endsWith('='));
const authCall = (path: string, payload: unknown, cookie?: string) =>
  t.app.request(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(payload),
  });
const config = async () => body(await t.app.request('/api/v1/auth/config'));
const providers = async () => (await body(await t.api(owner).get('/platform/login-providers'))).data as Json[];
const providerOf = async (id: string) => (await providers()).find((p) => p.provider === id)!;

// ---- a provider's token endpoint, played here (no network) ----
const jwt = (claims: Record<string, unknown>) =>
  [{ alg: 'RS256', typ: 'JWT' }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.') +
  '.signature';
let nextClaims: Record<string, unknown> = {};
let tokenAnswer: { status: number; body: Record<string, unknown> } | null = null;
const realFetch = globalThis.fetch;
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/oauth2\.googleapis\.com\/token|login\.microsoftonline\.com\/.+\/token/.test(url)) {
    if (tokenAnswer)
      return new Response(JSON.stringify(tokenAnswer.body), {
        status: tokenAnswer.status,
        headers: { 'content-type': 'application/json' },
      });
    const now = Math.floor(Date.now() / 1000);
    return Response.json({
      access_token: 'access-token',
      token_type: 'Bearer',
      expires_in: 3600,
      id_token: jwt({ iat: now, exp: now + 3600, ...nextClaims }),
    });
  }
  return realFetch(input, init);
});

/** The whole provider round trip: /sign-in/social → (provider) → /callback/:id with the state and its cookies. */
const providerSignIn = async (provider: 'google' | 'microsoft', claims: Record<string, unknown>) => {
  const start = await authCall('/sign-in/social', {
    provider,
    callbackURL: '/',
    errorCallbackURL: '/login',
  });
  expect(start.status).toBe(200);
  const { url } = await body(start);
  const state = new URL(url as string).searchParams.get('state')!;
  nextClaims = claims;
  const res = await t.app.request(`/api/auth/callback/${provider}?code=the-code&state=${encodeURIComponent(state)}`, {
    headers: { origin: WEB_ORIGIN, cookie: cookiesOf(start).join('; ') },
  });
  const session = t.cookieFrom(res);
  return { res, location: res.headers.get('location') ?? '', cookie: session?.endsWith('=') ? undefined : session };
};
const googleClaims = (email: string, verified = true) => ({
  sub: `g-${email}`,
  email,
  email_verified: verified,
  name: email.split('@')[0],
});
const sessionsOf = async (email: string) => {
  const u = (await t.db.select().from(users).where(eq(users.email, email)))[0];
  return u ? t.db.select().from(authSessions).where(eq(authSessions.userId, u.id)) : [];
};

beforeAll(async () => {
  vi.stubGlobal('fetch', fakeFetch);
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  acmeId = (
    await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    )
  ).account.id as string;
  const token = t.inviteTokenFor('admin@acme.test');
  admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', token))!;
  expect((await t.api(admin).post('/invitations/accept', { token })).status).toBe(200);
});
afterEach(() => {
  tokenAnswer = null;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

describe('owner console → sign-in providers', () => {
  it('starts empty: nothing offered, the return addresses are shown; owner only', async () => {
    const list = await providers();
    expect(list.map((p) => p.provider)).toEqual(['google', 'microsoft']);
    for (const p of list) {
      expect(p).toMatchObject({ enabled: true, source: 'none', active: false, has_secret: false, client_id: null });
      expect(p.redirect_uri).toBe(`${WEB_ORIGIN}/api/auth/callback/${p.provider}`);
    }
    expect(await config()).toMatchObject({ google: false, microsoft: false, magic_link: true });
    expect((await t.api(admin).get('/platform/login-providers')).status).toBe(404);
    expect((await t.api(admin).patch('/platform/login-providers/google', { enabled: false })).status).toBe(404);
    expect((await t.api(undefined).get('/platform/login-providers')).status).toBe(401);
  });

  it('saves Google: the secret is sealed at rest and never returned; the sign-in screen offers it at once', async () => {
    const res = await t.api(owner).patch('/platform/login-providers/google', {
      client_id: 'google-client-1.apps.googleusercontent.com',
      client_secret: GOOGLE_SECRET,
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(GOOGLE_SECRET);
    const google = (JSON.parse(text) as Json).data.find((p: Json) => p.provider === 'google');
    expect(google).toMatchObject({
      client_id: 'google-client-1.apps.googleusercontent.com',
      has_secret: true,
      secret_hint: '…1234',
      source: 'setting',
      active: true,
    });
    const row = (await t.db.select().from(platformSettings).where(eq(platformSettings.id, 'login_providers')))[0]!;
    expect(JSON.stringify(row.settings)).not.toContain(GOOGLE_SECRET);
    const sealed = (row.settings as Json).google.secret_enc as string;
    expect(sealed.startsWith('v1.')).toBe(true);
    expect(createSecretBox(t.deps.env).open(sealed)).toBe(GOOGLE_SECRET);
    expect(await config()).toMatchObject({ google: true, microsoft: false });
  });

  it('Better Auth follows the console without a restart: new client id, switched off, back on', async () => {
    const urlOf = async () => {
      const res = await authCall('/sign-in/social', { provider: 'google', callbackURL: '/' });
      return res.status === 200 ? new URL((await body(res)).url as string) : null;
    };
    let url = (await urlOf())!;
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('google-client-1.apps.googleusercontent.com');
    expect(url.searchParams.get('redirect_uri')).toBe(`${WEB_ORIGIN}/api/auth/callback/google`);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['openid', 'email', 'profile']));

    await t.api(owner).patch('/platform/login-providers/google', { client_id: 'google-client-2' });
    url = (await urlOf())!;
    expect(url.searchParams.get('client_id')).toBe('google-client-2');

    await t.api(owner).patch('/platform/login-providers/google', { enabled: false });
    expect(await urlOf()).toBeNull();
    expect((await config()).google).toBe(false);
    expect((await providerOf('google')).active).toBe(false);

    await t.api(owner).patch('/platform/login-providers/google', { enabled: true });
    expect((await urlOf())!.searchParams.get('client_id')).toBe('google-client-2');
  });

  it('Microsoft: tenant, return address and scopes; "common" by default', async () => {
    const res = await t.api(owner).patch('/platform/login-providers/microsoft', {
      client_id: '11111111-2222-3333-4444-555555555555',
      client_secret: MS_SECRET,
      tenant_id: 'contoso.onmicrosoft.com',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(MS_SECRET);
    expect(await config()).toMatchObject({ google: true, microsoft: true });

    const start = await authCall('/sign-in/social', { provider: 'microsoft', callbackURL: '/' });
    expect(start.status).toBe(200);
    const url = new URL((await body(start)).url as string);
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://login.microsoftonline.com/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe('11111111-2222-3333-4444-555555555555');
    expect(url.searchParams.get('redirect_uri')).toBe(`${WEB_ORIGIN}/api/auth/callback/microsoft`);
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining(['openid', 'email', 'profile']));
    expect(url.searchParams.get('prompt')).toBe('select_account');

    // A bad tenant is refused; null = back to the default (common).
    expect((await t.api(owner).patch('/platform/login-providers/microsoft', { tenant_id: 'a/b' })).status).toBe(400);
    await t.api(owner).patch('/platform/login-providers/microsoft', { tenant_id: null });
    const again = new URL(
      (await body(await authCall('/sign-in/social', { provider: 'microsoft', callbackURL: '/' }))).url,
    );
    expect(again.pathname).toBe('/common/oauth2/v2.0/authorize');
  });

  it('the provider shape: Microsoft keeps no photo and trusts only addresses Microsoft vouches for', () => {
    const resolved = resolveProviders(
      { google: { enabled: false } as never, microsoft: { enabled: true } as never } as never,
      {
        MICROSOFT_CLIENT_ID: 'env-id',
        MICROSOFT_CLIENT_SECRET: 'env-secret',
        MICROSOFT_TENANT_ID: 'organizations',
      } as never,
      'https://os.example.com',
    );
    expect(resolved.map((p) => [p.id, p.source, p.active, p.tenantId])).toEqual([
      ['google', 'none', false, 'organizations'],
      ['microsoft', 'env', true, 'organizations'],
    ]);
    const [ms] = buildSocialProviders(resolved);
    expect(ms!.id).toBe('microsoft');
    expect((ms as unknown as { options: Json }).options ?? {}).toBeDefined();
    expect(resolved[1]!.redirectURI).toBe('https://os.example.com/api/auth/callback/microsoft');

    expect(microsoftEmailVerified({ email: 'a@outlook.com', tid: MICROSOFT_CONSUMER_TENANT })).toBe(true);
    expect(microsoftEmailVerified({ email: 'a@contoso.com', tid: 'some-tenant' })).toBe(false);
    expect(microsoftEmailVerified({ email: 'a@contoso.com', tid: 'some-tenant', xms_edov: true })).toBe(true);
    expect(microsoftEmailVerified({ email: 'a@contoso.com', verified_primary_email: ['A@contoso.com'] })).toBe(true);
    expect(microsoftEmailVerified({ tid: MICROSOFT_CONSUMER_TENANT })).toBe(false);
  });

  it('the environment is the fallback; saved details win over it', () => {
    const env = { GOOGLE_CLIENT_ID: 'env-google', GOOGLE_CLIENT_SECRET: 'env-secret' } as never;
    const box = createSecretBox({ BETTER_AUTH_SECRET: 'x'.repeat(40), SECRETS_KEY: undefined });
    const empty = {
      enabled: true,
      client_id: null,
      secret_enc: null,
      secret_hint: null,
      tenant_id: null,
      last_test: null,
    };
    const base = { google: empty, microsoft: empty };
    let g = resolveProviders(base, env, 'https://a.test', box.open)[0]!;
    expect([g.source, g.credentials?.clientId]).toEqual(['env', 'env-google']);
    g = resolveProviders(
      { ...base, google: { ...empty, client_id: 'saved', secret_enc: box.seal('s') } },
      env,
      'https://a.test',
      box.open,
    )[0]!;
    expect([g.source, g.credentials]).toEqual(['setting', { clientId: 'saved', clientSecret: 's' }]);
    // Switched off in the console: not offered, even with the environment's credentials.
    g = resolveProviders({ ...base, google: { ...empty, enabled: false } }, env, 'https://a.test', box.open)[0]!;
    expect([g.source, g.active, g.credentials]).toEqual(['env', false, null]);
  });

  it('"test connection" reads the token endpoint answer and keeps the result', async () => {
    tokenAnswer = { status: 401, body: { error: 'invalid_client', error_description: 'Unauthorized' } };
    let res = await body(await t.api(owner).post('/platform/login-providers/google/test'));
    expect(res.result).toMatchObject({ ok: false, error: 'invalid_client' });
    expect((await providerOf('google')).last_test).toMatchObject({ ok: false, error: 'invalid_client' });

    tokenAnswer = { status: 400, body: { error: 'invalid_grant', error_description: 'Bad Request' } };
    res = await body(await t.api(owner).post('/platform/login-providers/google/test'));
    expect(res.result).toMatchObject({ ok: true, error: null });

    expect(
      classifyTokenAnswer(401, { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' }),
    ).toBe('invalid_secret');
    expect(classifyTokenAnswer(400, { error: 'unauthorized_client', error_description: 'AADSTS700016: x' })).toBe(
      'unknown_client',
    );
    expect(classifyTokenAnswer(400, { error: 'invalid_grant', error_description: 'AADSTS70000: x' })).toBeNull();
    // New credentials clear the old result.
    await t.api(owner).patch('/platform/login-providers/google', { client_secret: GOOGLE_SECRET });
    expect((await providerOf('google')).last_test).toBeNull();
  });
});

describe('the provider callback keeps the doors shut', () => {
  it('no invitation → no person is created', async () => {
    const { location, cookie } = await providerSignIn('google', googleClaims('stranger@else.test'));
    expect(cookie).toBeUndefined();
    expect(location).toMatch(/^\/login\?error=INVITATION_REQUIRED/);
    expect(await t.db.select().from(users).where(eq(users.email, 'stranger@else.test'))).toHaveLength(0);
  });

  it('an invitation + a verified address → signed in; the session remembers "google"', async () => {
    await t.api(admin, acmeId).post('/users/invite', { emails: ['gina@acme.test'], role: 'member' });
    const { cookie, location } = await providerSignIn('google', googleClaims('gina@acme.test'));
    expect(cookie).toBeDefined();
    expect(location).not.toMatch(/error=/);
    expect((await sessionsOf('gina@acme.test')).map((s) => s.signInMethod)).toEqual(['google']);
  });

  it('an address the provider does not vouch for cannot use an invitation (also Microsoft work accounts)', async () => {
    await t
      .api(admin, acmeId)
      .post('/users/invite', { emails: ['unverified@acme.test', 'work@acme.test'], role: 'member' });
    const g = await providerSignIn('google', googleClaims('unverified@acme.test', false));
    expect(g.cookie).toBeUndefined();
    expect(g.location).toMatch(/error=EMAIL_NOT_VERIFIED/);
    expect(await t.db.select().from(users).where(eq(users.email, 'unverified@acme.test'))).toHaveLength(0);

    const ms = await providerSignIn('microsoft', {
      oid: 'oid-work',
      tid: 'contoso-tenant',
      iss: 'https://login.microsoftonline.com/contoso-tenant/v2.0',
      email: 'work@acme.test',
      name: 'Work',
    });
    expect(ms.cookie).toBeUndefined();
    expect(await t.db.select().from(users).where(eq(users.email, 'work@acme.test'))).toHaveLength(0);

    // With xms_edov (the directory owns the domain) it counts; the session remembers "microsoft".
    const ok = await providerSignIn('microsoft', {
      oid: 'oid-work',
      tid: 'contoso-tenant',
      email: 'work@acme.test',
      name: 'Work',
      xms_edov: true,
    });
    expect(ok.cookie).toBeDefined();
    expect((await sessionsOf('work@acme.test')).map((s) => s.signInMethod)).toEqual(['microsoft']);
  });

  it('a person with two-factor on gets the code step after Google, and the door is kept with the challenge', async () => {
    const gina = (await t.db.select().from(users).where(eq(users.email, 'gina@acme.test')))[0]!;
    await t.db.update(users).set({ twoFactorEnabled: true }).where(eq(users.id, gina.id));
    const before = (await sessionsOf('gina@acme.test')).length;
    const { cookie, location, res } = await providerSignIn('google', googleClaims('gina@acme.test'));
    expect(cookie).toBeUndefined();
    expect(location).toContain('/login?two_factor=1');
    expect(res.headers.getSetCookie().some((c) => c.startsWith('bos.two_factor='))).toBe(true);
    expect((await sessionsOf('gina@acme.test')).length).toBe(before);
    const kept = await t.db.select().from(authVerifications).where(like(authVerifications.identifier, '2fa-method-%'));
    expect(kept.map((v) => v.value)).toContain('google');
    await t.db.update(users).set({ twoFactorEnabled: false }).where(eq(users.id, gina.id));
  });

  it('the code step makes its session with the door that started it', async () => {
    const secret = 'test-secret';
    const identifier = '2fa-xyz';
    const find = async (id: string) => (id === `2fa-method-${identifier}` ? { value: 'microsoft' } : null);
    const ctx = (path: string, cookie?: string) => ({
      path,
      context: {
        secret,
        createAuthCookie: (name: string) => ({ name: `bos.${name}` }),
        internalAdapter: { findVerificationValue: find },
        session: { session: { signInMethod: 'google' } },
      },
      getSignedCookie: async () => (cookie ? identifier : null),
    });
    expect(await signInMethodOf(ctx('/two-factor/verify-totp', 'yes'))).toBe('microsoft');
    // No challenge: enrolment replacing the session keeps the current door.
    expect(await signInMethodOf(ctx('/two-factor/verify-totp'))).toBe('google');
    expect(await signInMethodOf({ path: '/magic-link/verify' })).toBe('magic_link');
    expect(await signInMethodOf({ path: '/sign-in/email' })).toBe('password');
    expect(await signInMethodOf({ path: '/callback/:id', params: { id: 'microsoft' } })).toBe('microsoft');
    expect(await signInMethodOf({ path: '/callback/:id', params: { id: 'github' } })).toBeNull();
  });
});

describe('account policy: sign in through Google / Microsoft only', () => {
  let gina: string;
  let pat: string;
  beforeAll(async () => {
    gina = (await providerSignIn('google', googleClaims('gina@acme.test'))).cookie!;
    await t.api(gina).post('/invitations/accept', { token: t.inviteTokenFor('gina@acme.test') });
    await t.api(admin, acmeId).post('/users/invite', { emails: ['pat@acme.test'], role: 'member' });
    const token = t.inviteTokenFor('pat@acme.test');
    pat = t.cookieFrom(await t.signUpWithPassword('pat@acme.test', token))!;
    await t.api(pat).post('/invitations/accept', { token });
  });

  it('cannot shut out the admin saving it, and needs a provider the platform offers', async () => {
    let res = await t.api(admin, acmeId).patch('/security', { sso: { required: true } });
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toBe('sso_excludes_you');

    res = await t.api(admin, acmeId).patch('/security', { sso: { required: true, providers: [] } });
    expect(res.status).toBe(422);

    await t.api(owner).patch('/platform/login-providers/microsoft', { enabled: false });
    res = await t.api(admin, acmeId).patch('/security', {
      sso: { required: true, exempt_admins: true, providers: ['microsoft'] },
    });
    expect((await body(res)).error.message).toBe('sso_provider_unavailable');
    await t.api(owner).patch('/platform/login-providers/microsoft', { enabled: true });

    res = await t.api(admin, acmeId).patch('/security', {
      sso: { required: true, exempt_admins: true, providers: ['google', 'microsoft'] },
    });
    expect(res.status).toBe(200);
    expect((await body(res)).sso).toEqual({
      required: true,
      providers: ['google', 'microsoft'],
      domains: [],
      exempt_admins: true,
      google_domains: [],
      microsoft_tenants: [],
    });
  });

  it('a password session gets 403 sso_required in this account; a Google session opens it; the admin is exempt', async () => {
    const res = await t.api(pat, acmeId).get('/workspaces');
    expect(res.status).toBe(403);
    expect((await body(res)).error.message).toBe('sso_required');
    const me = await body(await t.api(pat).get('/auth/me'));
    expect(me.user.sso_gate).toEqual([{ account_id: acmeId, providers: ['google', 'microsoft'] }]);

    expect((await t.api(gina, acmeId).get('/workspaces')).status).toBe(200);
    expect((await body(await t.api(gina).get('/auth/me'))).user.sso_gate).toEqual([]);
    expect((await t.api(admin, acmeId).get('/workspaces')).status).toBe(200);
  });

  it('the domain list narrows who it covers; turning it off lets everyone back', async () => {
    await t.api(admin, acmeId).patch('/security', { sso: { domains: ['corp.test'] } });
    expect((await t.api(pat, acmeId).get('/workspaces')).status).toBe(200);
    await t.api(admin, acmeId).patch('/security', { sso: { domains: ['acme.test'] } });
    expect((await t.api(pat, acmeId).get('/workspaces')).status).toBe(403);
    await t.api(admin, acmeId).patch('/security', { sso: { required: false } });
    expect((await t.api(pat, acmeId).get('/workspaces')).status).toBe(200);
  });
});
