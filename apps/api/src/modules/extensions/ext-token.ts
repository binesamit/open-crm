// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import {
  ACCOUNT_HEADER,
  AppError,
  EXT_BOARD_PATCH_DENIED,
  EXT_TOKEN_PREFIX,
  EXT_TOKEN_TTL_MINUTES,
  type ExtensionManifest,
  extensionManifestSchema,
  extensionPathAllowed,
  featureOrigin,
  newId,
  scopeAllows,
} from '@bines/shared';
import type { Context } from 'hono';
import type { Env } from '../../env';
import type { Db } from '../../db/client';
import { RateLimiter } from '../../lib/rate-limit';
import { requiredScope } from '../../lib/scopes';
import type { ActivityScope } from '../../lib/activity-scope';
import type { AppEnv } from '../../types';
import { findInstallationById, findKill, type InstallationRow, userBasics } from './extensions.repo';
import { boardsInScope } from './scope';

/**
 * Extension tokens (D27 ת2, MARKETPLACE §4.3): `bos_ext_<claims>.<HMAC-SHA256>` — stateless, signed with a key
 * derived from the server secret, minutes long. What a request with one may do is the intersection of
 *   the user's own rights (the request runs as the user — every service checks `can`) ×
 *   the scopes the admin granted the installation (and the token's own, never more) ×
 *   the one board the token was minted for (the API-token board limit, `withinLimit`) ×
 *   the extension path allowlist (board content only).
 * Everything is checked against the installation **as it is now** on every request: disabling, uninstalling, a
 * narrower grant or the platform kill switch stop the token at once.
 */
export type ExtClaims = {
  v: 1;
  /** installation */ i: string;
  /** account */ a: string;
  /** user */ u: string;
  /** board ('' for a widget / the settings page) */ b: string;
  /** every board it may read when not just `b` (ת5 widget: the dashboard's boards the viewer sees; [] = none) */
  bs?: string[];
  /** feature */ f: string;
  /** scopes at mint time */ s: string[];
  /** the iframe origin the token belongs to */ o: string;
  /** expiry, epoch seconds */ e: number;
  /** token id */ j: string;
  /**
   * ת4: minted for an automation run's call to the extension's server — what it writes back belongs to the run's
   * chain (automation id, run id, depth, chain): the same automation never re-fires on it, depth stays bounded.
   */
  r?: { a: string; r: string; d: number; c: string[] };
};

const DEV_FALLBACK = 'bines-dev-only-secret-not-for-production';
const keyCache = new WeakMap<object, Buffer>();
const keyOf = (env: Pick<Env, 'BETTER_AUTH_SECRET'>) => {
  let k = keyCache.get(env);
  if (!k) {
    k = Buffer.from(hkdfSync('sha256', env.BETTER_AUTH_SECRET ?? DEV_FALLBACK, 'bines-os', 'ext-token-v1', 32));
    keyCache.set(env, k);
  }
  return k;
};

const sign = (env: Pick<Env, 'BETTER_AUTH_SECRET'>, body: string) =>
  createHmac('sha256', keyOf(env)).update(body).digest('base64url');

