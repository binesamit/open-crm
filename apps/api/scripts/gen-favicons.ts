// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The static default tab icons of the web app (apps/web/public): the built-in app icon — the same drawing the
 * server serves as the home-screen icon without a logo (src/modules/pwa/icons.ts), in the built-in colour.
 * The page links them before sign-in; inside an account the app uses the account's icon instead.
 *
 * Run after changing the drawing: `pnpm --filter @bines/api exec tsx scripts/gen-favicons.ts`
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PWA_THEME, type PwaIcon } from '@bines/shared';
import { defaultIcon } from '../src/modules/pwa/icons';

const out = resolve(dirname(fileURLToPath(import.meta.url)), '../../web/public');
const png = (size: number) => defaultIcon(DEFAULT_PWA_THEME, `favicon-${size}` as PwaIcon);

/** favicon.ico: PNG-in-ICO (16 and 32), for browsers / tools that ask /favicon.ico by themselves. */
const ico = (images: { size: number; bytes: Buffer }[]) => {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, bytes }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size, 0);
    e.writeUInt8(size, 1);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(bytes.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += bytes.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.bytes)]);
};

const sizes = [16, 32].map((size) => ({ size, bytes: png(size) }));
for (const { size, bytes } of sizes) writeFileSync(resolve(out, `favicon-${size}.png`), bytes);
writeFileSync(resolve(out, 'favicon.ico'), ico(sizes));
process.stdout.write(`wrote favicon-16.png, favicon-32.png, favicon.ico to ${out}\n`);
