// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { readWebBuild, setServedBuild } from './modules/pwa/build';
import type { AppEnv } from './types';

/**
 * Production: the API process also serves the built SPA (apps/web/dist) so web and API share one origin and the
 * session cookie works without cross-site settings (D2). `/api/*` never falls through to the SPA.
 */
/**
 * The service worker's kill switch (PWA פ2): served instead of the real worker when the owner turned it off. Each
 * installed copy fetches /sw.js on its next check, installs this, empties its caches, unregisters itself and reloads
 * its pages from the network — nobody stays stuck on a broken version.
 */
export const KILL_SWITCH_SW = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The page's names (white-label): the tab title and the home-screen title, from the platform settings. */
export type PageNames = { title: string; appTitle: string };

/**
 * index.html carries neutral placeholders (an empty `<title>`, an empty iOS app title); the served page gets the
 * platform's names, so the tab shows the product name before any script runs (the app keeps it current after).
 */
export const brandIndexHtml = (html: string, names: PageNames | null) => {
  if (!names) return html;
  return html
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(names.title)}</title>`)
    .replace(
      /(<meta name="apple-mobile-web-app-title" content=")[^"]*(")/,
      (_m, a: string, b: string) => `${a}${escapeHtml(names.appTitle)}${b}`,
    );
};

export const mountWeb = (
  app: OpenAPIHono<AppEnv>,
  webDistDir: string,
  opts: { swEnabled?: () => Promise<boolean>; pageNames?: (c: Context<AppEnv>) => Promise<PageNames> } = {},
) => {
  const root = relative(process.cwd(), webDistDir) || '.';
  const indexHtml = readFileSync(join(webDistDir, 'index.html'), 'utf8');
  const swPath = join(webDistDir, 'sw.js');
  const sw = existsSync(swPath) ? readFileSync(swPath, 'utf8') : null;
  // The build the pages compare with (GET /public/pwa/status).
  setServedBuild(readWebBuild(webDistDir));

  // The service worker: always revalidated (a new deploy = a new worker), scope = the whole app.
  app.get('/sw.js', async (c) => {
    const enabled = opts.swEnabled ? await opts.swEnabled().catch(() => true) : true;
    c.header('Content-Type', 'text/javascript; charset=utf-8');
    c.header('Cache-Control', 'no-cache');
    c.header('Service-Worker-Allowed', '/');
    return c.body(enabled && sw !== null ? sw : KILL_SWITCH_SW, 200);
  });

  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.ok) c.header('Cache-Control', 'public, max-age=31536000, immutable');
  });
  // The page itself is never cached: after a deploy the browser picks up the new bundle at once.
  app.use('*', async (c, next) => {
    await next();
    if (!c.req.path.startsWith('/api/') && c.res.headers.get('content-type')?.includes('text/html'))
      c.header('Cache-Control', 'no-cache');
  });
  const page = async (c: Context<AppEnv>) =>
    c.html(brandIndexHtml(indexHtml, opts.pageNames ? await opts.pageNames(c).catch(() => null) : null));
  // The page itself (also at "/" — never the raw file, which has only placeholders).
  app.get('/', page);
  app.get('/index.html', page);
  app.use('*', async (c, next) => (c.req.path.startsWith('/api/') ? next() : serveStatic({ root })(c, next)));
  app.get('*', (c, next) => (c.req.path.startsWith('/api/') ? next() : page(c)));
};
