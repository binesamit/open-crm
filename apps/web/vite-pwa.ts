// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { type BundleEntry, buildId, precacheList, swMarkRead, swRoute } from './src/pwa/precache.ts';

const TEMPLATE = fileURLToPath(new URL('./src/pwa/sw.template.js', import.meta.url));

/** sw.js from the template: the build id, the files to keep up front, the request router and the push mark-read. */
export const renderServiceWorker = (files: string[]) =>
  readFileSync(TEMPLATE, 'utf8')
    .replace("'__BUILD__'", JSON.stringify(buildId(files)))
    .replace('__PRECACHE__', JSON.stringify(files))
    .replace('__SW_ROUTE__', swRoute.toString())
    .replace('__SW_MARK_READ__', swMarkRead.toString());

/**
 * The phone app's service worker (PWA פ2): written to dist/sw.js at build time with the hashed files of this build.
 * In development it is served from memory with nothing precached — the app registers it only when asked
 * (localStorage `bines.pwa.dev` = '1', used by the E2E test).
 */
/**
 * The build id of this web build ("must refresh to continue"): PWA_BUILD_ID when given, else the deployed commit
 * (Railway), else the build time. The page compiles it in (`__APP_BUILD__`) and dist/build.json carries it to the
 * API, which answers it in GET /public/pwa/status — a page whose id differs runs an older build.
 */
export const webBuildId = (env: NodeJS.ProcessEnv = process.env, now = Date.now()) =>
  env.PWA_BUILD_ID?.trim() || env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || now.toString(36);

export const pwaServiceWorker = (): Plugin => {
  let build = 'dev';
  return {
    name: 'bines-pwa-sw',
    config(_config, { command }) {
      // The dev server is 'dev' (the API in development answers 'dev' too: no comparison).
      build = command === 'build' ? webBuildId() : 'dev';
      return { define: { __APP_BUILD__: JSON.stringify(build) } };
    },
    configureServer(server) {
      server.middlewares.use('/sw.js', (_req, res) => {
        res.setHeader('Content-Type', 'text/javascript; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Service-Worker-Allowed', '/');
        res.end(renderServiceWorker([]));
      });
    },
    generateBundle(_options, bundle) {
      const files = precacheList(bundle as unknown as Record<string, BundleEntry>);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: renderServiceWorker(files) });
      this.emitFile({ type: 'asset', fileName: 'build.json', source: JSON.stringify({ build }) });
    },
  };
};
