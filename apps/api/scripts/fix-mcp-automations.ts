// SPDX-License-Identifier: AGPL-3.0-only
/**
 * D26 one-off: rebuilds the seed automations L3, S3c (+ S3d), T1 from built-in actions and turns Q1's placeholder
 * into {{N8N_URL}} — see fix-mcp-automations.lib.ts. DRY RUN by default (prints what would change); write with
 * --apply. Run it on prod after the release that brings `copy_from_linked` and `now+Nh`.
 *
 * Usage: pnpm --filter @bines/api automations:fix-mcp -- [--account <slug>] [--dir <recipes folder>] [--apply]
 * The recipes folder: --dir, else SEED_AUTOMATIONS_DIR (private data, not in the repository).
 */
import { createDb, type Db } from '../src/db/client';
import { loadEnv } from '../src/env';
import { fixMcpAutomations, type Line } from './fix-mcp-automations.lib';

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
class DryRun extends Error {}

const out = (s: string) => process.stdout.write(`${s}\n`);
const print = (report: Line[], dryRun: boolean) => {
  for (const r of report) {
    out(`${r.account.padEnd(16)} ${r.key.padEnd(4)} ${r.result}`);
    for (const i of r.issues ?? []) out(`${' '.repeat(22)}· ${i}`);
  }
  out(dryRun ? '\nDRY RUN — nothing written. Run again with --apply to write.' : '\nDone.');
};

const main = async () => {
  const apply = args.includes('--apply');
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url));
  } catch {
    // Railway: the real environment
  }
  const env = loadEnv();
  const { db, close } = createDb(env.DATABASE_URL!);
  let report: Line[] = [];
  try {
    await db.transaction(async (tx) => {
      report = await fixMcpAutomations(tx as unknown as Db, option('account'), option('dir'));
      if (!apply) throw new DryRun();
    });
    print(report, false);
  } catch (e) {
    if (!(e instanceof DryRun)) throw e;
    print(report, true);
  } finally {
    await close();
  }
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
