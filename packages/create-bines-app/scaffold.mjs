// SPDX-License-Identifier: MIT
// The scaffolding itself (index.mjs is the command line around it): copies template/ into a new folder and fills
// in the extension's id, name, port and — when asked — its own server. Dependency-free (node:fs only).
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_DIR = join(here, 'template');

/** Files whose real name would confuse the tools of this repo (or npm) while they sit in template/. */
const RENAMES = { '_package.json': 'package.json', _gitignore: '.gitignore' };

/**
 * The @bines/ext-sdk version a new project depends on when this CLI runs from npm (`npx create-bines-app`) — kept
 * equal to packages/ext-sdk/package.json (a test checks it; scripts/publish-sdk.ps1 publishes both together).
 */
export const SDK_VERSION = '1.0.0';

/**
 * This repository's packages/ext-sdk when the CLI runs from the Bines source (`node packages/create-bines-app/…`);
 * null when it runs from npm (node_modules or the npx cache) — then the published SDK is the one to use.
 */
export const repoSdkDir = (from = here) => {
  if (/[\\/]node_modules[\\/]/.test(from)) return null;
  const dir = resolve(from, '../ext-sdk');
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === '@bines/ext-sdk' ? dir : null;
  } catch {
    return null;
  }
};

/** The @bines/ext-sdk dependency: `--sdk` as given, else the repository's copy, else the npm version. */
export const sdkSpec = (explicit, from = here) => {
  if (explicit) return explicit;
  const local = repoSdkDir(from);
  return local ? `file:${local.replace(/\\/g, '/')}` : `^${SDK_VERSION}`;
};

/** An extension id: lowercase letters, digits and dashes (the manifest's `id`). */
export const validId = (id) => /^[a-z][a-z0-9-]{1,47}$/.test(id) && id !== 'empty' && id !== 'default';

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

/**
 * @param {{ dir: string, id: string, name?: string, port?: number, server?: boolean, sdk?: string }} opts
 *   sdk: the `@bines/ext-sdk` dependency spec (default: sdkSpec — this repo's packages/ext-sdk, else the npm one).
 * @returns {string[]} the files written (relative to dir)
 */
export const scaffold = (opts) => {
  const dir = resolve(opts.dir);
  if (!validId(opts.id)) throw new Error(`"${opts.id}" is not a valid extension id (a-z, 0-9, dashes; 2–48)`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
  const port = Number(opts.port ?? 5180);
  if (!Number.isInteger(port) || port < 1024 || port > 65000) throw new Error('port must be 1024–65000');
  const sdk = sdkSpec(opts.sdk);
  const vars = {
    __APP_ID__: opts.id,
    __APP_NAME__: (opts.name ?? opts.id).replace(/["\\]/g, ''),
    __PORT__: String(port),
    __SERVER_PORT__: String(port + 1),
    __WITH_SERVER__: opts.server ? 'true' : 'false',
    __SDK__: sdk,
  };
  const written = [];
  for (const file of walk(TEMPLATE_DIR)) {
    let rel = relative(TEMPLATE_DIR, file);
    const base = rel.split(/[\\/]/).pop();
    if (RENAMES[base]) rel = join(dirname(rel), RENAMES[base]);
    // The server part only when asked for.
    if (!opts.server && rel.split(/[\\/]/)[0] === 'server') continue;
    let text = readFileSync(file, 'utf8');
    for (const [k, v] of Object.entries(vars)) text = text.split(k).join(v);
    const out = join(dir, rel);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    written.push(rel.replace(/\\/g, '/'));
  }
  return written.sort();
};
