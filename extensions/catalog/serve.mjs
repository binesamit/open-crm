// SPDX-License-Identifier: AGPL-3.0-only
// Development host of the catalogue's sample extensions (round 13): "סיכום בורד" (board view) and "סטטיסטיקת קנבן"
// (dashboard widget). Static pages on their OWN origin (never the app's — an extension must not share our origin),
// the SDK as /sdk.js (packages/ext-sdk with its TypeScript types stripped by Node) and each manifest as
// /<key>/manifest.json (the same files the catalogue is seeded from: seed/packs/sample-*.json).
//
//   node extensions/catalog/serve.mjs [port]      (default 3997, on 127.0.0.1)
//   SAMPLE_EXTENSIONS_ORIGIN=http://127.0.0.1:3997 pnpm db:seed     → the samples appear in every account's store
//
// Production: `node extensions/catalog/build.mjs <out-dir> --origin https://ext.example.com --app https://app.example`
// writes the same pages as static files (with the SDK, the pinned host origin and a frame-ancestors header file)
// for a separate static host — see extensions/catalog/README.md.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sdkSource = join(here, '../../packages/ext-sdk/src/index.ts');
const packs = join(here, '../../seed/packs');
const port = Number(process.argv[2] ?? process.env.EXT_CATALOG_PORT ?? 3997);
const origin = `http://127.0.0.1:${port}`;

export const SAMPLES = {
  'board-summary': 'sample-board-summary.json',
  'kanban-stats': 'sample-kanban-stats.json',
  fitness: 'sample-fitness.json',
  'browser-panel': 'sample-browser-panel.json',
};
export const FILES = [
  'common.js',
  'style.css',
  'board-summary/index.html',
  'board-summary/app.js',
  'kanban-stats/index.html',
  'kanban-stats/app.js',
  'fitness/index.html',
  'fitness/fitness.css',
  'fitness/app.js',
  'fitness/data.js',
  'fitness/model.js',
  'fitness/ui.js',
  'browser-panel/index.html',
  'browser-panel/app.js',
];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

/** A sample's manifest for this origin (the seed file with its origin placeholder filled in). */
export const manifestFor = async (key, o = origin) =>
  JSON.parse((await readFile(join(packs, SAMPLES[key]), 'utf8')).replaceAll('{{SAMPLE_EXTENSIONS_ORIGIN}}', o));

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', origin).pathname;
  // Pages may be framed only by the local app (in production the build's header file pins the app's origin).
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src http://localhost:* http://127.0.0.1:*; frame-ancestors http://localhost:* http://127.0.0.1:*",
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (path === '/health') return res.end('ok');
    const m = /^\/([a-z-]+)\/manifest\.json$/.exec(path);
    if (m && SAMPLES[m[1]]) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(await manifestFor(m[1])));
    }
    if (path === '/sdk.js') {
      res.setHeader('content-type', TYPES['.js']);
      return res.end(stripTypeScriptTypes(await readFile(sdkSource, 'utf8')));
    }
    // Development: not pinned (the app may run on localhost or 127.0.0.1).
    if (path === '/config.js') {
      res.setHeader('content-type', TYPES['.js']);
      return res.end("export const HOST_ORIGIN = '';\n");
    }
    const file = path.slice(1);
    if (!FILES.includes(file)) {
      res.statusCode = 404;
      return res.end('not found');
    }
    res.setHeader('content-type', TYPES[file.slice(file.lastIndexOf('.'))]);
    res.end(await readFile(join(here, file)));
  } catch (err) {
    res.statusCode = 500;
    res.end(String(err));
  }
});

server.listen(port, '127.0.0.1', () => console.warn(`catalogue sample extensions on ${origin}`));
