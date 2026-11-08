// SPDX-License-Identifier: AGPL-3.0-only
import { fileURLToPath } from 'node:url';
import { signBinesBody } from '@bines/ext-sdk/server';
import { extensionManifestSchema } from '@bines/shared';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { caldavProvider } from '../src/caldav';
import type { Introspection } from '../src/bines';
import { createCrypto } from '../src/crypto';
import { readEnv } from '../src/env';
import { memoryStore, type InstallationRow } from '../src/store';
import { createEngine } from '../src/sync';
import { DAV_ORIGIN, DAV_PASS, DAV_USER, fakeCaldav } from './fake-caldav';
import { ALL_IN, at, config, fakeBines, fakeProvider, people } from './fakes';

const BINES = 'https://work.example.com';
const PUBLIC = 'https://cal.example.com';

const make = async () => {
  const env = readEnv({
    PUBLIC_URL: PUBLIC,
    BINES_ORIGIN: BINES,
    CALSYNC_ENCRYPTION_KEY: 'test-key-test-key-test-key',
    GOOGLE_CLIENT_ID: 'server-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'GOCSPX-server',
  });
  const crypto = createCrypto(env.CALSYNC_ENCRYPTION_KEY);
  const store = memoryStore();
  const now = () => Date.now();
  const g = fakeProvider(now);
  const b = fakeBines(now);
  let who: Introspection = { active: false };
  b.api.introspect = async () => who;
  const dav = fakeCaldav();
  const caldav = caldavProvider(dav.fetch);
  const providers = { google: g.provider, caldav };
  const engine = createEngine({
    store,
    providers,
    bines: () => b.api,
    authFor: async () => ({ accessToken: async () => 't' }),
  });
  const googleFetch = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith('https://oauth2.googleapis.com/token'))
      return Response.json({ access_token: 'at', refresh_token: 'rt-secret', expires_in: 3600 });
    if (u.startsWith('https://openidconnect.googleapis.com')) return Response.json({ email: 'ann@gmail.test' });
    return new Response(null, { status: 404 });
  });
  const app = createApp({
    env,
    store,
    crypto,
    engine,
    providers,
    discoverCaldav: caldav.discover,
    binesFor: () => b.api,
    binesForCreds: () => b.api,
    authFor: async () => ({ accessToken: async () => 't' }),
    publicDir: fileURLToPath(new URL('../public', import.meta.url)),
    fetch: googleFetch as unknown as typeof fetch,
  });
  const inst: InstallationRow = {
    id: 'inst1',
    account_id: 'acc',
    status: 'active',
    credentials_enc: crypto.encrypt(JSON.stringify({ signing_secret: 'bos_extw_saved' })),
    service_user_id: 'svc',
    config: config(),
    google_client: null,
    hooks: { board_id: 'b1', ids: ['wh1'], secret_enc: crypto.encrypt('hook-secret-0123456789') },
    last_sync_at: null,
    created_at: new Date().toISOString(),
  };
  await store.putInstallation(inst);
  const setWho = (w: Introspection) => (who = w);
  return { app, store, crypto, g, b, inst, setWho, googleFetch, dav };
};

const signed = async (secret: string, body: unknown, ts = String(Date.now())) => {
  const raw = JSON.stringify(body);
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bines-timestamp': ts,
      'x-bines-signature': await signBinesBody(secret, ts, raw),
    },
    body: raw,
  };
};

