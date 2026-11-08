// SPDX-License-Identifier: AGPL-3.0-only
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { microsoft, google } from 'better-auth/social-providers';
import {
  LOGIN_PROVIDERS,
  type LoginProvider,
  type LoginProviderState,
  loginProviderTestSchema,
  MICROSOFT_DEFAULT_TENANT,
  type UpdateLoginProvider,
  updateLoginProviderSchema,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { platformSettings } from '../../db/schema';
import type { Env } from '../../env';
import { createSecretBox, keyHint } from '../../lib/secrets';
import type { AppDeps, SessionUser } from '../../types';
import { publicAddress } from './public-address';

/**
 * Sign-in providers (owner console → "ספקי התחברות"): Google and Microsoft (Entra ID). One row in
 * platform_settings (id `login_providers`); the client secrets are sealed (lib/secrets.ts) and never leave the
 * server. When a provider has no credentials saved, the environment's are used (GOOGLE_CLIENT_ID / _SECRET,
 * MICROSOFT_CLIENT_ID / _SECRET / _TENANT_ID). Better Auth reads the resulting providers per request
 * (auth/auth.ts → `syncSocialProviders`), so a change applies without a restart.
 */
const ROW_ID = 'login_providers';
const CACHE_MS = 30_000;
const BASE_PATH = '/api/auth';

const storedProviderSchema = z.object({
  enabled: z.boolean().default(true),
  client_id: z.string().nullable().default(null),
  secret_enc: z.string().nullable().default(null),
  secret_hint: z.string().nullable().default(null),
  tenant_id: z.string().nullable().default(null),
  last_test: loginProviderTestSchema.nullable().default(null),
});
const storedSchema = z.object({
  google: storedProviderSchema.default(storedProviderSchema.parse({})),
  microsoft: storedProviderSchema.default(storedProviderSchema.parse({})),
});
type Stored = z.infer<typeof storedSchema>;
type StoredProvider = z.infer<typeof storedProviderSchema>;

const cache = new WeakMap<object, { at: number; value: Stored }>();

const parse = (raw: unknown): Stored => {
  const parsed = storedSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : storedSchema.parse({});
};

export const loadLoginProviders = async (db: Db): Promise<Stored> => {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const row = (await db.select().from(platformSettings).where(eq(platformSettings.id, ROW_ID)).limit(1))[0];
  const value = parse(row?.settings);
  cache.set(db, { at: Date.now(), value });
  return value;
};

const store = async (db: Db, by: string, next: Stored) => {
  const value = storedSchema.parse(next);
  await db
    .insert(platformSettings)
    .values({ id: ROW_ID, settings: value, updatedBy: by })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { settings: value, updatedBy: by, updatedAt: new Date() },
    });
  cache.delete(db);
  return value;
};

type ProviderEnv = Pick<
  Env,
  | 'GOOGLE_CLIENT_ID'
  | 'GOOGLE_CLIENT_SECRET'
  | 'MICROSOFT_CLIENT_ID'
  | 'MICROSOFT_CLIENT_SECRET'
  | 'MICROSOFT_TENANT_ID'
  | 'SECRETS_KEY'
  | 'BETTER_AUTH_SECRET'
>;

const envCredentials = (env: ProviderEnv, id: LoginProvider) =>
  id === 'google'
    ? env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }
      : null
    : env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
      ? { clientId: env.MICROSOFT_CLIENT_ID, clientSecret: env.MICROSOFT_CLIENT_SECRET }
      : null;

/** The return address to register with a provider: the public address (M11) + Better Auth's callback path. */
export const redirectUriOf = (webOrigin: string, id: LoginProvider) => `${webOrigin}${BASE_PATH}/callback/${id}`;

export type ResolvedProvider = {
  id: LoginProvider;
  enabled: boolean;
  source: 'setting' | 'env' | 'none';
  active: boolean;
  tenantId: string;
  redirectURI: string;
  /** Only when active; never sent anywhere but to Better Auth. */
  credentials: { clientId: string; clientSecret: string } | null;
};

