// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';

/**
 * The platform's public address (prod fix M11, "דומיין קבוע למערכת"): the one origin every absolute link is built
 * on — emails (invitations, password reset, notifications, digests, tickets), push, SMS, the MCP / OAuth issuer, the
 * API reference, help-center links, extension API bases. Platform owner console → Platform settings; empty = the
 * environment (`WEB_ORIGIN`). Never a literal domain in code.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `https://host[:port]` only (http for localhost) — no path, query, fragment or credentials. Null = not one. */
export const normalizeOrigin = (raw: string): string | null => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
};

/** An origin a person types: trimmed, validated, stored normalised (`https://os.example.com`). */
export const publicOriginSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => normalizeOrigin(v) !== null, 'public_origin_invalid')
  .transform((v) => normalizeOrigin(v)!);

/** Old addresses still accepted (sign-in, CORS) while people move to the new one — up to 10. */
export const MAX_PREVIOUS_ORIGINS = 10;

/** `platform_settings.settings.public_address`. */
export const platformPublicAddressSchema = z.object({
  /** Where people open the app — every link in an email / push / SMS (empty = WEB_ORIGIN). */
  web_origin: publicOriginSchema.optional(),
  /** Where the API answers, when not on the app's address (API reference, MCP, OAuth issuer; empty = web_origin). */
  api_origin: publicOriginSchema.optional(),
  /** Earlier addresses still accepted for sign-in / CORS during a move (never used to build links). */
  previous_origins: z.array(publicOriginSchema).max(MAX_PREVIOUS_ORIGINS).default([]),
});
export type PlatformPublicAddress = z.infer<typeof platformPublicAddressSchema>;

export const updatePlatformPublicAddressSchema = z.object({
  web_origin: publicOriginSchema.nullable().optional(),
  api_origin: publicOriginSchema.nullable().optional(),
  previous_origins: z.array(publicOriginSchema).max(MAX_PREVIOUS_ORIGINS).optional(),
});

/** Where an effective value came from: the owner's setting, the environment, or (API) the app's address. */
export type PublicAddressSource = 'setting' | 'env' | 'web';

export type ResolvedPublicAddress = {
  /** The app's origin every link is built on (no trailing slash). */
  web: string;
  web_source: Exclude<PublicAddressSource, 'web'>;
  /** The API's origin (= web unless set). */
  api: string;
  api_source: PublicAddressSource;
  /** Every origin accepted for sign-in / CORS: web, api, the environment's and the previous ones (deduplicated). */
  accepted: string[];
};

/** The environment part the resolver reads (both services have it). */
export type PublicAddressEnv = { WEB_ORIGIN?: string | undefined; BETTER_AUTH_URL?: string | undefined };

const DEV_ORIGIN = 'http://localhost:5173';

/**
 * The one resolver: the owner's setting wins, else the environment. Pure — the API and the worker each load the
 * settings row and call it, so a change in the owner console reaches both without a redeploy.
 */
export const resolvePublicAddress = (
  saved: Partial<PlatformPublicAddress> | undefined,
  env: PublicAddressEnv,
): ResolvedPublicAddress => {
  const envWeb = (env.WEB_ORIGIN && normalizeOrigin(env.WEB_ORIGIN)) || DEV_ORIGIN;
  const settingWeb = saved?.web_origin ? normalizeOrigin(saved.web_origin) : null;
  const web = settingWeb ?? envWeb;
  const settingApi = saved?.api_origin ? normalizeOrigin(saved.api_origin) : null;
  const api = settingApi ?? web;
  const envAuth = env.BETTER_AUTH_URL ? normalizeOrigin(env.BETTER_AUTH_URL) : null;
  const previous = (saved?.previous_origins ?? []).map((o) => normalizeOrigin(o)).filter((o): o is string => !!o);
  const accepted = [...new Set([web, api, envWeb, ...(envAuth ? [envAuth] : []), ...previous])];
  return {
    web,
    web_source: settingWeb ? 'setting' : 'env',
    api,
    api_source: settingApi ? 'setting' : 'web',
    accepted,
  };
};

/** GET /public/address: what the web app builds copyable links on (public — a domain is no secret). */
export const publicAddressInfoSchema = z.object({ web: z.string(), api: z.string() }).meta({ id: 'PublicAddress' });
export type PublicAddressInfo = z.infer<typeof publicAddressInfoSchema>;

/** Joins an origin and a path (`/a/x`) without a double slash. */
export const absoluteUrl = (origin: string, path: string) =>
  `${origin.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
