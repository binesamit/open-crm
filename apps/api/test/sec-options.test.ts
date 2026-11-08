// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ssoOrgAllowed, ssoOrgFromClaims } from '@bines/shared';
import { authSessions, users } from '../src/db/schema';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Prod — the two optional security settings of the security review ("recommend, don't require")
 * - S-72: an account's SSO policy may name the organisations a provider sign-in must come from — Google Workspace
 *   domains (`hd`) and Microsoft directories (`tid`). Empty = any (as before). Kept with the session, checked by the
 *   gate, and never saved so that it shuts out the admin saving it.
 * - S-77: owner console → Platform settings → Security: "two-factor sign-in for the owner console" (off by default).
 *   On: the owner and support staff without 2FA get 403 console_two_factor_required; it cannot be turned on by
 *   someone without 2FA.
 */
let t: TestContext;
let owner: string;
let admin: string;
let acmeId: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

const TENANT = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const OTHER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad'; // Microsoft's consumer (personal accounts) directory

const cookiesOf = (res: Response) =>
  res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0]!)
    .filter((c) => !c.endsWith('='));
const authCall = (path: string, payload: unknown) =>
  t.app.request(`/api/auth${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
    body: JSON.stringify(payload),
  });

// ---- the providers' token endpoints, played here (no network) ----
const jwt = (claims: Record<string, unknown>) =>
  [{ alg: 'RS256', typ: 'JWT' }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).join('.') +
  '.signature';
let nextClaims: Record<string, unknown> = {};
const realFetch = globalThis.fetch;
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/oauth2\.googleapis\.com\/token|login\.microsoftonline\.com\/.+\/token/.test(url)) {
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

const providerSignIn = async (provider: 'google' | 'microsoft', claims: Record<string, unknown>) => {
  const start = await authCall('/sign-in/social', { provider, callbackURL: '/', errorCallbackURL: '/login' });
  expect(start.status).toBe(200);
  const state = new URL((await body(start)).url as string).searchParams.get('state')!;
  nextClaims = claims;
  const res = await t.app.request(`/api/auth/callback/${provider}?code=the-code&state=${encodeURIComponent(state)}`, {
    headers: { origin: WEB_ORIGIN, cookie: cookiesOf(start).join('; ') },
  });
  const session = t.cookieFrom(res);
  expect(session && !session.endsWith('=')).toBeTruthy();
  return session!;
};
const google = (email: string, hd?: string) => ({
  sub: `g-${email}-${hd ?? 'personal'}`,
  email,
  email_verified: true,
  name: email.split('@')[0],
  ...(hd ? { hd } : {}),
});
const microsoft = (email: string, tid: string) => ({
  oid: `oid-${email}-${tid}`,
  tid,
  email,
  name: email.split('@')[0],
  xms_edov: true,
});
const lastSessionOf = async (email: string) => {
  const u = (await t.db.select().from(users).where(eq(users.email, email)))[0]!;
  const rows = await t.db.select().from(authSessions).where(eq(authSessions.userId, u.id));
  return rows.sort((a, b) => +b.createdAt - +a.createdAt)[0]!;
};
const security = (patch: Json, cookie = admin) => t.api(cookie, acmeId).patch('/security', { sso: patch });
const setTwoFactor = (email: string, on: boolean) =>
  t.db.update(users).set({ twoFactorEnabled: on }).where(eq(users.email, email));

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
  await t.api(admin).post('/invitations/accept', { token });
  await t.api(owner).patch('/platform/login-providers/google', { client_id: 'g-client', client_secret: 'g-secret-1' });
  await t
    .api(owner)
    .patch('/platform/login-providers/microsoft', { client_id: 'ms-client', client_secret: 'ms-secret-1' });
  await t.api(admin, acmeId).post('/users/invite', { emails: ['gina@acme.test', 'mike@acme.test'], role: 'member' });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await t.close();
});

describe('S-72: SSO by organisation (optional)', () => {
  it('the claims: Google hd / Microsoft tid; an empty list accepts any; a list needs a match', () => {
    expect(ssoOrgFromClaims('google', { hd: 'Acme.test' })).toBe('acme.test');
    expect(ssoOrgFromClaims('google', {})).toBeNull();
    expect(ssoOrgFromClaims('microsoft', { tid: TENANT })).toBe(TENANT);
    expect(ssoOrgFromClaims('password', { hd: 'acme.test' })).toBeNull();
    const empty = { google_domains: [], microsoft_tenants: [] };
    expect(ssoOrgAllowed(empty, 'google', null)).toBe(true);
    const listed = { google_domains: ['acme.test'], microsoft_tenants: [TENANT] };
    expect(ssoOrgAllowed(listed, 'google', 'acme.test')).toBe(true);
    expect(ssoOrgAllowed(listed, 'google', 'other.test')).toBe(false);
    expect(ssoOrgAllowed(listed, 'google', null)).toBe(false);
    expect(ssoOrgAllowed(listed, 'microsoft', TENANT)).toBe(true);
    expect(ssoOrgAllowed(listed, 'microsoft', OTHER_TENANT)).toBe(false);
  });

  it('defaults to empty lists (any organisation); a tenant must be a directory id', async () => {
    const res = await t.api(admin, acmeId).get('/security');
    expect((await body(res)).sso).toMatchObject({ google_domains: [], microsoft_tenants: [] });
    expect((await security({ microsoft_tenants: ['contoso'] })).status).toBe(400);
    expect((await security({ google_domains: ['not a domain'] })).status).toBe(400);
  });

  it('the session keeps the organisation it signed in from', async () => {
    await providerSignIn('google', google('gina@acme.test', 'acme.test'));
    expect(await lastSessionOf('gina@acme.test')).toMatchObject({ signInMethod: 'google', signInOrg: 'acme.test' });
    await providerSignIn('microsoft', microsoft('mike@acme.test', TENANT));
    expect(await lastSessionOf('mike@acme.test')).toMatchObject({ signInMethod: 'microsoft', signInOrg: TENANT });
    // A personal Google account has no hd.
    await providerSignIn('google', google('gina@acme.test'));
    expect(await lastSessionOf('gina@acme.test')).toMatchObject({ signInMethod: 'google', signInOrg: null });
  });

  it('with lists: the right organisation opens the account; another (or a personal account) gets the gate', async () => {
    const ginaWork = await providerSignIn('google', google('gina@acme.test', 'acme.test'));
    await t.api(ginaWork).post('/invitations/accept', { token: t.inviteTokenFor('gina@acme.test') });
    const mikeWork = await providerSignIn('microsoft', microsoft('mike@acme.test', TENANT));
    await t.api(mikeWork).post('/invitations/accept', { token: t.inviteTokenFor('mike@acme.test') });

    const res = await security({
      required: true,
      exempt_admins: true,
      google_domains: ['ACME.test', 'acme.test'],
      microsoft_tenants: [TENANT],
    });
    expect(res.status).toBe(200);
    expect((await body(res)).sso).toMatchObject({ google_domains: ['acme.test'], microsoft_tenants: [TENANT] });

    expect((await t.api(ginaWork, acmeId).get('/workspaces')).status).toBe(200);
    expect((await t.api(mikeWork, acmeId).get('/workspaces')).status).toBe(200);

    const ginaPersonal = await providerSignIn('google', google('gina@acme.test'));
    const refused = await t.api(ginaPersonal, acmeId).get('/workspaces');
    expect(refused.status).toBe(403);
    const err = (await body(refused)).error;
    expect(err.message).toBe('sso_required');
    expect(err.details).toMatchObject({ organization: true });
    expect((await body(await t.api(ginaPersonal).get('/auth/me'))).user.sso_gate).toEqual([
      { account_id: acmeId, providers: ['google', 'microsoft'], organization: true },
    ]);

    const mikePersonal = await providerSignIn('microsoft', microsoft('mike@acme.test', OTHER_TENANT));
    expect((await t.api(mikePersonal, acmeId).get('/workspaces')).status).toBe(403);
  });

  it('emptying a list accepts any account of that provider again (today’s behaviour)', async () => {
    await security({ google_domains: [] });
    const ginaPersonal = await providerSignIn('google', google('gina@acme.test'));
    expect((await t.api(ginaPersonal, acmeId).get('/workspaces')).status).toBe(200);
    const mikePersonal = await providerSignIn('microsoft', microsoft('mike@acme.test', OTHER_TENANT));
    expect((await t.api(mikePersonal, acmeId).get('/workspaces')).status).toBe(403);
    await security({ microsoft_tenants: [] });
    expect((await t.api(mikePersonal, acmeId).get('/workspaces')).status).toBe(200);
  });

  it('cannot shut out the admin saving it: signed in from another organisation → sso_org_excludes_you', async () => {
    await security({ required: false });
    await t.api(admin, acmeId).post('/users/invite', { emails: ['boss@acme.test'], role: 'admin' });
    const boss = await providerSignIn('google', google('boss@acme.test', 'acme.test'));
    await t.api(boss).post('/invitations/accept', { token: t.inviteTokenFor('boss@acme.test') });
    let res = await security({ required: true, exempt_admins: false, google_domains: ['corp.test'] }, boss);
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toBe('sso_org_excludes_you');
    res = await security({ required: true, exempt_admins: false, google_domains: ['acme.test'] }, boss);
    expect(res.status).toBe(200);
    await security({ required: false, exempt_admins: true, google_domains: [] }, boss);
  });
});

describe('S-77: two-factor sign-in for the owner console (optional)', () => {
  let agent: string;
  beforeAll(async () => {
    await t.api(owner).post('/platform/accounts', {
      name: 'Helpers',
      slug: 'helpers',
      first_admin_email: 'agent@support.test',
      template_set: 'empty',
    });
    const token = t.inviteTokenFor('agent@support.test');
    agent = t.cookieFrom(await t.signUpWithPassword('agent@support.test', token))!;
    await t.api(agent).post('/invitations/accept', { token });
    await t.api(owner).post('/platform/support/staff', { email: 'agent@support.test', role: 'agent' });
  });

  it('is off by default: the console opens without 2FA', async () => {
    const res = await t.api(owner).get('/platform/settings');
    expect(res.status).toBe(200);
    expect((await body(res)).settings.security).toEqual({ console_two_factor: false });
    expect((await body(await t.api(owner).get('/auth/me'))).user.console_two_factor_required).toBe(false);
    expect((await t.api(agent).get('/platform/support/tickets')).status).toBe(200);
  });

  it('cannot be turned on by someone without 2FA (never locks out the person saving it)', async () => {
    const res = await t.api(owner).patch('/platform/settings', { security: { console_two_factor: true } });
    expect(res.status).toBe(422);
    expect((await body(res)).error.message).toBe('console_two_factor_needs_yours');
    expect((await body(await t.api(owner).get('/platform/settings'))).settings.security.console_two_factor).toBe(false);
  });

  it('on: the owner with 2FA keeps the console; staff without 2FA get 403 until they turn it on', async () => {
    await setTwoFactor(OWNER_EMAIL, true);
    const res = await t.api(owner).patch('/platform/settings', { security: { console_two_factor: true } });
    expect(res.status).toBe(200);
    expect((await body(res)).settings.security.console_two_factor).toBe(true);
    expect((await t.api(owner).get('/platform/accounts')).status).toBe(200);
    expect((await t.api(owner).get('/platform/support/tickets')).status).toBe(200);

    const refused = await t.api(agent).get('/platform/support/tickets');
    expect(refused.status).toBe(403);
    expect((await body(refused)).error.message).toBe('console_two_factor_required');
    expect((await body(await t.api(agent).get('/auth/me'))).user.console_two_factor_required).toBe(true);
    // Their accounts still open (the requirement is the console's only), and others still get 404.
    expect((await t.api(admin).get('/platform/accounts')).status).toBe(404);

    await setTwoFactor('agent@support.test', true);
    expect((await t.api(agent).get('/platform/support/tickets')).status).toBe(200);
    expect((await body(await t.api(agent).get('/auth/me'))).user.console_two_factor_required).toBe(false);
  });

  it('on: the owner without 2FA is refused on every /platform route (the profile stays open to turn it on)', async () => {
    await setTwoFactor(OWNER_EMAIL, false);
    for (const path of ['/platform/accounts', '/platform/settings', '/platform/login-providers']) {
      const res = await t.api(owner).get(path);
      expect(res.status, path).toBe(403);
      expect((await body(res)).error.message).toBe('console_two_factor_required');
    }
    const me = await body(await t.api(owner).get('/auth/me'));
    expect(me.user.console_two_factor_required).toBe(true);

    await setTwoFactor(OWNER_EMAIL, true);
    const off = await t.api(owner).patch('/platform/settings', { security: { console_two_factor: false } });
    expect(off.status).toBe(200);
    await setTwoFactor(OWNER_EMAIL, false);
    expect((await t.api(owner).get('/platform/accounts')).status).toBe(200);
  });
});
