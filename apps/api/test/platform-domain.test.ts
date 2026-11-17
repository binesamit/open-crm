// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizeOrigin, resolvePublicAddress } from '@bines/shared';
import { appUrlFrom, resetAppUrlCache } from '../../worker/src/public-address';
import type { SqlClient } from '../../worker/src/repositories/trash.repo';
import { createTestContext, OWNER_EMAIL, WEB_ORIGIN, type TestContext } from './helpers';

/**
 * Prod fix M11 ("דומיין קבוע למערכת"): the platform's public address is a setting in the owner console (env
 * WEB_ORIGIN = the default). Every absolute link — invitations, password reset, magic link, MCP / OAuth discovery,
 * the worker's email links — is built on it, at once, without a restart; the old address stays accepted for sign-in
 * and CORS while people move.
 */
let t: TestContext;
let owner: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;
const NEW = 'https://os.example.com';

beforeAll(async () => {
  t = await createTestContext();
  owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
});
afterAll(() => t.close());

describe('validation (shared)', () => {
  it('accepts only a bare https origin (http for localhost)', () => {
    expect(normalizeOrigin('https://os.example.com')).toBe(NEW);
    expect(normalizeOrigin(' https://OS.example.com/ ')).toBe(NEW);
    expect(normalizeOrigin('https://os.example.com:8443')).toBe('https://os.example.com:8443');
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    for (const bad of [
      'http://os.example.com',
      'https://os.example.com/app',
      'https://os.example.com?x=1',
      'https://os.example.com#x',
      'https://u:p@os.example.com',
      'os.example.com',
      'javascript:alert(1)',
      '',
    ])
      expect(normalizeOrigin(bad), bad).toBeNull();
  });

  it('resolves setting > env, API = web unless set, and lists every accepted origin', () => {
    const env = { WEB_ORIGIN: 'https://old.up.railway.app', BETTER_AUTH_URL: 'https://auth.example.com' };
    expect(resolvePublicAddress(undefined, env)).toEqual({
      web: 'https://old.up.railway.app',
      web_source: 'env',
      api: 'https://old.up.railway.app',
      api_source: 'web',
      accepted: ['https://old.up.railway.app', 'https://auth.example.com'],
    });
    const r = resolvePublicAddress(
      { web_origin: NEW, api_origin: 'https://api.example.com', previous_origins: ['https://prev.example.com'] },
      env,
    );
    expect(r).toMatchObject({ web: NEW, web_source: 'setting', api: 'https://api.example.com', api_source: 'setting' });
    expect(r.accepted).toEqual([
      NEW,
      'https://api.example.com',
      'https://old.up.railway.app',
      'https://auth.example.com',
      'https://prev.example.com',
    ]);
  });
});

describe('owner console setting', () => {
  it('shows the address in effect and that it comes from the environment', async () => {
    const res = await body(await t.api(owner).get('/platform/settings'));
    expect(res.public_address).toMatchObject({
      web: WEB_ORIGIN,
      web_source: 'env',
      api: WEB_ORIGIN,
      api_source: 'web',
      env_web_origin: WEB_ORIGIN,
      auth_base_url: WEB_ORIGIN,
    });
    expect(res.settings.public_address).toEqual({ previous_origins: [] });
  });

  it('refuses a path, http or garbage', async () => {
    for (const web_origin of ['https://os.example.com/x', 'http://os.example.com', 'nope'])
      expect((await t.api(owner).patch('/platform/settings', { public_address: { web_origin } })).status).toBe(400);
  });

  it('is the platform owner’s only', async () => {
    expect((await t.api(undefined).patch('/platform/settings', { public_address: { web_origin: NEW } })).status).toBe(
      401,
    );
  });

  it('saves a new address; the old one is kept as a previous (still accepted) address', async () => {
    const res = await body(
      await t.api(owner).patch('/platform/settings', { public_address: { web_origin: 'https://OS.example.com/' } }),
    );
    expect(res.settings.public_address).toEqual({ web_origin: NEW, previous_origins: [WEB_ORIGIN] });
    expect(res.public_address).toMatchObject({ web: NEW, web_source: 'setting', api: NEW, api_source: 'web' });
    expect(res.public_address.accepted).toEqual(expect.arrayContaining([NEW, WEB_ORIGIN]));
  });

  it('serves the address publicly for the web app’s copied links', async () => {
    expect(await body(await t.app.request('/api/v1/public/address'))).toEqual({ web: NEW, api: NEW });
  });
});