export const signExtToken = (env: Pick<Env, 'BETTER_AUTH_SECRET'>, claims: ExtClaims) => {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${EXT_TOKEN_PREFIX}${body}.${sign(env, body)}`;
};

/** The claims of a well-signed, unexpired token — else null. */
export const verifyExtToken = (
  env: Pick<Env, 'BETTER_AUTH_SECRET'>,
  raw: string,
  nowMs = Date.now(),
): ExtClaims | null => {
  if (!raw.startsWith(EXT_TOKEN_PREFIX) || raw.length > 4096) return null;
  const [body, sig] = raw.slice(EXT_TOKEN_PREFIX.length).split('.');
  if (!body || !sig) return null;
  const want = Buffer.from(sign(env, body));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ExtClaims;
    if (c.v !== 1 || typeof c.e !== 'number' || c.e * 1000 <= nowMs) return null;
    return c;
  } catch {
    return null;
  }
};

export const EXT_TOKEN_TTL_MS = EXT_TOKEN_TTL_MINUTES * 60_000;

/** Requests per installation per minute (all its users together), and per user of an installation. */
export const EXT_RATE_PER_INSTALL = 600;
export const EXT_RATE_PER_USER = 240;
const perInstall = new RateLimiter(EXT_RATE_PER_INSTALL, 60_000);
const perUser = new RateLimiter(EXT_RATE_PER_USER, 60_000);

export type LiveInstallation = { row: InstallationRow; manifest: ExtensionManifest };

/** The installation if it may run now: installed, enabled, its key not killed by the platform owner. */
export const liveInstallation = async (db: Db, id: string, accountId: string): Promise<LiveInstallation | null> => {
  const row = await findInstallationById(db, id);
  if (!row || row.accountId !== accountId || row.uninstalledAt || row.status !== 'enabled') return null;
  if (await findKill(db, row.key)) return null;
  const parsed = extensionManifestSchema.safeParse(row.manifest);
  return parsed.success ? { row, manifest: parsed.data } : null;
};

/** The boards a token may read: its list (a widget's, possibly none), else its one board (none when ''). */
export const tokenBoards = (claims: Pick<ExtClaims, 'b' | 'bs'>): string[] =>
  claims.bs ? [...claims.bs] : claims.b ? [claims.b] : [];

/** The granted scopes ∩ the token's (a narrower grant after minting applies at once). */
const effectiveScopes = (claims: ExtClaims, row: InstallationRow) =>
  claims.s.filter((s) => row.grantedScopes.includes(s));

const rate = (c: Context<AppEnv>, key: string, limiter: RateLimiter, limit: number) => {
  const r = limiter.take(key, limit);
  if (r.waitMs > 0) {
    c.header('Retry-After', String(Math.ceil(r.waitMs / 1000)));
    throw new AppError('rate_limited', 'Too many requests from this extension', { retry_after_ms: r.waitMs });
  }
};

/**
 * What every extension request (a frame's token or its server's) must pass before scopes are looked at
 * (docs/EXTENSIONS-SECURITY-REVIEW.md):
 * - EXT-RT1: the path × method allowlist (board content only), and `PATCH /boards/:id` never changes who sees the
 *   board (type, permission set, workspace);
 * - EXT-RT7: `X-Account-Id` may repeat the installation's account, never name another one (`/auth/me` reads it
 *   without `requireAccount`).
 * Returns the API path (without `/api/v1`).
 */
export const assertExtensionRequest = async (
  c: Context<AppEnv>,
  accountId: string,
  opts: { server?: boolean } = {},
): Promise<string> => {
  const path = c.req.path.replace(/^\/api\/v1/, '');
  const method = c.req.method.toUpperCase();
  if (!extensionPathAllowed(path, method, opts)) throw new AppError('forbidden', 'not_for_extensions');
  const asked = c.req.header(ACCOUNT_HEADER);
  if (asked && asked !== accountId) throw new AppError('not_found', 'Account not found');
  if (method === 'PATCH' && /^\/boards\/[^/]+\/?$/.test(path)) {
    let input: unknown = null;
    try {
      input = await c.req.json();
    } catch {
      // not JSON: the route's own validation answers
    }
    if (input && typeof input === 'object' && EXT_BOARD_PATCH_DENIED.some((k) => k in input))
      throw new AppError('forbidden', 'not_for_extensions', { fields: [...EXT_BOARD_PATCH_DENIED] });
  }
  return path;
};

/**
 * `Authorization: Bearer bos_ext_…` (loadSession): checks everything above and returns what the request runs as,
 * plus the activity scope ("via app X", one batch per request).
 */
export const extensionTokenAuth = async (
  c: Context<AppEnv>,
  deps: { db: Db; env: Pick<Env, 'BETTER_AUTH_SECRET'> },
  raw: string,
): Promise<ActivityScope> => {
  const claims = verifyExtToken(deps.env, raw);
  if (!claims) throw new AppError('unauthenticated', 'Invalid or expired extension token');
  // Bound to the iframe origin it was minted for: a browser always names the calling origin, so a frame token
  // without one is not the frame (audit 2026-10-10 security #18 — a stolen token worked from any server). The
  // automation-callback variant (`r`) is used by the extension's server, which sends no Origin.
  const origin = c.req.header('origin');
  if (!origin && !claims.r) throw new AppError('unauthenticated', 'Token used from another origin');
  if (origin && origin !== claims.o) throw new AppError('unauthenticated', 'Token used from another origin');
  const live = await liveInstallation(deps.db, claims.i, claims.a);
  if (!live) throw new AppError('unauthenticated', 'This extension is not active');
  const { row, manifest } = live;
  // The feature it was minted for still exists, served from (or calling from) the same origin.
  const feature = manifest.features.find((f) => f.key === claims.f);
  if (!feature || featureOrigin(feature) !== claims.o)
    throw new AppError('unauthenticated', 'This extension is not active');
  const boards = tokenBoards(claims);
  if ((await boardsInScope(deps.db, row, boards)).length !== boards.length)
    throw new AppError('not_found', 'Board not found');

  const path = await assertExtensionRequest(c, row.accountId);
  const scopes = effectiveScopes(claims, row);
  const need = requiredScope(c.req.method, path);
  if ('forbidden' in need) throw new AppError('forbidden', 'not_for_extensions');
  if (need.scope !== 'any' && !scopeAllows(scopes, need.scope))
    throw new AppError('insufficient_scope', `This extension lacks the "${need.scope}" scope`, {
      required: need.scope,
    });
  rate(c, `i:${row.id}`, perInstall, EXT_RATE_PER_INSTALL);
  rate(c, `u:${row.id}:${claims.u}`, perUser, EXT_RATE_PER_USER);

  const user = await userBasics(deps.db, claims.u);
  if (!user || user.isService) throw new AppError('unauthenticated', 'Invalid or expired extension token');
  c.set('token', {
    id: `ext:${row.id}`,
    accountId: row.accountId,
    scopes,
    ratePerMinute: EXT_RATE_PER_USER,
    boardIds: boards,
    ext: { installationId: row.id, key: row.key, allowGuests: row.allowGuests, feature: claims.f },
  });
  c.set('user', {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: !!user.emailVerified,
    isPlatformOwner: false,
    locale: user.locale,
    timezone: user.timezone,
  });
  return {
    batchId: newId(),
    meta: {
      via: 'app',
      app: { key: row.key, name: manifest.name, installation_id: row.id },
      ...(claims.r
        ? { automation: { automation_id: claims.r.a, run_id: claims.r.r, depth: claims.r.d, chain: claims.r.c } }
        : {}),
    },
  };
};

export const newClaims = (p: Omit<ExtClaims, 'v' | 'e' | 'j'>, nowMs = Date.now()): ExtClaims => ({
  v: 1,
  ...p,
  e: Math.floor((nowMs + EXT_TOKEN_TTL_MS) / 1000),
  j: newId(),
});
