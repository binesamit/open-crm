#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// create-bines-app — a new Bines OS extension in a minute (D27 ת8, docs/EXTENSIONS-GUIDE.md):
//   node packages/create-bines-app/index.mjs my-board-view [--name "My view"] [--port 5180] [--server]
// From npm: npx create-bines-app my-board-view. Then: cd my-board-view && npm install && npm run dev →
// in Bines: Administration → Extensions → add by URL →
// http://localhost:5180/manifest.json (development only: a production server refuses localhost).
import { parseArgs } from 'node:util';
import { scaffold } from './scaffold.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    id: { type: 'string' },
    port: { type: 'string' },
    server: { type: 'boolean', default: false },
    sdk: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const dir = positionals[0];
if (values.help || !dir) {
  console.warn(
    [
      'Usage: create-bines-app <folder> [--id my-ext] [--name "Name"] [--port 5180] [--server] [--sdk <spec>]',
      '  --server  also an extension server: signed lifecycle calls + OAuth client credentials (ת6)',
    ].join('\n'),
  );
  process.exit(dir ? 0 : 1);
}

const id = values.id ?? dir.split(/[\\/]/).pop().toLowerCase();
try {
  const files = scaffold({
    dir,
    id,
    name: values.name,
    port: values.port ? Number(values.port) : undefined,
    server: values.server,
    sdk: values.sdk,
  });
  console.warn(`Created ${id} in ${dir}:\n  ${files.join('\n  ')}`);
  console.warn(`\nNext:\n  cd ${dir}\n  npm install\n  npm run dev${values.server ? '\n  npm run server' : ''}`);
  const port = values.port ? Number(values.port) : 5180;
  console.warn(
    `\nThen in Bines (development only): Administration → Extensions → add by URL → http://localhost:${port}/manifest.json`,
  );
} catch (err) {
  console.error(`create-bines-app: ${err.message}`);
  process.exit(1);
}