describe('links are built on the setting', () => {
  it('invitation email and link', async () => {
    const created = await body(
      await t.api(owner).post('/platform/accounts', {
        name: 'Acme',
        slug: 'acme',
        first_admin_email: 'admin@acme.test',
        template_set: 'empty',
      }),
    );
    expect(created.account.id).toBeTruthy();
    const text = t.lastMailTo('admin@acme.test').text;
    expect(text).toContain(`${NEW}/invite/`);
    expect(text).not.toContain(WEB_ORIGIN);
  });

  it('password reset email', async () => {
    expect((await t.api(undefined).post('/auth/forgot-password', { email: OWNER_EMAIL })).status).toBe(200);
    const text = t.lastMailTo(OWNER_EMAIL).text;
    expect(text).toMatch(new RegExp(`${NEW}/login#reset=[\\w-]+`));
  });

  it('magic link email (Better Auth builds it on its base; we move it to the public address)', async () => {
    const res = await t.app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: NEW },
      body: JSON.stringify({ email: OWNER_EMAIL, callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const text = t.lastMailTo(OWNER_EMAIL).text;
    expect(text).toMatch(new RegExp(`${NEW}/api/auth/magic-link/verify\\?token=`));
  });

  it('MCP / OAuth discovery names the new address', async () => {
    const prm = await body(await t.app.request('/.well-known/oauth-protected-resource/mcp'));
    expect(prm).toMatchObject({ resource: `${NEW}/mcp`, authorization_servers: [NEW] });
    const asm = await body(await t.app.request('/.well-known/oauth-authorization-server'));
    expect(asm.issuer).toBe(NEW);
  });

  it('an API address of its own moves the API-facing links only', async () => {
    await t.api(owner).patch('/platform/settings', { public_address: { api_origin: 'https://api.example.com' } });
    expect(await body(await t.app.request('/api/v1/public/address'))).toEqual({
      web: NEW,
      api: 'https://api.example.com',
    });
    expect((await body(await t.app.request('/.well-known/oauth-authorization-server'))).issuer).toBe(
      'https://api.example.com',
    );
    await t.api(owner).patch('/platform/settings', { public_address: { api_origin: null } });
  });

  it('the worker builds its email / push links on the same setting', async () => {
    resetAppUrlCache();
    expect(await appUrlFrom(t.pg as unknown as SqlClient, { WEB_ORIGIN: 'https://stale.up.railway.app' })).toBe(NEW);
    resetAppUrlCache();
  });
});

describe('old and new origins during the move', () => {
  const preflight = (origin: string) =>
    t.app.request('/api/v1/me', {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'GET' },
    });

  it('CORS allows the new, the environment’s and previous origins — nothing else', async () => {
    expect((await preflight(NEW)).headers.get('access-control-allow-origin')).toBe(NEW);
    expect((await preflight(WEB_ORIGIN)).headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    expect((await preflight('https://evil.example')).headers.get('access-control-allow-origin')).not.toBe(
      'https://evil.example',
    );
  });

  it('sign-in trusts the new, the environment’s and previous origins — nothing else', async () => {
    // Better Auth skips its origin check under NODE_ENV=test, so the trusted list itself is checked.
    const trusted = t.deps.auth.options.trustedOrigins as () => Promise<string[]>;
    const list = await trusted();
    expect(list).toEqual(expect.arrayContaining([NEW, WEB_ORIGIN]));
    expect(list).not.toContain('https://evil.example');
    const signIn = (origin: string) =>
      t.app.request('/api/auth/sign-in/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ email: OWNER_EMAIL, callbackURL: `${origin}/` }),
      });
    expect((await signIn(NEW)).status).toBe(200);
    expect((await signIn(WEB_ORIGIN)).status).toBe(200);
  });

  it('clearing the setting falls back to the environment', async () => {
    const res = await body(await t.api(owner).patch('/platform/settings', { public_address: { web_origin: null } }));
    expect(res.public_address).toMatchObject({ web: WEB_ORIGIN, web_source: 'env' });
    // The address it moved away from is kept (still accepted) until the owner removes it.
    expect(res.settings.public_address.previous_origins).toEqual([NEW, WEB_ORIGIN]);
    const cleared = await body(
      await t.api(owner).patch('/platform/settings', { public_address: { previous_origins: [] } }),
    );
    expect(cleared.settings.public_address.previous_origins).toEqual([]);
  });
});
