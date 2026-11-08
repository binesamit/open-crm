// SPDX-License-Identifier: AGPL-3.0-only
import {
  type ExtensionManifest,
  extensionManifestSchema,
  frameOriginsOf,
  isExtensionToken,
  isPlainOrigin,
} from '@bines/shared';
import { createMiddleware } from 'hono/factory';
import type { Db } from '../../db/client';
import type { Env } from '../../env';
import type { AppEnv } from '../../types';
import { allEnabledManifests, enabledInstallationsBySlug, listKills } from './extensions.repo';
import { publicAddress } from '../platform/public-address';

/**
 * Where extension iframes come from (D27 ת2, layers 1 and 3 of the sandbox — MARKETPLACE §4.2):
 * - the SPA page's CSP `frame-src` lists the frame origins of the extensions enabled in **that page's account**
 *   (`/a/<slug>/…`) — not a fixed list, and never another account's;
 * - CORS lets those origins call the REST API **with an extension token only** — never with the session cookie.
 * Both are read from the database at most every 30 s per process and dropped at once after a change here.
 */
const TTL_MS = 30_000;

const originsOf = (rows: { manifest: unknown; key: string }[], killed: Set<string>) => {
  const out = new Set<string>();
  for (const r of rows) {
    if (killed.has(r.key)) continue;
    const m = extensionManifestSchema.safeParse(r.manifest);
    // EXT-RT2: only plain origins ever reach a CSP header or the CORS list (no wildcard, no smuggled directive).
    if (m.success) for (const o of frameOriginsOf(m.data as ExtensionManifest)) if (isPlainOrigin(o)) out.add(o);
  }
  return out;
};

let all: { at: number; origins: Set<string> } | null = null;
const bySlug = new Map<string, { at: number; origins: string[] }>();

/** Drops the cached origins (an install / disable / kill in this process applies on the next request). */
export const forgetExtensionOrigins = () => {
  all = null;
  bySlug.clear();
};

const killedSet = async (db: Db) => new Set((await listKills(db)).map((k) => k.key));

/** Frame origins of every enabled, not-killed installation (the CORS allowlist). */
export const extensionOrigins = async (db: Db, now = Date.now()): Promise<Set<string>> => {
  if (all && now - all.at < TTL_MS) return all.origins;
  try {
    const origins = originsOf(await allEnabledManifests(db), await killedSet(db));
    all = { at: now, origins };
    return origins;
  } catch {
    return all?.origins ?? new Set();
  }
};

/** Frame origins for one account's pages (CSP frame-src). */
export const accountFrameOrigins = async (db: Db, slug: string, now = Date.now()): Promise<string[]> => {
  const hit = bySlug.get(slug);
  if (hit && now - hit.at < TTL_MS) return hit.origins;
  try {
    const origins = [...originsOf(await enabledInstallationsBySlug(db, slug), await killedSet(db))].sort();
    if (bySlug.size > 5000) bySlug.clear();
    bySlug.set(slug, { at: now, origins });
    return origins;
  } catch {
    return hit?.origins ?? [];
  }
};

/** `/a/<slug>/…` → the slug (the SPA's account pages); anything else → null. */
export const slugOfPath = (path: string): string | null =>
  /^\/a\/([a-z0-9][a-z0-9-]{0,62})(\/|$)/.exec(path)?.[1] ?? null;

/** The CSP hook for `security-headers.ts`: the frame origins of the page's account. */
export const pageFrameOrigins = (db: Db) => async (path: string) => {
  const slug = slugOfPath(path);
  return slug ? accountFrameOrigins(db, slug) : [];
};

const ALLOW_HEADERS = 'authorization, content-type, x-account-id, idempotency-key, x-request-id';
const EXPOSE_HEADERS =
  'RateLimit-Limit, RateLimit-Remaining, RateLimit-Reset, RateLimit-Policy, Retry-After, X-Request-Id';

/**
 * CORS for extension origins, before the app's own CORS (which allows only WEB_ORIGIN, with credentials):
 * preflight from an enabled extension origin → allowed without credentials; an actual request from one must carry
 * an extension token (the session cookie is never honoured from an extension's origin).
 */
export const extensionCors = (deps: { db: Db; env: Pick<Env, 'WEB_ORIGIN'> }) => {
  return createMiddleware<AppEnv>(async (c, next) => {
    const origin = c.req.header('origin');
    if (!origin || !c.req.path.startsWith('/api/v1/')) return next();
    // The platform's own addresses (the public address, WEB_ORIGIN, previous ones — M11) use the app's CORS.
    if ((await publicAddress(deps)).accepted.includes(origin)) return next();
    if (!(await extensionOrigins(deps.db)).has(origin)) return next();
    const cors = {
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Expose-Headers': EXPOSE_HEADERS,
    };
    if (c.req.method === 'OPTIONS')
      return c.body(null, 204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
        'Access-Control-Allow-Headers': ALLOW_HEADERS,
        'Access-Control-Max-Age': '600',
      });
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1];
    if (!bearer || !isExtensionToken(bearer))
      return c.json(
        {
          error: {
            code: 'unauthenticated',
            message: 'An extension calls the API with its extension token only',
            request_id: c.get('requestId') ?? 'unknown',
          },
        },
        401,
        cors,
      );
    await next();
    for (const [k, v] of Object.entries(cors)) c.res.headers.set(k, v);
    c.res.headers.delete('Access-Control-Allow-Credentials');
  });
};
