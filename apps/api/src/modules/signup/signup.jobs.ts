// SPDX-License-Identifier: AGPL-3.0-only
import type { CronItem, TaskList } from 'graphile-worker';
import type { AppDeps } from '../../types';
import { sweepSignup } from './signup.service';
import { sendDueTrialEmails } from './signup.trial';

/**
 * Self sign-up (D32): once a day, links past their time expire (their password hash goes with them) and ended
 * requests older than SIGNUP_KEEP_DAYS are deleted.
 */
export const SIGNUP_SWEEP_TASK = 'signup.sweep';
/** Every hour: the trial emails that are due (welcome, reminders, ended, before suspension — signup.trial.ts). */
export const SIGNUP_TRIAL_EMAILS_TASK = 'signup.trial_emails';

export const signupTasks = (deps: Pick<AppDeps, 'db' | 'env' | 'mailer' | 'logger'>): TaskList => ({
  [SIGNUP_SWEEP_TASK]: async () => {
    const done = await sweepSignup(deps.db);
    if (done.expired || done.deleted) deps.logger.info(done, SIGNUP_SWEEP_TASK);
  },
  [SIGNUP_TRIAL_EMAILS_TASK]: async () => {
    const sent = await sendDueTrialEmails(deps);
    if (sent) deps.logger.info({ sent }, SIGNUP_TRIAL_EMAILS_TASK);
  },
});

export const signupCronItems: CronItem[] = [
  { task: SIGNUP_SWEEP_TASK, match: '35 3 * * *', identifier: SIGNUP_SWEEP_TASK },
  { task: SIGNUP_TRIAL_EMAILS_TASK, match: '7 * * * *', identifier: SIGNUP_TRIAL_EMAILS_TASK },
];
