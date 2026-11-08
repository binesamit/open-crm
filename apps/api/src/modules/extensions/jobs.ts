// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import { lt } from 'drizzle-orm';
import { extensionServerTokens } from '../../db/schema';
import type { AppDeps } from '../../types';
import { dailyUpdateCheck } from './updates';

/**
 * `extensions.update_check` (D27 ת6, MARKETPLACE §4.5): once a day every installation's manifest is fetched again;
 * a version asking for nothing new applies by itself, one asking for more waits for an admin (bell). In the api
 * process's runner (D21) — it installs pack data through the same code as the routes.
 */
export const extensionTasks = (deps: AppDeps): TaskList => ({
  'extensions.update_check': async () => {
    const out = await dailyUpdateCheck(deps);
    // Extension server tokens live an hour: the expired ones go (a day later, for the audit trail's sake).
    await deps.db
      .delete(extensionServerTokens)
      .where(lt(extensionServerTokens.expiresAt, new Date(Date.now() - 86_400_000)));
    deps.logger.info(out, 'extensions.update_check');
  },
});

/** Daily at 03:25 UTC. Object form — crontab strings reject dotted names. */
export const extensionCronItems: CronItem[] = [
  { task: 'extensions.update_check', match: '25 3 * * *', identifier: 'extensions.update_check' },
];
