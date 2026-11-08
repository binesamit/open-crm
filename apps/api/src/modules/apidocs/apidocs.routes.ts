// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Context, Hono } from 'hono';
import {
  AppError,
  defaultPlatformSettings,
  resolveIntegrations,
  resolvePublicAddress,
  t,
  type PlatformSettings,
} from '@bines/shared';
import type { AppDeps, AppEnv } from '../../types';
import { loadPlatformSettings } from '../platform/platform-settings';
import { IDEMPOTENCY_TTL_MS } from '../../middleware/idempotency';
import { buildPublicSpec, type OpenApiDoc } from './spec';
import { themeCss } from './theme';
import type { GuideContext } from './guide';
import { mountExtensionDocs } from './extension-docs';
import { mountInstallGuide } from './install-guide';
import { buildInternalSpec, INTERNAL_DOCS_PATH, INTERNAL_SPEC_PATH } from './internal-spec';

/**
 * The public API reference at `/api/docs` (06 §1.1): Scalar API Reference (MIT, maintained, OpenAPI 3.1 native —
 * navigation by resource, code samples in curl / JavaScript / Python and more, "Test request" against this server)
 * rendering the document the routes generate, narrowed and enriched by `spec.ts`. Everything is served from this
 * origin — the renderer's bundle comes from node_modules, not a CDN — so the page works offline and under a strict
 * CSP (`script-src 'self'`, see middleware/security-headers.ts). Product name, logo, colour and the API budgets
 * come from the owner console's Platform settings (ANSWERS 6א.3/9); the env (PRODUCT_NAME, API_DOCS_LOGO_URL,
 * API_DOCS_BRAND_COLOR) is only the fallback of an empty field.
 */
export const DOCS_BASE = '/api/docs';
/** `GET /api/v1/openapi.json`: the public document too (S-47). */
export const PUBLIC_SPEC_PATH = '/api/v1/openapi.json';

/** The product's name in the reference: the owner's (Platform settings), else PRODUCT_NAME, else i18n `app.name`. */
export const productNameOf = (env: AppDeps['env'], settings?: PlatformSettings) =>
  settings?.product_name?.trim() || env.PRODUCT_NAME || t('app.name', undefined, 'en');

/** The reference's white-label: Platform settings first, the env as the fallback. */
export const docsBrandOf = (env: AppDeps['env'], settings?: PlatformSettings) => ({
  productName: productNameOf(env, settings),
  logoUrl: settings?.api_docs?.logo_url ?? env.API_DOCS_LOGO_URL,
  brandColor: settings?.api_docs?.brand_color ?? env.API_DOCS_BRAND_COLOR,
});

export const guideContext = (
  env: AppDeps['env'],
  maxRequestBytes: number,
  settings: PlatformSettings = defaultPlatformSettings(),
): GuideContext => {
  // The API's public address (owner console, M11; else WEB_ORIGIN) — the settings are the ones already loaded.
  const origin = resolvePublicAddress(settings.public_address, env).api;
  const brand = docsBrandOf(env, settings);
  // The platform's defaults (owner console); an account and a token may override them (06 §1.10).
  const defaults = settings.api_limits;
  return {
    productName: brand.productName,
    origin,
    apiBase: `${origin}/api/v1`,
    logoUrl: brand.logoUrl,
    specUrl: `${DOCS_BASE}/openapi.json`,
    limits: {
      tokenPerMinute: defaults.token_per_minute,
      servicePerMinute: defaults.service_token_per_minute,
      dayPersonal: defaults.personal_daily,
      dayService: defaults.service_daily,
      accountPerMinute: env.RATE_LIMIT_ACCOUNT_PER_MIN,
      ipPer10s: env.RATE_LIMIT_IP_PER_10S,
    },
    idempotencyHours: IDEMPOTENCY_TTL_MS / 3_600_000,
    maxRequestMb: maxRequestBytes / (1024 * 1024),
    // The n8n package and the Make app's invitation link (owner console).
    integrations: resolveIntegrations(settings.integrations),
  };
};