/** Each provider in effect: the console's credentials, else the environment's; on when switched on and complete. */
export const resolveProviders = (
  stored: Stored,
  env: ProviderEnv,
  webOrigin: string,
  open: (sealed: string) => string = createSecretBox(env).open,
): ResolvedProvider[] =>
  LOGIN_PROVIDERS.map((id) => {
    const s: StoredProvider = stored[id];
    let credentials: ResolvedProvider['credentials'] = null;
    let source: ResolvedProvider['source'] = 'none';
    if (s.client_id && s.secret_enc) {
      try {
        credentials = { clientId: s.client_id, clientSecret: open(s.secret_enc) };
        source = 'setting';
      } catch {
        // A secret sealed under another key (SECRETS_KEY changed): treated as missing — the owner enters it again.
      }
    }
    if (!credentials) {
      credentials = envCredentials(env, id);
      if (credentials) source = 'env';
    }
    const active = s.enabled && !!credentials;
    return {
      id,
      enabled: s.enabled,
      source,
      active,
      tenantId: s.tenant_id ?? env.MICROSOFT_TENANT_ID ?? MICROSOFT_DEFAULT_TENANT,
      redirectURI: redirectUriOf(webOrigin, id),
      credentials: active ? credentials : null,
    };
  });

/**
 * The emails a Microsoft account can vouch for. Personal accounts' addresses are verified by Microsoft; in a work /
 * school directory the `email` claim is set by that directory's admin, so it counts only when Microsoft says the
 * directory owns the domain (`xms_edov`, an optional claim the app registration adds) or the token says verified.
 * An unverified address can neither use an invitation nor link to an existing person ("nOAuth").
 */
export const MICROSOFT_CONSUMER_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
export const microsoftEmailVerified = (claims: Record<string, unknown>) => {
  const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : null;
  if (!email) return false;
  if (claims.email_verified === true) return true;
  if (claims.tid === MICROSOFT_CONSUMER_TENANT) return true;
  if (claims.xms_edov === true || claims.xms_edov === '1' || claims.xms_edov === 'true') return true;
  const listed = (v: unknown) => Array.isArray(v) && v.some((x) => typeof x === 'string' && x.toLowerCase() === email);
  return listed(claims.verified_primary_email) || listed(claims.verified_secondary_email);
};

type BetterAuthProvider = ReturnType<typeof google> | ReturnType<typeof microsoft>;

/** Better Auth's provider objects for what is active (the same factories `socialProviders` options use). */
export const buildSocialProviders = (resolved: ResolvedProvider[]): BetterAuthProvider[] =>
  resolved.flatMap((p): BetterAuthProvider[] => {
    if (!p.active || !p.credentials) return [];
    if (p.id === 'google') return [google({ ...p.credentials, redirectURI: p.redirectURI, prompt: 'select_account' })];
    return [
      microsoft({
        ...p.credentials,
        tenantId: p.tenantId,
        redirectURI: p.redirectURI,
        prompt: 'select_account',
        // The photo would be stored as a data: URL on the person (large); the app has its own avatars.
        disableProfilePhoto: true,
        mapProfileToUser: (profile) => ({ emailVerified: microsoftEmailVerified(profile as Record<string, unknown>) }),
      }),
    ];
  });

/** The providers the sign-in screen offers now (GET /auth/config). */
export const activeLoginProviders = async (deps: Pick<AppDeps, 'db' | 'env'>) => {
  const web = (await publicAddress(deps)).web;
  const resolved = resolveProviders(await loadLoginProviders(deps.db), deps.env, web);
  return Object.fromEntries(resolved.map((p) => [p.id, p.active])) as Record<LoginProvider, boolean>;
};

const stateOf = (stored: Stored, resolved: ResolvedProvider[], env: ProviderEnv): LoginProviderState[] =>
  resolved.map((p) => {
    const s = stored[p.id];
    return {
      provider: p.id,
      enabled: s.enabled,
      client_id: s.client_id,
      has_secret: !!s.secret_enc,
      secret_hint: s.secret_enc ? s.secret_hint : null,
      tenant_id: p.id === 'microsoft' ? s.tenant_id : null,
      source: p.source,
      active: p.active,
      redirect_uri: p.redirectURI,
      env_configured: !!envCredentials(env, p.id),
      last_test: s.last_test,
    };
  });

/** GET /platform/login-providers (platform owner). */
export const listLoginProviders = async (deps: Pick<AppDeps, 'db' | 'env' | 'secrets'>) => {
  const stored = await loadLoginProviders(deps.db);
  const web = (await publicAddress(deps)).web;
  return { data: stateOf(stored, resolveProviders(stored, deps.env, web, deps.secrets.open), deps.env) };
};

