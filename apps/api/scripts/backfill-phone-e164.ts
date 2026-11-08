// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Plan one-off: fills `e164` / `valid` into every phone cell written before phone normalisation landed
 * (new writes get them on their own). What people see does not change — only the derived keys inside the value.
 * DRY RUN by default (counts what would change); write with --apply. Idempotent: a second run changes nothing.
 *
 * Usage:
 *   pnpm --filter @bines/api phone:backfill                         # dry run
 *   pnpm --filter @bines/api phone:backfill -- --apply              # write
 *   pnpm --filter @bines/api phone:backfill -- --account <slug>     # one account only
 * A DATABASE_URL other than localhost / 127.0.0.1 is refused unless --remote is given (production: the owner runs it,
 * e.g. `railway run pnpm --filter @bines/api phone:backfill -- --remote [--apply]`).
 */
import { eq } from 'drizzle-orm';
import { createDb, type Db } from '../src/db/client';
import { accounts } from '../src/db/schema';
import { loadEnv } from '../src/env';
import { backfillPhoneCells } from '../src/modules/phone/phone.service';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (s: string) => process.stdout.write(`${s}\n`);

const main = async () => {
  const apply = args.includes('--apply');
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch {
    // Railway: the real environment
  }
  const env = loadEnv();
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1'].includes(host) && !args.includes('--remote'))
    throw new Error(`refusing ${host}: local databases only (localhost / 127.0.0.1) unless --remote is given`);
  const { db, close } = createDb(url);
  try {
    let accountId: string | undefined;
    const slug = option('account');
    if (slug) {
      const [a] = await db.select({ id: accounts.id }).from(accounts).where(eq(accounts.slug, slug));
      if (!a) throw new Error(`no account with slug ${slug}`);
      accountId = a.id;
    }
    const stats = await backfillPhoneCells(db as unknown as Db, {
      apply,
      accountId,
      onBatch: (s) => out(`… scanned ${s.scanned}, to change ${s.changed}`),
    });
    out(
      `phone cells: ${stats.scanned} scanned · ${stats.valid} valid · ${stats.invalid} not valid (shown as typed) · ` +
        `${stats.skipped} unreadable · ${stats.changed} ${apply ? 'updated' : 'would change'}`,
    );
    out(apply ? 'Done.' : '\nDRY RUN — nothing written. Run again with --apply to write.');
  } finally {
    await close();
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
