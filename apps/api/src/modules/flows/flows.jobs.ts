// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import type { AppDeps } from '../../types';
import { checkFlowFailures } from './flows.service';

/**
 * External flows: the failure check runs in the api process next to the other jobs (it needs the
 * platform adapters and the sealed keys). Every 5 minutes; each connection is asked only when its own interval
 * (an admin's setting) has passed.
 */
export const FLOWS_CHECK_TASK = 'flows.check';

export const flowTasks = (deps: AppDeps): TaskList => ({
  [FLOWS_CHECK_TASK]: async () => {
    const n = await checkFlowFailures(deps);
    if (n) deps.logger.info({ failures: n }, 'flows.check: new failures alerted');
  },
});

export const flowCronItems: CronItem[] = [
  { task: FLOWS_CHECK_TASK, match: '*/5 * * * *', identifier: FLOWS_CHECK_TASK },
];
