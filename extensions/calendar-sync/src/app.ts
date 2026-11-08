// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The HTTP side of the server: the manifest and pages, the lifecycle calls, OAuth with Google, the two webhook
 * receivers (Bines board webhooks, Google push), and the small API the two pages call (each call carries the page's
 * own token; the server asks Bines who it belongs to with POST /ext/introspect).
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import {
  verifyBinesSignature,
  verifyLifecycle,
  type LifecycleEvent,
  type ServerCredentials,
} from '@bines/ext-sdk/server';
import type { BinesApi, Introspection } from './bines';
import { syncConfigSchema, type SyncConfig } from './config';
import { randomId, secretHint, type Crypto } from './crypto';
import { redirectUri, type Env } from './env';
import { authorizeUrl, exchangeCode, revokeToken, type GoogleClient } from './google';
import { manifest } from './manifest';
import { CaldavError, type CaldavInput } from './caldav';
import type { CaldavAccount, CalendarProvider, ProviderAuth, ProviderCalendar } from './provider';
import type { ConnectionRow, InstallationRow, MemberPrefs, Store } from './store';
import { memberImport, type Engine } from './sync';

export const HOOK_EVENTS = [
  'item_created',
  'item_name_changed',
  'column_changed',
  'item_deleted',
  'item_archived',
  'item_restored',
  'item_moved_to_board',
] as const;
const GONE_EVENTS = new Set(['item_deleted', 'item_archived']);

export type AppDeps = {
  env: Env;
  store: Store;
  crypto: Crypto;
  engine: Engine;
  /** The calendar providers by name (`google`, `caldav`); a connection names its own. */
  providers: Record<string, CalendarProvider>;
  /** Finds a CalDAV account from what the member typed (throws `CaldavError`). */
  discoverCaldav: (input: CaldavInput) => Promise<CaldavAccount & { calendars: ProviderCalendar[] }>;
  binesFor: (inst: InstallationRow) => BinesApi;
  /** A Bines client for credentials not saved yet (the `installed` call). */
  binesForCreds: (creds: ServerCredentials) => BinesApi;
  authFor: (inst: InstallationRow, conn: ConnectionRow) => Promise<ProviderAuth>;
  /** Where the pages are (public/ in development, dist/public in the image). */
  publicDir: string;
  fetch?: typeof fetch;
  now?: () => number;
};

type Who = { inst: InstallationRow; user: { id: string; name: string; email: string }; feature: string };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

/** The installation's own Google client, else the server's default, else none. */
export const googleClientOf = (deps: Pick<AppDeps, 'env' | 'crypto'>, inst: InstallationRow): GoogleClient | null => {
  if (inst.google_client)
    return {
      client_id: inst.google_client.client_id,
      client_secret: deps.crypto.decrypt(inst.google_client.secret_enc),
    };
  if (deps.env.GOOGLE_CLIENT_ID && deps.env.GOOGLE_CLIENT_SECRET)
    return { client_id: deps.env.GOOGLE_CLIENT_ID, client_secret: deps.env.GOOGLE_CLIENT_SECRET };
  return null;
};