/** The renderer's self-contained browser bundle, read once (≈4 MB; ≈1 MB gzipped). */
const loadBundle = (() => {
  let cached: { raw: Buffer; gz: Buffer; etag: string } | null = null;
  return () => {
    if (cached) return cached;
    const require = createRequire(import.meta.url);
    const entry = require.resolve('@scalar/api-reference');
    const raw = readFileSync(join(dirname(entry), 'browser', 'standalone.js'));
    cached = { raw, gz: gzipSync(raw, { level: 9 }), etag: `"scalar-${raw.byteLength}"` };
    return cached;
  };
})();

/** `<` in inline JSON would let a value close the script element. */
const safeJson = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Reads the JSON config the page carries and starts the renderer — a file, so no inline script is needed. */
const INIT_JS = `(function () {
  var el = document.getElementById('docs-config');
  var config = JSON.parse(el.textContent);
  window.Scalar.createApiReference('#app', config);
})();
`;

export const mountApiDocs = (
  app: Hono<AppEnv>,
  deps: AppDeps,
  opts: { fullDoc: () => OpenApiDoc; maxRequestBytes: number },
) => {
  const { env } = deps;
  // Built once per change of the Platform settings it depends on (they are cached ~30 s in this process).
  let spec: { key: string; json: string } | null = null;
  let css: { key: string; text: string } | null = null;
  const settingsNow = () => loadPlatformSettings(deps.db);
  const specJson = (settings: PlatformSettings) => {
    const ctx = guideContext(env, opts.maxRequestBytes, settings);
    const key = JSON.stringify([ctx.productName, ctx.logoUrl, ctx.limits, ctx.origin, ctx.integrations]);
    if (spec?.key !== key) spec = { key, json: JSON.stringify(buildPublicSpec(opts.fullDoc(), ctx)) };
    return spec.json;
  };
  const cssOf = (settings: PlatformSettings) => {
    const key = docsBrandOf(env, settings).brandColor ?? '';
    if (css?.key !== key) css = { key, text: themeCss(key || undefined) };
    return css.text;
  };
  // Short: an owner's change in Platform settings shows within minutes.
  const cache = env.NODE_ENV === 'production' ? 'public, max-age=300' : 'no-cache';

  /**
   * The platform owner, by the session cookie only: a bearer token never counts — an API token cannot
   * open the owner console either. Anyone else gets the same 404 as an unknown route.
   */
  const isOwnerSession = async (c: Context<AppEnv>) => {
    if (c.req.header('authorization')) return false;
    if (!/(?:^|;\s*)(?:__Secure-)?bos\.session_token=/.test(c.req.header('cookie') ?? '')) return false;
    const session = await deps.auth.api.getSession({ headers: c.req.raw.headers }).catch(() => null);
    return !!(session?.user as { isPlatformOwner?: boolean } | undefined)?.isPlatformOwner;
  };
  const requireOwnerSession = async (c: Context<AppEnv>) => {
    if (!(await isOwnerSession(c))) throw new AppError('not_found', 'Route not found');
  };

  const page = (opts: { name: string; logoUrl?: string; internal: boolean; ownerLink: boolean }) => {
    const { name, internal } = opts;
    const title = internal ? `${name} internal API reference` : `${name} API reference`;
    const config = {
      url: internal ? INTERNAL_SPEC_PATH : `${DOCS_BASE}/openapi.json`,
      title: internal ? `${name} internal API` : `${name} API`,
      theme: 'none',
      layout: 'modern',
      withDefaultFonts: false,
      telemetry: false,
      showDeveloperTools: 'never',
      hideClientButton: true,
      mcp: { disabled: true },
      // The renderer's hosted AI chat would send the reference to a third party: off.
      agent: { disabled: true },
      persistAuth: false,
      documentDownloadType: 'json',
      defaultHttpClient: { targetKey: 'shell', clientKey: 'curl' },
      operationTitleSource: 'summary',
      orderRequiredPropertiesFirst: true,
      metaData: { title },
      ...(opts.logoUrl ? { favicon: opts.logoUrl } : {}),
    };
    const icon = opts.logoUrl ? `<link rel="icon" href="${escapeHtml(opts.logoUrl)}" />` : '';
    // The internal page says so on every screen; the public page links to it only for the owner.
    const bar = internal
      ? `<div class="docs-internal-bar" data-testid="internal-docs-banner">Internal — subject to change · visible to the platform owner only · <a href="${DOCS_BASE}">Public API reference</a></div>`
      : opts.ownerLink
        ? `<a class="docs-owner-link" href="${INTERNAL_DOCS_PATH}" data-testid="internal-docs-link">Internal API reference</a>`
        : '';
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    ${internal ? '<meta name="robots" content="noindex, nofollow" />' : `<meta name="description" content="${escapeHtml(`Reference and guides for the ${name} REST API.`)}" />`}
    ${icon}
    <link rel="stylesheet" href="${DOCS_BASE}/theme.css" />
  </head>
  <body${internal ? ' class="docs-internal"' : ''}>
    ${bar}
    <div id="app"></div>
    <script id="docs-config" type="application/json">${safeJson(config)}</script>
    <script src="${DOCS_BASE}/scalar.js"></script>
    <script src="${DOCS_BASE}/init.js"></script>
  </body>
</html>`;
  };

  app.get(DOCS_BASE, async (c) => {
    const brand = docsBrandOf(env, await settingsNow());
    // Only a request that carries a session cookie is looked up: the public page stays a static answer for everyone.
    const ownerLink = await isOwnerSession(c);
    c.header('Cache-Control', ownerLink ? 'private, no-cache' : 'no-cache');
    c.header('Vary', 'Cookie');
    return c.html(page({ name: brand.productName, logoUrl: brand.logoUrl, internal: false, ownerLink }));
  });

  // The internal reference: every route, platform owner only — 404 to anyone else, never cached.
  let internalSpec: { key: string; json: string } | null = null;
  const internalJson = (settings: PlatformSettings) => {
    const ctx = guideContext(env, opts.maxRequestBytes, settings);
    const key = JSON.stringify([ctx.productName, ctx.origin]);
    if (internalSpec?.key !== key) internalSpec = { key, json: JSON.stringify(buildInternalSpec(opts.fullDoc(), ctx)) };
    return internalSpec.json;
  };
  const noStore = (c: Context<AppEnv>) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Robots-Tag', 'noindex, nofollow');
  };
  app.get(INTERNAL_DOCS_PATH, async (c) => {
    await requireOwnerSession(c);
    const brand = docsBrandOf(env, await settingsNow());
    noStore(c);
    return c.html(page({ name: brand.productName, logoUrl: brand.logoUrl, internal: true, ownerLink: false }));
  });
  app.get(INTERNAL_SPEC_PATH, async (c) => {
    await requireOwnerSession(c);
    const json = internalJson(await settingsNow());
    noStore(c);
    c.header('Content-Type', 'application/json; charset=utf-8');
    return c.body(json);
  });

  const serveSpec = async (c: Context<AppEnv>) => {
    const json = specJson(await settingsNow());
    c.header('Cache-Control', cache);
    c.header('Content-Type', 'application/json; charset=utf-8');
    return c.body(json);
  };
  app.get(`${DOCS_BASE}/openapi.json`, serveSpec);
  // The API's own document address (S-47): the same public document — internal routes are not advertised. The
  // full one is `/api/v1/openapi.full.json`, for platform owners.
  app.get(PUBLIC_SPEC_PATH, serveSpec);

  app.get(`${DOCS_BASE}/theme.css`, async (c) => {
    const text = cssOf(await settingsNow());
    c.header('Cache-Control', cache);
    c.header('Content-Type', 'text/css; charset=utf-8');
    return c.body(text);
  });

  app.get(`${DOCS_BASE}/init.js`, (c) => {
    c.header('Cache-Control', cache);
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    return c.body(INIT_JS);
  });

  // The extension developer guide and quickstart (s37docs): /api/docs/extensions[/quickstart].
  mountExtensionDocs(app, deps, (s) => docsBrandOf(env, s));
  // The installation and licensing guide: /api/docs/guide (English) and /api/docs/guide/he.
  mountInstallGuide(app, deps, (s) => docsBrandOf(env, s));

  app.get(`${DOCS_BASE}/scalar.js`, (c) => {
    const b = loadBundle();
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', cache);
    c.header('ETag', b.etag);
    c.header('Vary', 'Accept-Encoding');
    if (c.req.header('if-none-match') === b.etag) return c.body(null, 304);
    if (/\bgzip\b/i.test(c.req.header('accept-encoding') ?? '')) {
      c.header('Content-Encoding', 'gzip');
      return c.body(new Uint8Array(b.gz));
    }
    return c.body(new Uint8Array(b.raw));
  });
};
