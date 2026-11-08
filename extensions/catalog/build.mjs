// SPDX-License-Identifier: AGPL-3.0-only
// Static build of the catalogue's sample extensions for production hosting on a SEPARATE origin (round 13).
//
//   node extensions/catalog/build.mjs <out-dir> --origin https://ext.example.com --app https://work.example.com
//     [--embedded-by chrome-extension://<id>,…]
//
// Writes: the pages, common.js, style.css, sdk.js (packages/ext-sdk, types stripped), config.js (the app's origin
// pinned — the SDK ignores messages from anywhere else), <key>/manifest.json for that origin, and `_headers`
// (Cloudflare Pages / Netlify format) with a CSP whose frame-ancestors is the app's origin only. Refuses an
// --origin equal to --app: an extension must never be served from the app's own origin.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const out = resolve(args[0] ?? 'dist-ext');
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const plainOrigin = (s, name) => {
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`--${name} must be an origin like https://host`);
  }
  if (u.origin !== s) throw new Error(`--${name} must be an origin (no path): ${s}`);
  return s;
};
const origin = plainOrigin(flag('origin') ?? '', 'origin');
const app = plainOrigin(flag('app') ?? '', 'app');
// The origins allowed to embed the app's panel page (owner console → "allowed embedding origins", e.g. a browser
// extension's side panel). frame-ancestors checks EVERY ancestor, so an extension framed inside that panel page
// needs them too. Comma-separated: --embedded-by chrome-extension://<id>,https://crm.example.com
const embeddedBy = (flag('embedded-by') ?? '')
  .split(',')
  .filter(Boolean)
  .map((s) => {
    if (!/^(chrome-extension:\/\/[a-p]{32}|https:\/\/[a-z0-9.-]+(:\d{1,5})?)$/.test(s))
      throw new Error(`--embedded-by takes chrome-extension://<id> or https origins: ${s}`);
    return s;
  });
if (origin === app) throw new Error('the extensions origin must differ from the app origin');
if (!origin.startsWith('https://')) console.warn('warning: production extensions must be served over https');

const SAMPLES = {
  'board-summary': 'sample-board-summary.json',
  'kanban-stats': 'sample-kanban-stats.json',
  fitness: 'sample-fitness.json',
  'browser-panel': 'sample-browser-panel.json',
};
const FILES = [
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

const write = async (rel, body) => {
  const p = join(out, rel);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, body);
};

for (const f of FILES) await write(f, await readFile(join(here, f)));
await write('sdk.js', stripTypeScriptTypes(await readFile(join(here, '../../packages/ext-sdk/src/index.ts'), 'utf8')));
await write('config.js', `export const HOST_ORIGIN = ${JSON.stringify(app)};\n`);
for (const [key, file] of Object.entries(SAMPLES)) {
  const raw = await readFile(join(here, '../../seed/packs', file), 'utf8');
  await write(`${key}/manifest.json`, raw.replaceAll('{{SAMPLE_EXTENSIONS_ORIGIN}}', origin));
}
await write(
  '_headers',
  `/*\n  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src ${app}; frame-ancestors ${[app, ...embeddedBy].join(' ')}\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n`,
);
console.warn(`built the sample extensions for ${origin} (framed by ${app}) into ${out}`);
