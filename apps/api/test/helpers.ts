// SPDX-License-Identifier: AGPL-3.0-only
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { expect } from 'vitest';
import { createApp } from '../src/app';
import { MIGRATIONS_DIR, schema, type Db } from '../src/db/client';
import { createDeps } from '../src/deps';
import { loadEnv } from '../src/env';
import { memoryMailer } from '@bines/server-mail';
import type { AiClientFactory } from '@bines/server-ai';
import { memorySms } from '../src/lib/sms';
import { memoryStorage } from '../src/lib/storage';
import { createLogger } from '../src/lib/logger';
import { createListenBus } from '../src/lib/realtime';
import { seedBuiltinTemplates } from '../src/modules/boards/templates';
import { seedCatalogPacks } from '../src/modules/extensions/packs';

export const OWNER_EMAIL = 'owner@bines.test';
export const WEB_ORIGIN = 'http://localhost:5173';

/** A fresh in-process Postgres (PGlite) with the real migrations, plus the app wired to it. */
export const createTestContext = async (
  opts: { webDistDir?: string; env?: Record<string, string>; aiClient?: AiClientFactory } = {},
) => {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  await seedBuiltinTemplates(db as unknown as Db, '../../seed/templates');
  await seedCatalogPacks(db as unknown as Db, '../../seed/packs');

  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.TEST_LOG ?? 'silent',
    WEB_ORIGIN,
    SEED_ADMIN_EMAIL: OWNER_EMAIL,
    // Address completion (Photon) never reaches the internet from tests: a closed local port unless a test fakes it.
    PHOTON_URL: 'http://127.0.0.1:9',
    BETTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-123',
    ...opts.env,
  });
  const mailer = memoryMailer();
  const sms = memorySms();
  const storage = memoryStorage();
  const logger = createLogger(env);
  const bus = createListenBus((channel, fn) => client.listen(channel, fn), logger);
  const deps = createDeps({ env, logger, db: db as unknown as Db, mailer, sms, storage, bus, aiClient: opts.aiClient });
  const app = createApp(deps, opts);

  const lastMailTo = (to: string) => {
    const mail = [...mailer.sent].reverse().find((m) => m.to === to);
    expect(mail, `no email to ${to}`).toBeDefined();
    return mail!;
  };

  /** Session cookie header from a Better Auth response. */
  const cookieFrom = (res: Response) => {
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(';')[0]!)
      .find((c) => c.startsWith('bos.session_token='));
    return cookie;
  };

  /** Owner / invited user signing in through a magic link (the link is read from the in-memory mailer). */
  const signInWithMagicLink = async (email: string) => {
    const res = await app.request('/api/auth/sign-in/magic-link', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: WEB_ORIGIN },
      body: JSON.stringify({ email, callbackURL: '/' }),
    });
    expect(res.status).toBe(200);
    const url = new URL(/https?:\/\/[^\s"]+magic-link\/verify[^\s"<]+/.exec(lastMailTo(email).text)![0]);
    const verify = await app.request(`${url.pathname}${url.search}`, { headers: { origin: WEB_ORIGIN } });
    return { res: verify, cookie: cookieFrom(verify) };
  };

  const signUpWithPassword = (email: string, inviteToken?: string) =>
    app.request('/api/auth/sign-up/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: WEB_ORIGIN,
        ...(inviteToken ? { 'x-invite-token': inviteToken } : {}),
      },
      body: JSON.stringify({ email, password: 'correct-horse-battery', name: email.split('@')[0] }),
    });

  /** Calls /api/v1 as a session (cookie) and optionally inside an account. */
  const api = (cookie: string | undefined, accountId?: string) => {
    const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
      app.request(`/api/v1${path}`, {
        method,
        headers: {
          origin: WEB_ORIGIN,
          ...(cookie ? { cookie } : {}),
          ...(accountId ? { 'x-account-id': accountId } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return {
      call,
      get: (path: string) => call('GET', path),
      post: (path: string, body?: unknown) => call('POST', path, body ?? {}),
      patch: (path: string, body: unknown) => call('PATCH', path, body),
      put: (path: string, body: unknown) => call('PUT', path, body),
      del: (path: string, body?: unknown) => call('DELETE', path, body),
    };
  };

  /** Invitation token from the most recent invitation email to `email`. */
  const inviteTokenFor = (email: string) => /\/invite\/([\w-]+)/.exec(lastMailTo(email).text)![1]!;

  return {
    app,
    db,
    /** The raw PGlite client (for code that takes plain SQL, like the worker's purge). */
    pg: client,
    mailer,
    sms,
    storage,
    deps,
    lastMailTo,
    signInWithMagicLink,
    signUpWithPassword,
    cookieFrom,
    api,
    inviteTokenFor,
    close: async () => {
      await bus.close();
      await client.close();
    },
  };
};

export type TestContext = Awaited<ReturnType<typeof createTestContext>>;
