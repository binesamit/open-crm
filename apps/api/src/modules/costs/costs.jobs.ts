// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import { costSyncInputSchema } from '@bines/shared';
import type { AppDeps } from '../../types';
import { COST_SYNC_TASK, COST_TICK_TASK, costTick, runCostSync } from './costs.service';

/**
 * Costs: the hourly tick runs the daily sync at the owner's hour (and then the alerts); a "sync now"
 * or a new source queues `costs.sync`.
 */
export const costTasks = (deps: AppDeps): TaskList => ({
  [COST_SYNC_TASK]: async (payload) => {
    await runCostSync(deps, costSyncInputSchema.parse(payload ?? {}));
  },
  [COST_TICK_TASK]: async () => {
    if (await costTick(deps)) deps.logger.info(COST_TICK_TASK);
  },
});

export const costCronItems: CronItem[] = [{ task: COST_TICK_TASK, match: '17 * * * *', identifier: COST_TICK_TASK }];
