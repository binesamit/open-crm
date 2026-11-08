// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import type { AppDeps } from '../../types';
import { scheduledCleaning } from './cleaning.service';

/**
 * `tidy.scheduled_cleaning` (M8 ד13): in the api process's runner (D21) because archiving goes through the same
 * services and events as the routes; the maintenance worker (apps/worker) never registers it.
 */
export const tidyTasks = (deps: AppDeps): TaskList => ({
  'tidy.scheduled_cleaning': async () => {
    const out = await scheduledCleaning(deps);
    deps.logger.info(out, 'tidy.scheduled_cleaning');
  },
});

/** Daily at 02:40 UTC (a quiet hour in Israel). Object form — crontab strings reject dotted names. */
export const tidyCronItems: CronItem[] = [
  { task: 'tidy.scheduled_cleaning', match: '40 2 * * *', identifier: 'tidy.scheduled_cleaning' },
];
