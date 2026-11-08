// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The calendar-sync server: configuration from the environment, the store (Postgres, migrations on boot), the
 * HTTP app, and the periodic job (each calendar's changes, push channel renewals, the board reconcile).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { ServerCredentials } from '@bines/ext-sdk/server';
import { createApp, googleClientOf } from './app';
import { binesApi, type BinesApi } from './bines';
import { createCrypto } from './crypto';
import { readEnv } from './env';
import { caldavProvider } from './caldav';
import { googleAuth, googleProvider } from './google';
import type { CaldavAccount, ProviderAuth } from './provider';
import { memoryStore, type ConnectionRow, type InstallationRow, type Store } from './store';
import { pgStore } from './store-pg';
import { createEngine } from './sync';

// Every outside call (Bines, Google, CalDAV) gives up after 30 s, so a page or a sync never waits on a hung connection.
const baseFetch = globalThis.fetch;
globalThis.fetch = ((input, init) =>
  baseFetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(30_000) })) as typeof fetch;

const env = readEnv();
const crypto = createCrypto(env.CALSYNC_ENCRYPTION_KEY);
const store: Store = env.DATABASE_URL ? await pgStore(env.DATABASE_URL) : memoryStore();
if (!env.DATABASE_URL)
  console.warn('calendar-sync: DATABASE_URL is not set — keeping everything in memory (development only)');

const binesCache = new Map<string, { key: string; api: BinesApi }>();
const binesFor = (inst: InstallationRow) => {
  const hit = binesCache.get(inst.id);
  if (hit?.key === inst.credentials_enc) return hit.api;
  const api = binesApi(JSON.parse(crypto.decrypt(inst.credentials_enc)) as ServerCredentials);
  binesCache.set(inst.id, { key: inst.credentials_enc, api });
  return api;
};

const authCache = new Map<string, { key: string; auth: ProviderAuth }>();
// A development server (plain http) may reach a CalDAV server on this machine; production only public https ones.
const dev = process.env.NODE_ENV !== 'production' && env.PUBLIC_URL.startsWith('http://');
const caldav = caldavProvider(fetch, { allowHttp: dev, allowPrivate: dev });
const providers = { google: googleProvider(), caldav };
const deps = {
  store,
  providers,
  bines: binesFor,
  authFor: async (
    inst: InstallationRow,
    conn: Pick<ConnectionRow, 'id' | 'provider' | 'refresh_token_enc'>,
  ): Promise<ProviderAuth> => {
    if (conn.provider === 'caldav')
      return { caldav: JSON.parse(crypto.decrypt(conn.refresh_token_enc)) as CaldavAccount };
    const client = googleClientOf({ env, crypto }, inst);
    if (!client) throw new Error('google_not_configured');
    const key = `${client.client_id}|${conn.refresh_token_enc}`;
    const hit = authCache.get(conn.id);
    if (hit?.key === key) return hit.auth;
    const auth = googleAuth(client, crypto.decrypt(conn.refresh_token_enc));
    authCache.set(conn.id, { key, auth });
    return auth;
  },
  // Google pushes only to https addresses.
  pushAddress: env.PUBLIC_URL.startsWith('https://') ? `${env.PUBLIC_URL}/google/push` : null,
  channelToken: crypto.channelToken,
};
const engine = createEngine(deps);

const built = fileURLToPath(new URL('./public', import.meta.url));
const publicDir = existsSync(built) ? built : fileURLToPath(new URL('../public', import.meta.url));
const app = createApp({
  env,
  store,
  crypto,
  engine,
  providers,
  discoverCaldav: caldav.discover,
  binesFor,
  binesForCreds: (creds) => binesApi(creds),
  authFor: deps.authFor,
  publicDir,
});

serve({ fetch: app.fetch, port: env.PORT }, () =>
  console.warn(`calendar-sync on :${env.PORT} (${env.PUBLIC_URL}; Bines ${env.BINES_ORIGIN})`),
);

// The periodic job: every calendar's changes (for Google the fallback when a push is missed; for CalDAV, which has
// no push, the only way changes arrive), channel renewals, and now and then every board item (a webhook that never
// arrived).
let lastReconcile = 0;
let running = false;
setInterval(() => {
  if (running) return;
  running = true;
  const items = Date.now() - lastReconcile > env.RECONCILE_MINUTES * 60_000;
  if (items) lastReconcile = Date.now();
  void (async () => {
    for (const inst of await store.listInstallations())
      if (inst.status === 'active' && inst.config)
        await engine.syncAll(inst.id, { items }).catch((e: Error) => console.error(`calendar-sync: ${e.message}`));
  })().finally(() => {
    running = false;
  });
}, env.SYNC_INTERVAL_MINUTES * 60_000).unref?.();

const stop = () => {
  void store.close().finally(() => process.exit(0));
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
