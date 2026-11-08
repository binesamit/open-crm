// SPDX-License-Identifier: MIT
// tsc copies only .ts output; n8n loads the node and credential icons from next to the compiled files.
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
for (const folder of ['nodes', 'credentials'])
  for (const file of walk(join(root, folder)).filter((f) => /\.(svg|png)$/.test(f))) {
    const to = join(root, 'dist', relative(root, file));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(file, to);
  }