describe('health and manifest', () => {
  it('GET /health is 200; the manifest names the server’s origin, its scopes and both pages', async () => {
    const { app } = await make();
    const health = await app.request('/health');
    expect(health.status).toBe(200);
    expect(health.headers.get('strict-transport-security')).toContain('max-age=31536000');
    const m = (await (await app.request('/manifest.json')).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(m.origins).toEqual([PUBLIC]);
    expect(m.server).toEqual({ lifecycle_url: `${PUBLIC}/lifecycle` });
    expect(m.permissions).toEqual(expect.arrayContaining(['boards:read', 'items:write', 'webhooks']));
    expect(m.features.map((f: { type: string }) => f.type)).toEqual(['user_settings_page', 'account_settings_page']);
    // The platform's own manifest schema accepts it.
    expect(extensionManifestSchema.safeParse(m).success).toBe(true);
  });
});

describe('Bines webhooks: the signature check', () => {
  const event = { event: { type: 'column_changed', subscriptionId: 'wh1', itemId: 'it-x' } };

  it('echoes the handshake challenge', async () => {
    const { app } = await make();
    const res = await app.request('/bines/webhook', { method: 'POST', body: JSON.stringify({ challenge: 'abc' }) });
    expect(await res.json()).toEqual({ challenge: 'abc' });
  });

  it('accepts a delivery signed with the webhook secret, once; refuses a bad, stale or replayed one', async () => {
    const { app, b, g } = await make();
    const item = b.add({ cells: { tl: at('2026-11-10'), people: people('u1') } });
    const body = { event: { ...event.event, itemId: item.id } };
    const ok = await signed('hook-secret-0123456789', body);
    expect((await app.request('/bines/webhook', ok)).status).toBe(200);
    expect((await app.request('/bines/webhook', ok)).status).toBe(401); // replay
    expect((await app.request('/bines/webhook', await signed('wrong-secret-0123456789', body))).status).toBe(401);
    const stale = await signed('hook-secret-0123456789', body, String(Date.now() - 10 * 60_000));
    expect((await app.request('/bines/webhook', stale)).status).toBe(401);
    const tampered = { ...ok, body: ok.body.replace('column_changed', 'item_deleted') };
    expect((await app.request('/bines/webhook', tampered)).status).toBe(401);
    expect((await app.request('/bines/webhook', await signed('x', { event: { subscriptionId: 'nope' } }))).status).toBe(
      404,
    );
    expect(g.calls).toEqual([]); // no connection streams in this setup: nothing to write
  });
});

describe('lifecycle', () => {
  const installed = (platform = BINES) => ({
    event: 'installed',
    delivery_id: 'd1',
    sent_at: new Date().toISOString(),
    platform,
    account: { id: 'acc2' },
    installation: {
      id: 'inst2',
      key: 'calendar-sync',
      version: '1.0.0',
      status: 'active',
      scopes: [],
      board_ids: null,
      workspace_ids: null,
    },
    credentials: {
      client_id: 'bos_extc_1',
      client_secret: 'bos_exts_1',
      signing_secret: 'bos_extw_new',
      token_endpoint: `${platform}/oauth/token`,
      api_base: `${platform}/api/v1`,
    },
  });

  it('installed: stored encrypted; from another platform: refused; later calls need the saved secret', async () => {
    const { app, store, crypto } = await make();
    expect((await app.request('/lifecycle', await signed('bos_extw_new', installed('https://evil.test')))).status).toBe(
      401,
    );
    expect((await app.request('/lifecycle', await signed('bos_extw_new', installed()))).status).toBe(200);
    const row = (await store.getInstallation('inst2'))!;
    expect(row.credentials_enc).not.toContain('bos_exts_1');
    expect(JSON.parse(crypto.decrypt(row.credentials_enc)).client_secret).toBe('bos_exts_1');
    const disabled = { ...installed(), event: 'disabled', credentials: undefined };
    expect((await app.request('/lifecycle', await signed('forged-secret', disabled))).status).toBe(401);
    expect((await app.request('/lifecycle', await signed('bos_extw_new', disabled))).status).toBe(200);
    expect((await store.getInstallation('inst2'))!.status).toBe('disabled');
    const gone = { ...installed(), event: 'uninstalled', credentials: undefined };
    expect((await app.request('/lifecycle', await signed('bos_extw_new', gone))).status).toBe(200);
    expect(await store.getInstallation('inst2')).toBeNull();
  });

  it('installed with valid credentials of ANOTHER installation (or account) is refused and changes nothing', async () => {
    const { app, store, b } = await make();
    b.grant.installation_id = 'inst-attacker';
    expect((await app.request('/lifecycle', await signed('bos_extw_new', installed()))).status).toBe(401);
    expect(await store.getInstallation('inst2')).toBeNull();
    b.grant.installation_id = 'inst2';
    b.grant.account_id = 'acc-other';
    expect((await app.request('/lifecycle', await signed('bos_extw_new', installed()))).status).toBe(401);
    expect(await store.getInstallation('inst2')).toBeNull();
  });
});

describe('pages: who is asking, and the OAuth popup', () => {
  const headers = { authorization: 'Bearer bos_ext_page', 'x-installation-id': 'inst1' };
  const member = {
    active: true as const,
    user: { id: 'u1', name: 'Ann', email: 'ann@x.test' },
    account_id: 'acc',
    feature: 'connect',
    expires_at: '',
  };

  it('an inactive token is refused; the admin API wants the admin page’s token', async () => {
    const { app, setWho } = await make();
    expect((await app.request('/api/me', { headers })).status).toBe(401);
    setWho(member);
    expect((await app.request('/api/me', { headers })).status).toBe(200);
    expect((await app.request('/api/admin/state', { headers })).status).toBe(403);
    setWho({ ...member, account_id: 'other' });
    expect(
      (await app.request('/api/me', { headers: { ...headers, authorization: 'Bearer bos_ext_other' } })).status,
    ).toBe(401);
  });

  it('connect → Google with a signed state → callback stores the connection (refresh token encrypted); a state works once', async () => {
    const { app, setWho, store, crypto } = await make();
    setWho(member);
    const { url } = (await (await app.request('/api/connect', { method: 'POST', headers })).json()) as { url: string };
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/oauth/google/callback`);
    expect(u.searchParams.get('scope')).toBe(
      'openid email https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    );
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('prompt')).toBe('consent');
    const state = u.searchParams.get('state')!;
    const cb = await app.request(`/oauth/google/callback?code=c1&state=${encodeURIComponent(state)}`);
    expect(await cb.text()).toContain('data-status="ok"');
    const conn = (await store.getConnection('inst1', 'u1'))!;
    expect(conn.account_email).toBe('ann@gmail.test');
    expect(conn.refresh_token_enc).not.toContain('rt-secret');
    expect(crypto.decrypt(conn.refresh_token_enc)).toBe('rt-secret');
    expect(
      await (await app.request(`/oauth/google/callback?code=c1&state=${encodeURIComponent(state)}`)).text(),
    ).toContain('data-status="bad_state"');
    expect(await (await app.request('/oauth/google/callback?code=c1&state=forged.x')).text()).toContain(
      'data-status="bad_state"',
    );
  });

  it('the page learns how the consent ended by its ticket (no opener under COOP), and only its own user can ask', async () => {
    const { app, setWho } = await make();
    setWho(member);
    const { url, ticket } = (await (await app.request('/api/connect', { method: 'POST', headers })).json()) as {
      url: string;
      ticket: string;
    };
    const ask = async (h = headers) =>
      ((await (await app.request(`/api/connect/${ticket}`, { headers: h })).json()) as { status: string | null })
        .status;
    expect(await ask()).toBeNull();
    const state = new URL(url).searchParams.get('state')!;
    await app.request(`/oauth/google/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(await ask()).toBe('denied');
    setWho({ ...member, user: { ...member.user, id: 'u2' } });
    expect(await ask({ ...headers, authorization: 'Bearer bos_ext_bob' })).toBeNull();
  });

  it('/oauth/google/go sends a signed state on to Google, anything else nowhere', async () => {
    const { app, setWho } = await make();
    setWho(member);
    const { url } = (await (await app.request('/api/connect', { method: 'POST', headers })).json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    const go = await app.request(`/oauth/google/go?state=${encodeURIComponent(state)}`);
    expect(go.status).toBe(302);
    expect(go.headers.get('location')).toBe(url);
    const bad = await app.request('/oauth/google/go?state=forged.x');
    expect(bad.status).toBe(200);
    expect(await bad.text()).toContain('data-status="bad_state"');
  });

  it('pages are served with frame-ancestors = the Bines origin', async () => {
    const { app } = await make();
    const res = await app.request('/connect.html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain(`frame-ancestors ${BINES}`);
    expect((await app.request('/secret.html')).status).toBe(404);
  });

  it('serves every page file, with the fonts allowed and no inline style or script', async () => {
    const { app } = await make();
    for (const f of ['admin.html', 'admin.js', 'connect.html', 'connect.js', 'common.js', 'strings.js', 'style.css']) {
      const res = await app.request(`/${f}`);
      expect(res.status, f).toBe(200);
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp).toContain("script-src 'self'");
      expect(csp).toContain("style-src 'self' https://fonts.googleapis.com");
      expect(csp).not.toContain('unsafe-inline');
      const body = await res.text();
      // Pages build their DOM with text only (no innerHTML) and use no native <select> / checkbox.
      expect(body, f).not.toMatch(/\.innerHTML\s*=|el\('select'|type: 'checkbox'|type="checkbox"/);
    }
  });
});

describe('connecting CalDAV', () => {
  const headers = {
    authorization: 'Bearer bos_ext_page',
    'x-installation-id': 'inst1',
    'content-type': 'application/json',
  };
  const member = {
    active: true as const,
    user: { id: 'u1', name: 'Ann', email: 'ann@x.test' },
    account_id: 'acc',
    feature: 'connect',
    expires_at: '',
  };
  const post = (body: unknown) => ({ method: 'POST', headers, body: JSON.stringify(body) });

  it('discovery first, then the account is stored encrypted (provider caldav, its own calendar found)', async () => {
    const { app, setWho, store, crypto } = await make();
    setWho(member);
    const res = await app.request(
      '/api/connect/caldav',
      post({ url: DAV_ORIGIN, username: DAV_USER, password: DAV_PASS }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { connection: unknown }).connection).toMatchObject({
      connected: true,
      provider: 'caldav',
      email: 'ann@dav.test',
    });
    const conn = (await store.getConnection('inst1', 'u1'))!;
    expect(conn.provider).toBe('caldav');
    expect(conn.refresh_token_enc).not.toContain(DAV_PASS);
    const saved = JSON.parse(crypto.decrypt(conn.refresh_token_enc)) as Record<string, string>;
    expect(saved).toMatchObject({
      home: `${DAV_ORIGIN}/dav/calendars/ann/`,
      primary: `${DAV_ORIGIN}/dav/calendars/ann/work/`,
      password: DAV_PASS,
    });
    const me = (await (await app.request('/api/me', { headers })).json()) as Record<string, unknown>;
    expect(me).toMatchObject({ caldav_ready: true, connection: { provider: 'caldav' } });
  });

  it('a wrong password, a bad address and missing fields come back as codes; nothing is stored', async () => {
    const { app, setWho, store } = await make();
    setWho(member);
    const code = async (body: unknown) =>
      ((await (await app.request('/api/connect/caldav', post(body))).json()) as { error: { code: string } }).error.code;
    expect(await code({ url: DAV_ORIGIN, username: DAV_USER, password: 'wrong-password' })).toBe('caldav_auth');
    expect(await code({ url: 'http://dav.test', username: DAV_USER, password: DAV_PASS })).toBe('caldav_bad_url');
    expect(await code({ url: 'https://169.254.169.254/', username: DAV_USER, password: DAV_PASS })).toBe(
      'caldav_bad_url',
    );
    expect(await code({ url: DAV_ORIGIN, username: DAV_USER })).toBe('caldav_credentials');
    expect(await code({ url: 'https://elsewhere.test', username: DAV_USER, password: DAV_PASS })).toBe(
      'caldav_not_caldav',
    );
    expect(await store.getConnection('inst1', 'u1')).toBeNull();
  });

  it('disconnecting a CalDAV account revokes nothing at Google', async () => {
    const { app, setWho, store, googleFetch } = await make();
    setWho(member);
    await app.request('/api/connect/caldav', post({ url: DAV_ORIGIN, username: DAV_USER, password: DAV_PASS }));
    await app.request('/api/connection', { method: 'DELETE', headers });
    expect(await store.getConnection('inst1', 'u1')).toBeNull();
    expect(googleFetch).not.toHaveBeenCalled();
  });
});

describe('a member’s sync status and "sync now"', () => {
  const headers = { authorization: 'Bearer bos_ext_page', 'x-installation-id': 'inst1' };
  const member = {
    active: true as const,
    user: { id: 'u1', name: 'Ann', email: 'ann@x.test' },
    account_id: 'acc',
    feature: 'connect',
    expires_at: '',
  };

  it('no connection, no status; "sync now" reads their calendar at once and returns the new state', async () => {
    const { app, setWho, store, g, b } = await make();
    setWho(member);
    const me = async () => (await (await app.request('/api/me', { headers })).json()) as { sync: unknown };
    expect((await me()).sync).toBeNull();
    expect((await app.request('/api/sync', { method: 'POST', headers })).status).toBe(409);

    await store.putConnection({
      id: 'c1',
      installation_id: 'inst1',
      user_id: 'u1',
      user_name: 'Ann',
      user_email: 'ann@x.test',
      provider: 'google',
      account_email: 'ann@x.test',
      refresh_token_enc: '',
      prefs: ALL_IN,
      status: 'ok',
      error: null,
      created_at: new Date().toISOString(),
    });
    expect((await me()).sync).toMatchObject({ last_sync_at: null, items: 0, error: null, interval_minutes: 5 });

    // A meeting made in Google arrives on "sync now", without waiting for the periodic pull.
    const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    g.external('primary', {
      title: 'From Google',
      when: { kind: 'timed', start: `${day}T08:00:00Z`, end: `${day}T09:00:00Z` },
    } as never);
    const res = await app.request('/api/sync', { method: 'POST', headers });
    expect(res.status).toBe(200);
    const { sync } = (await res.json()) as { sync: { last_sync_at: string | null; items: number } };
    expect(sync.items).toBe(1);
    expect(sync.last_sync_at).not.toBeNull();
    expect([...b.items.values()].map((i) => i.name)).toContain('From Google');
    expect((await me()).sync).toMatchObject({ items: 1 });
  });
});

describe('a member’s choices: which calendar, and what comes into the board', () => {
  const headers = {
    authorization: 'Bearer bos_ext_page',
    'x-installation-id': 'inst1',
    'content-type': 'application/json',
  };
  const member = {
    active: true as const,
    user: { id: 'u1', name: 'Ann', email: 'ann@x.test' },
    account_id: 'acc',
    feature: 'connect',
    expires_at: '',
  };
  const put = (body: unknown) => ({ method: 'PUT', headers, body: JSON.stringify(body) });
  const connect = (store: Awaited<ReturnType<typeof make>>['store']) =>
    store.putConnection({
      id: 'c1',
      installation_id: 'inst1',
      user_id: 'u1',
      user_name: 'Ann',
      user_email: 'ann@x.test',
      provider: 'google',
      account_email: 'ann@x.test',
      refresh_token_enc: '',
      status: 'ok',
      error: null,
      created_at: new Date().toISOString(),
    });

  it('a new connection: the main calendar, nothing let in; the calendars and the admin’s limit are listed', async () => {
    const { app, setWho, store } = await make();
    setWho(member);
    await connect(store);
    const me = (await (await app.request('/api/me', { headers })).json()) as Record<string, unknown>;
    expect(me.prefs).toMatchObject({ calendar_id: 'primary', import: 'none' });
    expect(me.calendars).toEqual([{ id: 'primary', name: 'Me', primary: true, writable: true }]);
    expect(me.allowed).toEqual({ import: 'existing', max_days: 30 });
  });

  it('saves a choice; "new" starts now; past the admin’s limit or an unknown calendar is refused', async () => {
    const { app, setWho, store, inst } = await make();
    setWho(member);
    await connect(store);
    const res = await app.request('/api/prefs', put({ import: 'new' }));
    expect(res.status).toBe(200);
    const saved = (await store.getConnection('inst1', 'u1'))!.prefs!;
    expect(saved.import).toBe('new');
    expect(Date.now() - Date.parse(saved.since)).toBeLessThan(5_000);
    expect((await app.request('/api/prefs', put({ calendar_id: 'nope' }))).status).toBe(422);
    expect((await app.request('/api/prefs', put({ days: 400 }))).status).toBe(422);
    await store.putInstallation({ ...inst, config: config({ member_import: 'new' }) });
    const refused = await app.request('/api/prefs', put({ import: 'existing' }));
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('import_not_allowed');
  });
});
