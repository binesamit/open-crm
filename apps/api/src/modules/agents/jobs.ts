// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import { z } from 'zod';
import type { AppDeps } from '../../types';
import { executeRun, expireApprovals } from './engine/loop';
import { indexSource } from './knowledge.service';

const runPayload = z.object({ run_id: z.string().min(1) });
const sourcePayload = z.object({ source_id: z.string().min(1) });

/**
 * Agent jobs (מ6–מ7) run in the api process next to the automation engine (D21): the loop uses the same services
 * and tool runners as the routes. `agent.resume` is the same step loop — it rebuilds the run from its saved steps.
 */
export const agentTasks = (deps: AppDeps): TaskList => ({
  'agent.run': async (payload) => {
    await executeRun(deps, runPayload.parse(payload).run_id);
  },
  'agent.resume': async (payload) => {
    await executeRun(deps, runPayload.parse(payload).run_id);
  },
  'agent.expire_approvals': async () => {
    await expireApprovals(deps);
  },
  // Knowledge (מ9): extract → passages → full-text index.
  'agent.knowledge_index': async (payload) => {
    await indexSource(deps, sourcePayload.parse(payload).source_id);
  },
});

export const agentCronItems: CronItem[] = [
  { task: 'agent.expire_approvals', match: '7 * * * *', identifier: 'agent.expire_approvals' },
];