export const createApp = (deps: AppDeps) => {
  const { env, store, crypto, engine } = deps;
  const now = () => deps.now?.() ?? Date.now();
  const app = new Hono();
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    // The pages' fonts (Heebo, Rubik), as the Bines app loads them.
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    `frame-ancestors ${env.BINES_ORIGIN}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');

  /** Background work: answered first, done after (errors go to the installation's log). */
  const later = (inst: InstallationRow | null, fn: () => Promise<unknown>) => {
    void fn().catch((e: Error) => {
      if (inst) void engine.log(inst, 'error', e.message);
      else console.error(`calendar-sync: ${e.message}`);
    });
  };

  // ---------------------------------------------------------------------------------------------------------
  // Health, manifest, pages
  // ---------------------------------------------------------------------------------------------------------

  // HSTS on every answer once we are served over https (the catalog's review asks for it, MARKETPLACE §8).
  if (env.PUBLIC_URL.startsWith('https://'))
    app.use('*', async (c, next) => {
      await next();
      c.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    });

  app.get('/health', (c) => c.json({ ok: true }));
  app.get('/manifest.json', (c) => c.json(manifest(env.PUBLIC_URL)));
  app.get('/config.js', (c) =>
    c.body(`export const HOST_ORIGIN = ${JSON.stringify(env.BINES_ORIGIN)};\n`, 200, {
      'content-type': TYPES['.js']!,
      'cache-control': 'no-cache',
    }),
  );

  let sdkJs: string | null = null;
  const sdkSource = async () => {
    if (sdkJs) return sdkJs;
    try {
      sdkJs = await readFile(join(deps.publicDir, 'sdk.js'), 'utf8');
    } catch {
      // Development: the SDK's TypeScript, types stripped (it is erasable TypeScript).
      const src = fileURLToPath(import.meta.resolve('@bines/ext-sdk'));
      sdkJs = stripTypeScriptTypes(await readFile(src, 'utf8'));
    }
    return sdkJs;
  };
  app.get('/sdk.js', async (c) => c.body(await sdkSource(), 200, { 'content-type': TYPES['.js']! }));

  const PAGES = new Set([
    'connect.html',
    'connect.js',
    'admin.html',
    'admin.js',
    'common.js',
    'strings.js',
    'done.js',
    'style.css',
  ]);
  app.get('/:file{[a-z]+\\.(html|js|css)}', async (c) => {
    const file = c.req.param('file');
    if (!PAGES.has(file)) return c.notFound();
    const body = await readFile(join(deps.publicDir, file), 'utf8');
    return c.body(body, 200, {
      'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'text/plain',
      'content-security-policy': csp,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-cache',
    });
  });

  // ---------------------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------------------

  app.post('/lifecycle', async (c) => {
    const raw = await c.req.text();
    let peek: { event?: string; installation?: { id?: string } };
    try {
      peek = JSON.parse(raw) as typeof peek;
    } catch {
      return c.json({ error: 'bad_json' }, 400);
    }
    const saved = peek.installation?.id ? await store.getInstallation(peek.installation.id) : null;
    let event: LifecycleEvent;
    try {
      event = await verifyLifecycle({
        // `installed` (also after "reconnect") is signed with the secret it brings; the rest with the saved one.
        secret:
          peek.event === 'installed' || !saved
            ? undefined
            : (JSON.parse(crypto.decrypt(saved.credentials_enc)) as ServerCredentials).signing_secret,
        headers: Object.fromEntries(c.req.raw.headers.entries()),
        body: raw,
        trustInstalled: true,
        platform: env.BINES_ORIGIN,
      });
    } catch {
      return c.json({ error: 'bad_signature' }, 401);
    }
    const id = event.installation.id;
    if (event.event === 'installed') {
      const creds = event.credentials!;
      // Proves the credentials (only the real Bines issues a token for them), that they are this installation's (valid
      // credentials of another installation must never replace these), and learns the service user.
      const api = deps.binesForCreds(creds);
      const grant = await api.grant().catch(() => null);
      if (!grant || grant.installation_id !== id || grant.account_id !== event.account.id)
        return c.json({ error: 'credentials_mismatch' }, 401);
      const me = await api.me();
      await store.putInstallation({
        id,
        account_id: event.account.id,
        status: 'active',
        credentials_enc: crypto.encrypt(JSON.stringify(creds)),
        service_user_id: me.id,
        config: saved?.config ?? null,
        google_client: saved?.google_client ?? null,
        hooks: saved?.hooks ?? null,
        last_sync_at: saved?.last_sync_at ?? null,
        created_at: saved?.created_at ?? new Date(now()).toISOString(),
      });
      return c.json({ ok: true });
    }
    if (!saved) return c.json({ ok: true });
    if (event.event === 'uninstalled') {
      await engine.shutdown(id);
      const client = googleClientOf(deps, saved);
      for (const conn of await store.listConnections(id))
        if (client && conn.provider === 'google') await revokeToken(crypto.decrypt(conn.refresh_token_enc), deps.fetch);
      await store.deleteInstallation(id);
      return c.json({ ok: true });
    }
    const status = event.event === 'disabled' ? 'disabled' : event.event === 'enabled' ? 'active' : saved.status;
    await store.putInstallation({ ...saved, status });
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------------------------------------
  // Bines board webhooks
  // ---------------------------------------------------------------------------------------------------------

  const seen = new Map<string, number>();
  const seenStore = {
    has: (s: string) => seen.has(s),
    add: (s: string) => {
      seen.set(s, now());
      if (seen.size > 5000) for (const [k, t] of seen) if (t < now() - 10 * 60_000) seen.delete(k);
    },
  };

  app.post('/bines/webhook', async (c) => {
    const raw = await c.req.text();
    let body: { challenge?: string; event?: { type?: string; subscriptionId?: string; itemId?: string | null } };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      return c.json({ error: 'bad_json' }, 400);
    }
    // The handshake when the webhook is created: echo the challenge.
    if (typeof body.challenge === 'string' && !body.event) return c.json({ challenge: body.challenge });
    const sub = body.event?.subscriptionId;
    const inst = sub ? (await store.listInstallations()).find((i) => i.hooks?.ids.includes(sub)) : undefined;
    if (!inst?.hooks) return c.json({ error: 'unknown_subscription' }, 404);
    const check = await verifyBinesSignature({
      secret: crypto.decrypt(inst.hooks.secret_enc),
      timestamp: c.req.header('x-bines-timestamp'),
      signature: c.req.header('x-bines-signature'),
      body: raw,
      now: now(),
      seen: seenStore,
    });
    if (check !== 'ok') return c.json({ error: check }, 401);
    const itemId = body.event?.itemId;
    if (itemId) {
      const type = body.event?.type ?? '';
      later(inst, () =>
        GONE_EVENTS.has(type) ? engine.itemGone(inst.id, itemId) : engine.itemChanged(inst.id, itemId),
      );
    }
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------------------------------------
  // Google push notifications
  // ---------------------------------------------------------------------------------------------------------

  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  app.post('/google/push', async (c) => {
    const channelId = c.req.header('x-goog-channel-id') ?? '';
    const token = c.req.header('x-goog-channel-token') ?? '';
    const state = c.req.header('x-goog-resource-state') ?? '';
    if (!channelId || !crypto.channelTokenOk(channelId, token)) return c.body(null, 204);
    const stream = await store.streamByChannel(channelId);
    if (!stream || state === 'sync') return c.body(null, 204);
    // A burst of changes = one read, a moment later.
    clearTimeout(pending.get(stream.id));
    pending.set(
      stream.id,
      setTimeout(() => {
        pending.delete(stream.id);
        later(null, () => engine.pullStream(stream.installation_id, stream.id));
      }, 1500),
    );
    return c.body(null, 204);
  });

  // ---------------------------------------------------------------------------------------------------------
  // Pages' API: who is asking (their page token → /ext/introspect)
  // ---------------------------------------------------------------------------------------------------------

  const introspected = new Map<string, { res: Introspection; until: number }>();
  const who = async (c: Context, admin: boolean): Promise<Who | Response> => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const instId = c.req.header('x-installation-id') ?? '';
    const inst = instId ? await store.getInstallation(instId) : null;
    if (!token || !inst) return c.json({ error: { code: 'not_installed' } }, 401);
    if (inst.status !== 'active') return c.json({ error: { code: 'disabled' } }, 403);
    const key = createHash('sha256').update(`${inst.id}:${token}`).digest('hex');
    let hit = introspected.get(key);
    if (!hit || hit.until < now()) {
      // Only an active answer is kept (a minute, well inside the token's life).
      hit = { res: await deps.binesFor(inst).introspect(token), until: now() + 60_000 };
      if (hit.res.active) introspected.set(key, hit);
      if (introspected.size > 2000) for (const [k, v] of introspected) if (v.until < now()) introspected.delete(k);
    }
    const r = hit.res;
    if (!r.active || r.account_id !== inst.account_id) return c.json({ error: { code: 'bad_token' } }, 401);
    // The settings page is the admins' (Bines mints its token for account admins only).
    if (admin && r.feature !== 'admin') return c.json({ error: { code: 'admins_only' } }, 403);
    return { inst, user: r.user, feature: r.feature };
  };
  const isResponse = (x: unknown): x is Response => x instanceof Response;

  const connectionView = (conn: ConnectionRow | null) =>
    conn
      ? {
          connected: true,
          provider: conn.provider,
          email: conn.account_email,
          status: conn.status,
          error: conn.error,
        }
      : { connected: false };

  /** A member's connection goes (a Google token is revoked; the events already in the calendar stay). */
  const dropConnection = async (inst: InstallationRow, conn: ConnectionRow) => {
    if (conn.provider === 'google' && googleClientOf(deps, inst))
      await revokeToken(crypto.decrypt(conn.refresh_token_enc), deps.fetch);
    await engine.disconnect(inst.id, conn.id);
  };

  /**
   * How a member's own sync stands: when their calendars were last read, the last error, and how many board items
   * are linked to events in them. Null while they have no connection.
   */
  const syncView = async (inst: InstallationRow, conn: ConnectionRow | null) => {
    if (!conn) return null;
    const streams = (await store.listStreams(inst.id)).filter((s) => s.connection_id === conn.id);
    const ids = new Set(streams.map((s) => s.id));
    const items = new Set((await store.listLinks(inst.id)).filter((l) => ids.has(l.stream_id)).map((l) => l.item_id));
    const times = streams.map((s) => s.last_sync_at).filter((x): x is string => !!x);
    return {
      last_sync_at: times.length ? times.sort().at(-1)! : null,
      error: streams.find((s) => s.last_error)?.last_error ?? null,
      items: items.size,
      calendars: streams.length,
      interval_minutes: env.SYNC_INTERVAL_MINUTES,
    };
  };

  /** The member's choices as they stand (none saved yet = their main calendar, nothing let in). */
  const prefsOf = (conn: ConnectionRow): MemberPrefs =>
    conn.prefs ?? { calendar_id: 'primary', calendar_name: null, import: 'none', days: 30, since: conn.created_at };

  /** The calendars of a member's account they may sync (writable ones; an error = none listed). */
  const calendarsOf = async (inst: InstallationRow, conn: ConnectionRow) => {
    try {
      const all = (await deps.providers[conn.provider]?.listCalendars(await deps.authFor(inst, conn))) ?? [];
      return all.filter((x) => x.writable);
    } catch {
      return null;
    }
  };

  app.get('/api/me', async (c) => {
    const w = await who(c, false);
    if (isResponse(w)) return w;
    const conn = await store.getConnection(w.inst.id, w.user.id);
    return c.json({
      user: { name: w.user.name, email: w.user.email },
      connection: connectionView(conn),
      google_ready: !!googleClientOf(deps, w.inst),
      caldav_ready: !!deps.providers.caldav,
      configured: !!w.inst.config,
      sync: await syncView(w.inst, conn),
      prefs: conn ? prefsOf(conn) : null,
      calendars: conn ? await calendarsOf(w.inst, conn) : null,
      // What the admin lets members choose: up to this, and this many days back.
      allowed: { import: w.inst.config?.member_import ?? 'existing', max_days: w.inst.config?.past_days ?? 30 },
    });
  });

  // A member's choices: which of their calendars syncs, and what of it comes into the board.
  app.put('/api/prefs', async (c) => {
    const w = await who(c, false);
    if (isResponse(w)) return w;
    const conn = await store.getConnection(w.inst.id, w.user.id);
    if (!conn) return c.json({ error: { code: 'not_connected' } }, 409);
    const b = (await c.req.json().catch(() => ({}))) as Partial<Record<'calendar_id' | 'import' | 'days', unknown>>;
    const before = prefsOf(conn);
    const next: MemberPrefs = { ...before };
    if (b.calendar_id !== undefined && b.calendar_id !== before.calendar_id) {
      const cal = (await calendarsOf(w.inst, conn))?.find(
        (x) => x.id === b.calendar_id || (b.calendar_id === 'primary' && x.primary),
      );
      if (!cal) return c.json({ error: { code: 'calendar_unknown' } }, 422);
      next.calendar_id = cal.primary ? 'primary' : cal.id;
      next.calendar_name = cal.primary ? null : cal.name;
    }
    if (b.import !== undefined) {
      if (b.import !== 'none' && b.import !== 'new' && b.import !== 'existing')
        return c.json({ error: { code: 'invalid' } }, 422);
      if (memberImport(b.import, w.inst.config ?? { member_import: 'existing' }) !== b.import)
        return c.json({ error: { code: 'import_not_allowed' } }, 422);
      next.import = b.import;
      // "From now on" starts when it is chosen.
      if (b.import === 'new' && before.import !== 'new') next.since = new Date(now()).toISOString();
    }
    if (b.days !== undefined) {
      const max = w.inst.config?.past_days ?? 30;
      if (typeof b.days !== 'number' || !Number.isInteger(b.days) || b.days < 0 || b.days > max)
        return c.json({ error: { code: 'invalid' } }, 422);
      next.days = b.days;
    }
    await store.putConnection({ ...conn, prefs: next });
    if (w.inst.config) {
      const widened =
        (next.import === 'existing' && (before.import !== 'existing' || next.days > before.days)) ||
        next.calendar_id !== before.calendar_id;
      later(w.inst, async () => {
        await engine.ensureStreams(w.inst.id);
        // Letting in more (or another calendar): that calendar is read again from the start; what is linked stays.
        if (widened)
          for (const s of await store.listStreams(w.inst.id))
            if (s.connection_id === conn.id && s.role === 'personal') await store.putStream({ ...s, sync_token: null });
        await engine.syncAll(w.inst.id, { items: next.calendar_id !== before.calendar_id });
      });
    }
    return c.json({ ok: true, prefs: next });
  });

  // "Sync now" on a member's page: their own calendars are read at once (board changes already go out as they
  // happen), and the page gets the new state back.
  app.post('/api/sync', async (c) => {
    const w = await who(c, false);
    if (isResponse(w)) return w;
    if (!w.inst.config) return c.json({ error: { code: 'not_configured' } }, 409);
    const conn = await store.getConnection(w.inst.id, w.user.id);
    if (!conn) return c.json({ error: { code: 'not_connected' } }, 409);
    await engine.ensureStreams(w.inst.id);
    for (const s of await store.listStreams(w.inst.id))
      if (s.connection_id === conn.id) await engine.pullStream(w.inst.id, s.id);
    return c.json({ ok: true, sync: await syncView(w.inst, conn) });
  });

  // CalDAV: the member's server address, user name and app password. Discovery runs first, so only an account that
  // answers is saved; the password is stored encrypted, like a Google refresh token.
  app.post('/api/connect/caldav', async (c) => {
    const w = await who(c, false);
    if (isResponse(w)) return w;
    if (!deps.providers.caldav) return c.json({ error: { code: 'caldav_off' } }, 409);
    const b = (await c.req.json().catch(() => ({}))) as Partial<Record<'url' | 'username' | 'password', unknown>>;
    const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim().length <= max ? v.trim() : '');
    const input = { url: str(b.url, 500), username: str(b.username, 320), password: str(b.password, 500) };
    if (!input.url) return c.json({ error: { code: 'caldav_bad_url' } }, 422);
    if (!input.username || !input.password) return c.json({ error: { code: 'caldav_credentials' } }, 422);
    let found;
    try {
      found = await deps.discoverCaldav(input);
    } catch (e) {
      if (e instanceof CaldavError) return c.json({ error: { code: `caldav_${e.code}` } }, 422);
      throw e;
    }
    const { calendars: _calendars, ...secret } = found;
    const existing = await store.getConnection(w.inst.id, w.user.id);
    if (existing) await dropConnection(w.inst, existing);
    await store.putConnection({
      id: randomId(),
      installation_id: w.inst.id,
      user_id: w.user.id,
      user_name: w.user.name,
      user_email: w.user.email,
      provider: 'caldav',
      account_email: secret.email ?? input.username,
      refresh_token_enc: crypto.encrypt(JSON.stringify(secret)),
      status: 'ok',
      error: null,
      created_at: new Date(now()).toISOString(),
    });
    if (w.inst.config) later(w.inst, () => engine.syncAll(w.inst.id, { items: true }));
    return c.json({ ok: true, connection: connectionView(await store.getConnection(w.inst.id, w.user.id)) });
  });

  app.post('/api/connect', async (c) => {
    const w = await who(c, false);
    if (isResponse(w)) return w;
    const client = googleClientOf(deps, w.inst);
    if (!client) return c.json({ error: { code: 'google_not_configured' } }, 409);
    const state = crypto.sign(
      'oauth',
      { i: w.inst.id, u: w.user.id, nm: w.user.name, em: w.user.email },
      10 * 60_000,
      now(),
    );
    // The ticket lets the page ask how the consent ended: a Bines page sends Cross-Origin-Opener-Policy, so the
    // popup has no opener to tell and the page gets no handle to watch.
    const ticket = crypto.verify<{ n: string }>('oauth', state, now())!.n;
    return c.json({ url: authorizeUrl(client, redirectUri(env), state, w.user.email), ticket });
  });

  // The consent starts here, in a top-level window Bines opens on our own origin (`openWindow`): Google's sign-in
  // will not load in a window that inherits the frame's sandbox. Only a state we signed leads to Google.
  app.get('/oauth/google/go', async (c) => {
    const s = c.req.query('state') ?? '';
    const state = crypto.verify<{ i: string; em: string }>('oauth', s, now());
    const inst = state ? await store.getInstallation(state.i) : null;
    const client = inst ? googleClientOf(deps, inst) : null;
    if (!state || !client) return done(c, 'bad_state');
    return c.redirect(authorizeUrl(client, redirectUri(env), s, state.em), 302);
  });

  app.get('/api/connect/:ticket', async (c) => {
    const w = await who(c, false);
    if (isResponse(w)) return w;
    const hit = outcomes.get(c.req.param('ticket'));
    return c.json({ status: hit && hit.u === w.user.id ? hit.status : null });
  });

  app.delete('/api/connection', async (c) => {
    const w = await who(c, false);
    if (isResponse(w)) return w;
    const conn = await store.getConnection(w.inst.id, w.user.id);
    if (conn) await dropConnection(w.inst, conn);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------------------------------------------
  // OAuth callback (in the popup the page opened)
  // ---------------------------------------------------------------------------------------------------------

  const usedStates = new Map<string, number>();
  /** How each consent ended, by its ticket (the state's nonce), for the page that started it. */
  const outcomes = new Map<string, { u: string; status: string; x: number }>();
  const done = (c: Context, status: string) =>
    c.html(
      `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>Google</title>` +
        `<link rel="stylesheet" href="/style.css"></head><body data-status="${status.replace(/[^a-z_]/g, '')}">` +
        `<p id="msg"></p><script type="module" src="/done.js"></script></body></html>`,
      200,
      { 'content-security-policy': csp.replace(/frame-ancestors [^;]+/, "frame-ancestors 'none'") },
    );

  app.get('/oauth/google/callback', async (c) => {
    const state = crypto.verify<{ i: string; u: string; nm: string; em: string; n: string }>(
      'oauth',
      c.req.query('state') ?? '',
      now(),
    );
    if (!state || usedStates.has(state.n)) return done(c, 'bad_state');
    usedStates.set(state.n, state.x);
    for (const [k, x] of usedStates) if (x < now()) usedStates.delete(k);
    for (const [k, o] of outcomes) if (o.x < now()) outcomes.delete(k);
    const end = (status: string) => {
      outcomes.set(state.n, { u: state.u, status, x: now() + 10 * 60_000 });
      return done(c, status);
    };
    if (c.req.query('error')) return end('denied');
    const inst = await store.getInstallation(state.i);
    const client = inst ? googleClientOf(deps, inst) : null;
    const code = c.req.query('code');
    if (!inst || !client || !code) return end('not_configured');
    let tokens;
    try {
      tokens = await exchangeCode(client, redirectUri(env), code, deps.fetch);
    } catch {
      return end('exchange_failed');
    }
    let existing = await store.getConnection(inst.id, state.u);
    if (existing && existing.provider !== 'google') {
      // Google instead of another provider: the old connection (and its calendars' streams) goes.
      await engine.disconnect(inst.id, existing.id);
      existing = null;
    }
    const refresh = tokens.refreshToken ?? (existing ? crypto.decrypt(existing.refresh_token_enc) : null);
    if (!refresh) return end('no_refresh_token');
    await store.putConnection({
      id: existing?.id ?? randomId(),
      installation_id: inst.id,
      user_id: state.u,
      user_name: state.nm,
      user_email: state.em,
      provider: 'google',
      account_email: tokens.email,
      refresh_token_enc: crypto.encrypt(refresh),
      status: 'ok',
      error: null,
      created_at: existing?.created_at ?? new Date(now()).toISOString(),
      // The same account connected again keeps the member's choices; another account starts from none.
      prefs: existing?.account_email === tokens.email ? (existing.prefs ?? null) : null,
    });
    if (inst.config) later(inst, () => engine.syncAll(inst.id, { items: true }));
    return end('ok');
  });

  // ---------------------------------------------------------------------------------------------------------
  // The admin page
  // ---------------------------------------------------------------------------------------------------------

  const clientView = (inst: InstallationRow) =>
    inst.google_client
      ? { source: 'account', client_id: inst.google_client.client_id, secret_hint: inst.google_client.hint }
      : env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
        ? { source: 'server', client_id: env.GOOGLE_CLIENT_ID, secret_hint: secretHint(env.GOOGLE_CLIENT_SECRET) }
        : { source: 'none', client_id: null, secret_hint: null };

  app.get('/api/admin/state', async (c) => {
    const w = await who(c, true);
    if (isResponse(w)) return w;
    const api = deps.binesFor(w.inst);
    const [boards, conns, streams, log] = await Promise.all([
      api.listBoards().catch(() => []),
      store.listConnections(w.inst.id),
      store.listStreams(w.inst.id),
      store.recentLog(w.inst.id, 30),
    ]);
    const mine = conns.find((x) => x.user_id === w.user.id) ?? null;
    let calendars: { id: string; name: string; primary: boolean; writable: boolean }[] = [];
    if (mine)
      try {
        calendars = (await deps.providers[mine.provider]?.listCalendars(await deps.authFor(w.inst, mine))) ?? [];
      } catch {
        /* shown as "connect again" */
      }
    const byConn = new Map(conns.map((x) => [x.id, x]));
    return c.json({
      me: { id: w.user.id, name: w.user.name, connection: connectionView(mine) },
      config: w.inst.config,
      client: clientView(w.inst),
      caldav_ready: !!deps.providers.caldav,
      redirect_uri: redirectUri(env),
      urls: {
        redirect_uri: redirectUri(env),
        push: `${env.PUBLIC_URL}/google/push`,
        webhook: `${env.PUBLIC_URL}/bines/webhook`,
        lifecycle: `${env.PUBLIC_URL}/lifecycle`,
        origin: env.PUBLIC_URL,
      },
      boards: boards.map((b) => ({ id: b.id, name: b.name })),
      calendars,
      status: {
        last_sync_at: w.inst.last_sync_at,
        connections: conns.length,
        hooks: w.inst.hooks?.ids.length ?? 0,
        streams: streams.map((s) => ({
          role: s.role,
          calendar_id: s.calendar_id,
          user: byConn.get(s.connection_id)?.user_name ?? '',
          email: byConn.get(s.connection_id)?.account_email ?? '',
          last_sync_at: s.last_sync_at,
          last_error: s.last_error,
          push_until: s.channel?.expires_at ?? null,
        })),
        log,
      },
    });
  });

  app.get('/api/admin/board', async (c) => {
    const w = await who(c, true);
    if (isResponse(w)) return w;
    const b = await deps.binesFor(w.inst).getBoard(c.req.query('id') ?? '');
    return c.json({
      id: b.id,
      name: b.name,
      columns: b.columns.map((x) => ({ id: x.id, type: x.type, title: x.title })),
      groups: b.groups.map((g) => ({ id: g.id, title: g.title })),
    });
  });

  /** The board's columns fit the settings (types per role). */
  const checkColumns = (cfg: SyncConfig, cols: Map<string, string>): string | null => {
    const want: [string | null | undefined, string[], string][] = [
      [cfg.date_column_id, cfg.time_source === 'timeline' ? ['timeline'] : ['date', 'timeline'], 'date_column'],
      [cfg.start_column_id, ['hour'], 'start_column'],
      [cfg.end_column_id, ['hour'], 'end_column'],
      [cfg.people_column_id, ['people'], 'people_column'],
      [cfg.attendees.email_column_id, ['email', 'text', 'long_text'], 'email_column'],
      [cfg.rsvp.column_id, ['status'], 'rsvp_column'],
      [cfg.delete_status?.column_id, ['status'], 'delete_status_column'],
    ];
    for (const [id, types, code] of want) if (id && !types.includes(cols.get(id) ?? '')) return code;
    for (const f of cfg.template.fields) if (!cols.has(f.column_id)) return 'template_column';
    if (cfg.target !== 'personal' && !cfg.shared) return 'shared_calendar';
    if (cfg.target !== 'shared' && !cfg.people_column_id) return 'people_column';
    if (cfg.on_google_delete === 'status' && !cfg.delete_status) return 'delete_status_column';
    return null;
  };

  /** The board's webhooks, made by this server (to its own origin), once per board. */
  const ensureHooks = async (inst: InstallationRow, boardId: string, api: BinesApi) => {
    if (inst.hooks?.board_id === boardId && inst.hooks.ids.length === HOOK_EVENTS.length) return inst.hooks;
    for (const id of inst.hooks?.ids ?? []) await api.deleteWebhook(id).catch(() => undefined);
    const secret = randomBytes(32).toString('hex');
    const hooks = { board_id: boardId, ids: [] as string[], secret_enc: crypto.encrypt(secret) };
    // Saved before the first one is made: a delivery can arrive before the last is.
    await store.putInstallation({ ...inst, hooks });
    for (const event of HOOK_EVENTS) {
      const h = await api.createWebhook(boardId, {
        url: `${env.PUBLIC_URL}/bines/webhook`,
        event,
        secret,
        description: 'Calendar sync',
      });
      hooks.ids.push(h.id);
      await store.putInstallation({ ...inst, hooks });
    }
    return hooks;
  };

  app.put('/api/admin/config', async (c) => {
    const w = await who(c, true);
    if (isResponse(w)) return w;
    const parsed = syncConfigSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json(
        { error: { code: 'invalid', message: parsed.error.issues.map((i) => i.path.join('.')).join(', ') } },
        422,
      );
    const cfg = parsed.data;
    const api = deps.binesFor(w.inst);
    let board;
    try {
      board = await api.getBoard(cfg.board_id);
    } catch {
      return c.json({ error: { code: 'board_not_granted' } }, 422);
    }
    const bad = checkColumns(cfg, new Map(board.columns.map((x) => [x.id, x.type])));
    if (bad) return c.json({ error: { code: bad } }, 422);
    let hooks;
    try {
      hooks = await ensureHooks(w.inst, cfg.board_id, api);
    } catch (e) {
      return c.json({ error: { code: 'webhooks_failed', message: (e as Error).message } }, 502);
    }
    const fresh = (await store.getInstallation(w.inst.id)) ?? w.inst;
    await store.putInstallation({ ...fresh, config: cfg, hooks });
    await engine.ensureStreams(w.inst.id);
    later(fresh, () => engine.syncAll(w.inst.id));
    return c.json({ ok: true, config: cfg });
  });

  app.put('/api/admin/google-client', async (c) => {
    const w = await who(c, true);
    if (isResponse(w)) return w;
    const b = (await c.req.json().catch(() => ({}))) as { client_id?: string; client_secret?: string };
    const id = (b.client_id ?? '').trim();
    const secret = (b.client_secret ?? '').trim();
    if (!/^[\w.-]{8,200}$/.test(id)) return c.json({ error: { code: 'client_id' } }, 422);
    const keep = w.inst.google_client?.client_id === id && !secret ? w.inst.google_client : null;
    if (!keep && secret.length < 8) return c.json({ error: { code: 'client_secret' } }, 422);
    const google_client = keep ?? { client_id: id, secret_enc: crypto.encrypt(secret), hint: secretHint(secret) };
    await store.putInstallation({ ...w.inst, google_client });
    return c.json({ ok: true, client: clientView({ ...w.inst, google_client }) });
  });

  app.delete('/api/admin/google-client', async (c) => {
    const w = await who(c, true);
    if (isResponse(w)) return w;
    await store.putInstallation({ ...w.inst, google_client: null });
    return c.json({ ok: true, client: clientView({ ...w.inst, google_client: null }) });
  });

  app.post('/api/admin/sync', async (c) => {
    const w = await who(c, true);
    if (isResponse(w)) return w;
    if (!w.inst.config) return c.json({ error: { code: 'not_configured' } }, 409);
    later(w.inst, () => engine.syncAll(w.inst.id));
    return c.json({ ok: true }, 202);
  });

  app.onError((e, c) => {
    console.error(`calendar-sync: ${c.req.method} ${c.req.path}: ${e.message}`);
    return c.json({ error: { code: 'server_error' } }, 500);
  });

  return app;
};
