// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Test-only (e2e/zip-download.spec.ts): marks one file as an upload that never finished, so "download
 * all" has a file it cannot include. Local databases only — refuses any DATABASE_URL host other than localhost /
 * 127.0.0.1, like cleanup-local-test-data.
 *
 *   pnpm --filter @bines/api exec tsx scripts/e2e-asset-pending.ts <file id>
 */
import { eq } from 'drizzle-orm';
import { createDb } from '../src/db/client';
import { assets } from '../src/db/schema';

const id = process.argv[2];
if (!id || !/^[0-9A-Z]{26}$/.test(id)) throw new Error('usage: e2e-asset-pending.ts <file id>');
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch {
    // no .env: rely on the environment
  }
}
const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set');
const host = new URL(url).hostname;
if (!['localhost', '127.0.0.1'].includes(host))
  throw new Error(`refusing to touch ${host}: local databases only (localhost / 127.0.0.1)`);

const { db, close } = createDb(url);
await db.update(assets).set({ uploadStatus: 'pending' }).where(eq(assets.id, id));
await close();
console.warn(`asset ${id}: pending`);