/** PATCH /platform/login-providers/{provider}: only what is sent changes; the secret is sealed, never returned. */
export const updateLoginProvider = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'secrets' | 'logger'>,
  owner: SessionUser,
  id: LoginProvider,
  raw: UpdateLoginProvider,
) => {
  const patch = updateLoginProviderSchema.parse(raw);
  const current = await loadLoginProviders(deps.db);
  const before = current[id];
  const next: StoredProvider = { ...before };
  if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.client_id !== undefined) next.client_id = patch.client_id;
  if (patch.client_secret !== undefined) {
    next.secret_enc = patch.client_secret ? deps.secrets.seal(patch.client_secret) : null;
    next.secret_hint = patch.client_secret ? keyHint(patch.client_secret) : null;
  }
  if (patch.tenant_id !== undefined && id === 'microsoft') next.tenant_id = patch.tenant_id;
  // New credentials: the previous test said nothing about them.
  if (patch.client_id !== undefined || patch.client_secret !== undefined || patch.tenant_id !== undefined)
    next.last_test = null;
  await store(deps.db, owner.id, { ...current, [id]: next });
  // What changed, never the secret (CLAUDE.md 10).
  deps.logger.info({ owner: owner.id, provider: id, fields: Object.keys(patch) }, 'login provider updated');
  return listLoginProviders(deps);
};

const TOKEN_ENDPOINT = {
  google: () => 'https://oauth2.googleapis.com/token',
  microsoft: (tenant: string) => `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
} as const;

/**
 * "Test connection": exchanges a made-up authorization code. The provider checks the client first, so
 * `invalid_client` (or Entra's AADSTS7000215 / 700016 / 7000222: wrong or expired secret, unknown app) means the
 * credentials are wrong, while `invalid_grant` means they were accepted and only the code was refused — the most a
 * server can learn without a person signing in.
 */
export const classifyTokenAnswer = (status: number, body: Record<string, unknown>): string | null => {
  const error = typeof body.error === 'string' ? body.error : null;
  const description = typeof body.error_description === 'string' ? body.error_description : '';
  if (status >= 200 && status < 300) return null;
  if (/AADSTS(7000215|7000222)/.test(description)) return 'invalid_secret';
  if (/AADSTS(700016|90002|50194)/.test(description)) return 'unknown_client';
  if (error === 'invalid_client' || error === 'unauthorized_client') return 'invalid_client';
  if (error === 'invalid_grant' || error === 'invalid_request') return null;
  return error ?? `http_${status}`;
};

/** POST /platform/login-providers/{provider}/test — the result is kept and shown next to the provider. */
export const testLoginProvider = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'secrets' | 'logger'>,
  owner: SessionUser,
  id: LoginProvider,
) => {
  const stored = await loadLoginProviders(deps.db);
  const web = (await publicAddress(deps)).web;
  const p = resolveProviders(stored, deps.env, web, deps.secrets.open).find((x) => x.id === id)!;
  // Tested even when switched off (the owner checks before turning it on); missing credentials = nothing to test.
  const credentials =
    p.credentials ??
    (() => {
      const s = stored[id];
      if (s.client_id && s.secret_enc) {
        try {
          return { clientId: s.client_id, clientSecret: deps.secrets.open(s.secret_enc) };
        } catch {
          return null;
        }
      }
      return envCredentials(deps.env, id);
    })();
  let error: string | null;
  if (!credentials) error = 'missing_credentials';
  else {
    try {
      const res = await fetch(id === 'google' ? TOKEN_ENDPOINT.google() : TOKEN_ENDPOINT.microsoft(p.tenantId), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: 'bines-connection-test',
          redirect_uri: p.redirectURI,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      error = classifyTokenAnswer(res.status, body);
    } catch {
      error = 'unreachable';
    }
  }
  const last_test = { ok: !error, at: new Date().toISOString(), error };
  const fresh = await loadLoginProviders(deps.db);
  await store(deps.db, owner.id, { ...fresh, [id]: { ...fresh[id], last_test } });
  deps.logger.info({ owner: owner.id, provider: id, ok: !error, error }, 'login provider tested');
  return { ...(await listLoginProviders(deps)), result: last_test };
};

/**
 * Keeps Better Auth's provider list (its context's `socialProviders`, read by /sign-in/social and /callback/:id)
 * in step with the console. Runs before every auth request; rebuilds only when the saved row (cached 30 s, dropped
 * on save in this process) or the public address changed — other server instances follow within the cache time.
 */
export const socialProviderSync = (deps: { db: Db; env: Env }) => {
  let applied: { stored: Stored; web: string } | null = null;
  return async (target: unknown[]) => {
    const stored = await loadLoginProviders(deps.db);
    const web = (await publicAddress(deps)).web;
    if (applied && applied.stored === stored && applied.web === web) return;
    const next = buildSocialProviders(resolveProviders(stored, deps.env, web));
    // In place: every request's context is a shallow copy sharing this one array.
    target.splice(0, target.length, ...next);
    applied = { stored, web };
  };
};
