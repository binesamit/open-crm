// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import { z } from 'zod';
import { CONVERT_BACKUP_DAYS_DEFAULT } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps } from '../../types';
import { getAccountSettings } from '../accounts/accounts.repo';
import { accountsWithBackups, conversionsToPurge, purgeBackup } from './conversions.repo';
import { CONVERT_TASK, runConversion, sweepStaleConversions } from './conversions.service';

const PURGE_TASK = 'column.convert_purge';
/** Conversions a dead process left `running` (column locked) are failed and unlocked (audit 2026-10-10 C7). */
const SWEEP_TASK = 'column.convert_sweep';

/**
 * Backups older than the account's retention (default 90 days; 0 = kept until removed) are removed: the conversion
 * stays in the history, without "restore from backup". Returns how many backups were removed.
 */
export const purgeConversionBackups = async (db: Db, now = new Date()) => {
  let purged = 0;
  for (const accountId of await accountsWithBackups(db)) {
    const s = (await getAccountSettings(db, accountId)) as { conversions?: { backup_days?: number } };
    const days = s.conversions?.backup_days ?? CONVERT_BACKUP_DAYS_DEFAULT;
    if (!days) continue;
    for (const c of await conversionsToPurge(db, accountId, new Date(now.getTime() - days * 86_400_000))) {
      await purgeBackup(db, c.id);
      purged++;
    }
  }
  return purged;
};

/** Large conversions (D28 §9) run in the api's job runner, with the same services as the request. */
export const conversionTasks = (deps: AppDeps): TaskList => ({
  [CONVERT_TASK]: async (payload) => {
    const { conversion_id } = z.object({ conversion_id: z.string().min(1) }).parse(payload);
    await runConversion(deps.db, conversion_id, { requestId: null, sync: false });
  },
  [PURGE_TASK]: async () => {
    await purgeConversionBackups(deps.db);
  },
  [SWEEP_TASK]: async () => {
    await sweepStaleConversions(deps.db);
  },
});

export const conversionCronItems: CronItem[] = [
  { task: PURGE_TASK, match: '40 3 * * *', identifier: PURGE_TASK },
  { task: SWEEP_TASK, match: '*/10 * * * *', identifier: SWEEP_TASK },
];
