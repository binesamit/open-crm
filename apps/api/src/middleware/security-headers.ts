// SPDX-License-Identifier: AGPL-3.0-only
import { createMiddleware } from 'hono/factory';
import type { Env } from '../env';
import type { AppEnv } from '../types';
import { configuredMapOrigins } from '../modules/geo/geo.csp';
import { EXT_DOCS_BASE, EXT_DOCS_CSP, GUIDE_DOCS_BASE } from '../modules/apidocs/extension-docs.csp';
import { INTERNAL_DOCS_PATH } from '../modules/apidocs/internal-docs-path';
import { LOCAL_FILES_PATH } from '../lib/disk-storage';

/**
 * Response security headers (security review S-05): every response gets nosniff, a strict referrer policy,
 * no framing and (in production) HSTS. The SPA page gets a Content-Security-Policy that allows only our own
 * scripts, Google Fonts, and the file storage origin (presigned uploads, previews, avatars); API answers get
 * `default-src 'none'`. The API reference (/api/docs) serves its renderer from this origin: own scripts only, no
 * inline script, no CDN (`docsCsp`).
 * Error monitoring (GlitchTip): the SPA reports to the origin of its DSN, so that origin joins connect-src.
 * Maps (M8 ד10): the tile / style origins — the deployment's (`MAP_STYLE_URL`, `MAP_ORIGINS`) and the ones accounts
 * chose in their settings (`mapOrigins`) — join connect-src (MapLibre fetches style, tiles, glyphs and sprites).
 */
const storageOrigins = (env: Pick<Env, 'S3_ENDPOINT'> & Partial<Pick<Env, 'S3_PUBLIC_ENDPOINT'>>): string[] => {
  // The browser talks to the public address when one is set (self-hosted storage behind its own domain).
  const endpoint = env.S3_PUBLIC_ENDPOINT ?? env.S3_ENDPOINT;
  if (!endpoint) return [];
  try {
    const u = new URL(endpoint);
    // Virtual-hosted buckets live on a sub-domain of the endpoint.
    return [u.origin, `${u.protocol}//*.${u.host}`];
  } catch {
    return [];
  }
};

/** The monitoring server's origin, from the web DSN (else the api DSN: same server). Not hard-coded. */
export const monitoringOrigin = (env: Partial<Pick<Env, 'VITE_SENTRY_DSN' | 'SENTRY_DSN'>>): string | undefined => {
  const dsn = env.VITE_SENTRY_DSN ?? env.SENTRY_DSN;
  if (!dsn) return undefined;
  try {
    return new URL(dsn).origin;
  } catch {
    return undefined;
  }
};

type CspEnv = Pick<Env, 'S3_ENDPOINT' | 'NODE_ENV'> &
  Partial<
    Pick<Env, 'S3_PUBLIC_ENDPOINT' | 'VITE_SENTRY_DSN' | 'SENTRY_DSN' | 'MAP_STYLE_URL' | 'MAP_ORIGINS' | 'WEB_ORIGIN'>
  >;

/**
 * The public form page (`/f/<token>`, M11): Cloudflare Turnstile's script and challenge frame load there (only
 * there), and a form whose owner allowed embedding may be framed by other sites (frame-ancestors for /f/* only).
 */
export const TURNSTILE_CSP_ORIGIN = 'https://challenges.cloudflare.com';
export type PublicFormPage = { embed: boolean };

/** `extensionOrigins`: the frame origins of the extensions enabled in the page's account (D27 ת2). */
export const spaCsp = (
  env: CspEnv,
  accountMapOrigins: string[] = [],
  extensionOrigins: string[] = [],
  publicForm: PublicFormPage | null = null,
  /** The owner turned Turnstile on for a sign-in screen: the SPA may load it. */
  authTurnstile = false,
  /** An extension's panel page: the origins the owner allowed to frame it. */
  embeddedBy: string[] = [],
) => {
  const storage = storageOrigins(env).join(' ');
  const turnstile = publicForm || authTurnstile ? ` ${TURNSTILE_CSP_ORIGIN}` : '';
  const monitoring = monitoringOrigin(env) ?? '';
  const maps = [...new Set([...configuredMapOrigins(env), ...accountMapOrigins])].join(' ');
  // Dev: MinIO / Vite on localhost.
  const local = env.NODE_ENV === 'production' ? '' : ' http://localhost:* ws://localhost:*';
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' (round 11) lets the page compile WebAssembly — only that, never JS eval (no 'unsafe-eval').
    // The map's RTL text plugin (@mapbox/mapbox-gl-rtl-text, served from our origin) is WebAssembly; blocked, MapLibre
    // drops every Hebrew label and the map shows no place / street names. Only staging / production send this CSP.
    `script-src 'self' 'wasm-unsafe-eval'${turnstile}`,
    // React style={…} props and Google Fonts' stylesheet.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    // Avatars from Google sign-in and presigned file links (storage origin) are images.
    `img-src 'self' data: blob: https:${local}`,
    `media-src 'self' blob: ${storage}${local}`.trim(),
    `connect-src 'self' ${storage} ${monitoring} ${maps}${turnstile}${local}`.replace(/\s+/g, ' ').trim(),
    // The file viewer frames PDFs from storage and (on request) Microsoft's Office viewer; a practical guide (prod
    //) may play its video from YouTube (the no-cookie player) or Vimeo.
    `frame-src 'self' ${storage} https://view.officeapps.live.com ${GUIDE_VIDEO_ORIGINS} ${extensionOrigins.join(' ')}${turnstile}${local}`
      .replace(/\s+/g, ' ')
      .trim(),
    "worker-src 'self' blob:",
    // The phone app's manifest (PWA): served by the API on this origin.
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    publicForm?.embed
      ? 'frame-ancestors *'
      : embeddedBy.length
        ? `frame-ancestors ${embeddedBy.join(' ')}`
        : "frame-ancestors 'none'",
  ].join('; ');
};

