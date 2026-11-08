// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import { z } from 'zod';
import type { AppDeps } from '../../types';
import { sweepPlanTransitions } from './plan-status';
import { sendRenewalReminders } from './renewal-reminder';

/**
 * Plans: scheduled status steps (a trial ending, the grace running out, read-only becoming suspended)
 * change nothing in the database — the status is computed — so this minute sweep tells the accounts whose status
 * changed in the last minute (`account.plan_changed` on /me/events) and the app refetches without a reload.
 */
export const PLAN_TRANSITIONS_TASK = 'billing.plan_transitions';
/** the yearly renewal reminder, hourly (each renewal is reminded once). */
export const RENEWAL_REMINDERS_TASK = 'billing.renewal_reminders';
const MINUTE = 60_000;

const cronPayload = z.object({ _cron: z.object({ ts: z.string() }).optional() }).loose();

export const billingTasks = (deps: AppDeps): TaskList => ({
  [PLAN_TRANSITIONS_TASK]: async (payload) => {
    const ts = cronPayload.safeParse(payload ?? {}).data?._cron?.ts;
    const to = ts ? new Date(ts) : new Date();
    const moved = await sweepPlanTransitions(deps.db, new Date(to.getTime() - MINUTE), to);
    if (moved.length) deps.logger.info({ accounts: moved.length }, 'billing.plan_transitions');
  },
  [RENEWAL_REMINDERS_TASK]: async () => {
    const sent = await sendRenewalReminders(deps);
    if (sent) deps.logger.info({ sent }, 'billing.renewal_reminders');
  },
});

export const billingCronItems: CronItem[] = [
  {
    task: PLAN_TRANSITIONS_TASK,
    match: '* * * * *',
    identifier: PLAN_TRANSITIONS_TASK,
    options: { backfillPeriod: 10 * MINUTE },
  },
  { task: RENEWAL_REMINDERS_TASK, match: '17 * * * *', identifier: RENEWAL_REMINDERS_TASK },
];
