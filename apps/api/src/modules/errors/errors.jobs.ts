// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import type { AppDeps } from '../../types';
import { runDigests, runInstantAlerts } from './errors.alerts';
import { autoResolveQuiet, purgeExpired } from './errors.repo';
import { loadErrorHubSettings } from './errors.settings';
import { flushErrors } from './errors.writer';

/**
 * The errors hub's recurring work, in the api process next to the other jobs: instant alerts every
 * minute; once an hour the digest (at the settings' hour), auto-resolve of quiet errors and retention.
 */
export const ERRORS_ALERT_TASK = 'errors.alerts';
export const ERRORS_MAINTAIN_TASK = 'errors.maintain';

/** Hourly counts are kept as long as the longest alert window (a week) and a day of bars, with a margin. */
const KEEP_HOURS_DAYS = 8;

/** One maintenance pass (exported for the tests, which pass `now`). */
export const maintainErrors = async (deps: Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>, now = new Date()) => {
  await flushErrors(deps.db);
  const settings = await loadErrorHubSettings(deps.db);
  const resolved = await autoResolveQuiet(deps.db, now, settings.auto_resolve_hours);
  const purged = await purgeExpired(deps.db, now, settings.retention_days, KEEP_HOURS_DAYS);
  const digests = await runDigests(deps, now);
  return { resolved, purged, digests };
};

export const errorTasks = (deps: AppDeps): TaskList => ({
  [ERRORS_ALERT_TASK]: async () => {
    await flushErrors(deps.db);
    const n = await runInstantAlerts(deps);
    if (n) deps.logger.info({ alerted: n }, 'errors.alerts: alerts sent');
  },
  [ERRORS_MAINTAIN_TASK]: async () => {
    const r = await maintainErrors(deps);
    if (r.resolved || r.purged || r.digests) deps.logger.info(r, 'errors.maintain');
  },
});

export const errorCronItems: CronItem[] = [
  { task: ERRORS_ALERT_TASK, match: '* * * * *', identifier: ERRORS_ALERT_TASK },
  { task: ERRORS_MAINTAIN_TASK, match: '5 * * * *', identifier: ERRORS_MAINTAIN_TASK },
];