/** The video players a practical guide may embed. */
const GUIDE_VIDEO_ORIGINS = 'https://www.youtube-nocookie.com https://player.vimeo.com';

const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/**
 * An extension's panel page — the only page of the app another site may frame, and only the sites
 * the owner listed ("allowed embedding origins").
 */
export const isPanelPath = (path: string) => /^\/a\/[^/]+\/x\/[^/]+\/panel\/?$/.test(path);
/** A file served from this origin: shown, never run (no script, no plugin but the browser's own viewers). */
const FILE_CSP =
  "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'self'";
/**
 * The API reference page: its renderer and start-up script are files of this origin (no inline script, no eval).
 * The renderer injects its styles at runtime (style-src 'unsafe-inline'); a logo may live anywhere (img-src https:);
 * "Test request" calls the API on the public origin (connect-src).
 */
export const docsCsp = (env: Partial<Pick<Env, 'WEB_ORIGIN' | 'NODE_ENV'>>) => {
  const local = env.NODE_ENV === 'production' ? '' : ' http://localhost:*';
  let web = '';
  try {
    web = env.WEB_ORIGIN ? ` ${new URL(env.WEB_ORIGIN).origin}` : '';
  } catch {
    web = '';
  }
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src 'self' data: blob: https:${local}`,
    `connect-src 'self'${web}${local}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
};

/**
 * `mapOrigins`: the accounts' map origins (cached, `geo.csp.ts`); without it only the deployment's apply.
 * `frameOrigins`: an account page's extension frame origins (cached, `extensions/ext-origins.ts`).
 * `formPage`: for `/f/<token>`, whether that form allows embedding (cached, `forms/forms.csp.ts`).
 */
export const securityHeaders = (
  env: CspEnv,
  mapOrigins?: () => Promise<string[]>,
  frameOrigins?: (path: string) => Promise<string[]>,
  formPage?: (path: string) => Promise<PublicFormPage>,
  /** Whether a sign-in screen asks for Turnstile (cached; the sign-in route is client-side, so every SPA page). */
  authTurnstile?: () => Promise<boolean>,
  /** The owner's allowed embedding origins (cached) — they may frame an extension's panel page only. */
  embedOrigins?: () => Promise<string[]>,
) => {
  const fixedSpa = spaCsp(env);
  const docs = docsCsp(env);
  return createMiddleware<AppEnv>(async (c, next) => {
    await next();
    let h = c.res.headers;
    try {
      h.set('X-Content-Type-Options', 'nosniff');
    } catch {
      // A response with immutable headers (e.g. passed through from fetch): copy it.
      c.res = new Response(c.res.body, c.res);
      h = c.res.headers;
    }
    h.set('X-Content-Type-Options', 'nosniff');
    h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    h.set('X-Frame-Options', 'DENY');
    h.set('Cross-Origin-Opener-Policy', 'same-origin');
    // The microphone for our own pages only (voice messages in updates); never for a framed page.
    h.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=(), payment=(), usb=()');
    if (env.NODE_ENV === 'production') h.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const path = c.req.path;
    const publicForm = path.startsWith('/f/') ? ((await formPage?.(path)) ?? { embed: false }) : null;
    // An embeddable form is framed by other sites: X-Frame-Options would block it (CSP frame-ancestors decides).
    if (publicForm?.embed) h.delete('X-Frame-Options');
    const embeddedBy = isPanelPath(path) && embedOrigins ? await embedOrigins().catch(() => []) : [];
    if (embeddedBy.length) h.delete('X-Frame-Options');
    // The internal reference (owner only) runs the same renderer as the public one.
    if (path === '/api/docs' || path === INTERNAL_DOCS_PATH) h.set('Content-Security-Policy', docs);
    else if (
      path === EXT_DOCS_BASE ||
      path.startsWith(`${EXT_DOCS_BASE}/`) ||
      path === GUIDE_DOCS_BASE ||
      path.startsWith(`${GUIDE_DOCS_BASE}/`)
    )
      h.set('Content-Security-Policy', EXT_DOCS_CSP);
    else if (path.startsWith(`${LOCAL_FILES_PATH}/`)) {
      // A stored file (standalone mode's local disk): previews (PDF, images) are framed by the app itself.
      h.set('Content-Security-Policy', FILE_CSP);
      h.set('X-Frame-Options', 'SAMEORIGIN');
    } else if (path.startsWith('/api/')) h.set('Content-Security-Policy', API_CSP);
    else if (publicForm)
      h.set('Content-Security-Policy', spaCsp(env, mapOrigins ? await mapOrigins() : [], [], publicForm));
    else {
      const captcha = authTurnstile ? await authTurnstile().catch(() => false) : false;
      if (!mapOrigins && !frameOrigins && !captcha && !embeddedBy.length) h.set('Content-Security-Policy', fixedSpa);
      else
        h.set(
          'Content-Security-Policy',
          spaCsp(
            env,
            mapOrigins ? await mapOrigins() : [],
            frameOrigins ? await frameOrigins(path) : [],
            null,
            captcha,
            embeddedBy,
          ),
        );
    }
  });
};
