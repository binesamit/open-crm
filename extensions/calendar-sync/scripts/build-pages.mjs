// SPDX-License-Identifier: AGPL-3.0-only
// After tsup: the pages go to dist/public, with the page SDK (packages/ext-sdk, types stripped) as sdk.js — so the
// image needs no TypeScript and no workspace sources at runtime.
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const out = here('../dist/public/');
await mkdir(out, { recursive: true });
await cp(here('../public/'), out, { recursive: true });
const sdk = fileURLToPath(import.meta.resolve('@bines/ext-sdk'));
await writeFile(`${out}sdk.js`, stripTypeScriptTypes(await readFile(sdk, 'utf8')));
console.warn(`pages → ${out}`);
