// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import { z } from 'zod';
import type { AppDeps } from '../../types';
import { executeColumnRun, runDueAutoCells } from './columns.service';
import { IMAGE_UNIT_TASK, imageUnitJob, imageUnitSchema } from './image-queue';

const runPayload = z.object({ run_id: z.string().min(1) });

/** AI column jobs (מ11) run in the api process next to the automations (D21): same services, same rights. */
export const ai2Tasks = (deps: AppDeps): TaskList => ({
  'ai.column_run': async (payload) => {
    await executeColumnRun(deps, runPayload.parse(payload).run_id);
  },
  // The images queue: one design of an image column run, then the next one queued.
  [IMAGE_UNIT_TASK]: async (payload) => {
    await imageUnitJob(deps, imageUnitSchema.parse(payload));
  },
  // Debounced auto-runs: each change queues one of these a little after its debounce; the minute sweep is a net.
  'ai.column_auto': async () => {
    while ((await runDueAutoCells(deps)) > 0);
  },
});

export const ai2CronItems: CronItem[] = [{ task: 'ai.column_auto', match: '* * * * *', identifier: 'ai.column_auto' }];
