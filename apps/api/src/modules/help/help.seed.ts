// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { count, eq } from 'drizzle-orm';
import { zipSync, type Zippable } from 'fflate';
import type { AppDeps, SessionUser } from '../../types';
import { helpArticles, platformSettings } from '../../db/schema';
import { importHelpPackage } from './help.import';
import type { StaffActor } from '../tickets/console.service';

/**
 * The help center that ships with the code (seed/help: articles, practical guides, guided tours, their images — the
 * same package format the owner console imports). A new installation starts with it instead of an empty help
 * center. It is loaded once: the `help_seed` row marks it, so articles the owner later edits or deletes are never
 * brought back. An installation that already has articles is only marked (nothing is imported over its own).
 *
 * HELP_SEED=false skips it; HELP_SEED_DIR points to another package folder (default ../../seed/help, like
 * TEMPLATES_DIR — the API runs from apps/api).
 */
const MARK = 'help_seed';

/** The importer acts as the platform owner; nobody signed in, so no user is recorded as the author. */
const systemStaff = (): StaffActor => ({
  user: {
    id: null as unknown as string,
    email: '',
    name: 'system',
    emailVerified: true,
    isPlatformOwner: true,
    locale: 'he',
    timezone: null,
  } satisfies SessionUser,
  role: 'owner',
});

/** Every file under the folder, zipped with its package paths (articles/he/x.md, images/x.webp, tours.json …). */
export const packFolder = (dir: string): Uint8Array => {
  const zip: Zippable = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name !== 'README.md') zip[relative(dir, full).replace(/\\/g, '/')] = [readFileSync(full), { level: 0 }];
    }
  };
  walk(dir);
  return zipSync(zip);
};

export const seedHelpCenter = async (
  deps: Pick<AppDeps, 'db' | 'env' | 'logger' | 'secrets' | 'storage'>,
  opts: { dir?: string; enabled?: boolean } = {},
): Promise<'skipped' | 'marked' | 'imported'> => {
  const enabled = opts.enabled ?? process.env.HELP_SEED !== 'false';
  const dir = opts.dir ?? process.env.HELP_SEED_DIR ?? '../../seed/help';
  if (!enabled || !existsSync(dir)) return 'skipped';
  const [marked] = await deps.db.select().from(platformSettings).where(eq(platformSettings.id, MARK)).limit(1);
  if (marked) return 'skipped';
  const mark = (settings: Record<string, unknown>) =>
    deps.db
      .insert(platformSettings)
      .values({ id: MARK, settings: { at: new Date().toISOString(), ...settings } })
      .onConflictDoNothing();
  const n = (await deps.db.select({ n: count() }).from(helpArticles))[0]?.n ?? 0;
  if (n > 0) {
    await mark({ imported: false });
    return 'marked';
  }
  const report = await importHelpPackage(deps, systemStaff(), [{ name: 'help.zip', bytes: packFolder(dir) }], false);
  await mark({ imported: true, counts: report.counts });
  deps.logger.info({ counts: report.counts, warnings: report.warnings?.length ?? 0 }, 'help center loaded');
  return 'imported';
};
