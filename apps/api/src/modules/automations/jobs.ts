// SPDX-License-Identifier: AGPL-3.0-only
import {
  executeSupportDevelop,
  executeSupportRun,
  SUPPORT_AGENT_DEVELOP_TASK,
  SUPPORT_AGENT_TASK,
} from '../support-agent/engine';
import { autoInvestigate, SUPPORT_AGENT_AUTO_TASK } from '../support-agent/support-agent.service';
import type { Pool } from 'pg';
import { parseCronItems, run, type CronItem, type Runner, type TaskList } from 'graphile-worker';
import { z } from 'zod';
import type { AppDeps } from '../../types';
import { dispatchEvent, executeRun } from './engine/runner';
import { tickSchedules } from './engine/schedules';
import { executeScenarioRun, resumeScenarioRun, SCENARIO_RESUME_TASK, SCENARIO_RUN_TASK } from '../scenarios/engine';
import { failStaleRuns, recordRunOutcome, STALE_RUN_MS } from './automations.repo';
import { deliver } from '../webhooks/delivery';
import { purgeIdempotencyKeys } from '../../middleware/idempotency';
import { purgeByRetention, RETENTION_TASK } from '../platform/retention';
import { INCIDENTS_REMIND_TASK, remindIncidents } from '../platform/security-incidents';
import { agentCronItems, agentTasks } from '../agents/jobs';
import { flowCronItems, flowTasks } from '../flows/flows.jobs';
import { ai2CronItems, ai2Tasks } from '../ai2/jobs';
import { tidyCronItems, tidyTasks } from '../tidy/jobs';
import { extensionCronItems, extensionTasks } from '../extensions/jobs';
import { conversionCronItems, conversionTasks } from '../conversions/jobs';
import { billingCronItems, billingTasks } from '../billing/jobs';
import { costCronItems, costTasks } from '../costs/costs.jobs';
import { signupCronItems, signupTasks } from '../signup/signup.jobs';
import { accountDeletionCronItems, accountDeletionTasks } from '../account-deletion/jobs';
import { nameTasks } from '../items/names.service';
import { GEOCODE_SWEEP_TASK, GEOCODE_TASK, runGeocode, sweepGeocodes } from '../geo/geo.service';
import { RETRY_TASK as EXT_RETRY_TASK, retryExtensionCall } from '../extensions/ext-automation';
import { errorCronItems, errorTasks } from '../errors/errors.jobs';
import { capturingTasks } from '../errors/errors.capture';
import { accountClosed } from '../billing/entitlements';
import { licenseCronItems, licenseTasks } from '../license/license-reminders';
import { INBOUND_TASK, processInboundEmail } from '../inbound-email/inbound.service';

const geocodePayload = z.object({
  account_id: z.string().min(1),
  item_id: z.string().min(1),
  column_id: z.string().min(1),
  address: z.string().min(1).max(500),
});

const dispatchPayload = z.object({ event_id: z.string().min(1) }).loose();
const extRetryPayload = z.object({
  ref: z.object({
    account_id: z.string(),
    installation_id: z.string(),
    feature: z.string(),
    run_id: z.string(),
    automation_id: z.string(),
    action_index: z.number().int(),
    user_id: z.string(),
    board_id: z.string(),
    depth: z.number().int(),
    chain: z.array(z.string()),
  }),
  body: z.record(z.string(), z.unknown()),
  attempt: z.number().int().min(2).max(10),
});
const runPayload = z.object({ run_id: z.string().min(1) });

/**
 * The automation jobs run in the api process (D21) so actions use the same services as the routes. This runner
 * knows only `automation.*`; graphile-worker hands each process only the tasks it registered, so the maintenance
 * worker (apps/worker) and this one share the queue without taking each other's jobs.
 */
export const automationTasks = (deps: AppDeps): TaskList => ({
  'automation.dispatch': async (payload) => {
    await dispatchEvent(deps, dispatchPayload.parse(payload).event_id);
  },
  'automation.run': async (payload) => {
    await executeRun(deps, runPayload.parse(payload).run_id);
  },
  // Scenarios (phase 3): a run, and the rest of a path after a wait.
  [SCENARIO_RUN_TASK]: async (payload) => {
    await executeScenarioRun(deps, runPayload.parse(payload).run_id);
  },
  [SCENARIO_RESUME_TASK]: async (payload) => {
    await resumeScenarioRun(
      deps,
      z.object({ run_id: z.string().min(1), token: z.string().min(1), nodes: z.array(z.string()) }).parse(payload),
    );
  },
  // Outgoing webhooks (06 §2.17): one attempt per job; a failure queues the next attempt itself.
  'webhook.deliver': async (payload) => {
    await deliver(deps, z.object({ delivery_id: z.string().min(1) }).parse(payload).delivery_id);
  },
  // Extension automation calls (D27 ת4): attempts 2 and 3, with backoff; each records its outcome in the run.
  [EXT_RETRY_TASK]: async (payload) => {
    const p = extRetryPayload.parse(payload);
    // plan-lock: nothing of a closed account runs (the retry is dropped; the run keeps its last outcome).
    if (await accountClosed(deps.db, p.ref.account_id)) return;
    await retryExtensionCall(deps, p as Parameters<typeof retryExtensionCall>[1]);
  },
  // Log retention (privacy): the owner's periods for the audit log, boards' history and the bell.
  // A personal data breach nearing its 72-hour notice deadline (privacy): the owners are reminded once.
  [INCIDENTS_REMIND_TASK]: async () => {
    const n = await remindIncidents(deps);
    if (n) deps.logger.info({ reminded: n }, INCIDENTS_REMIND_TASK);
  },
  [RETENTION_TASK]: async () => {
    const n = await purgeByRetention(deps.db);
    if (n.audit || n.activity || n.notifications) deps.logger.info(n, 'maintenance.retention');
  },
  'maintenance.idempotency_purge': async () => {
    await purgeIdempotencyKeys(deps.db);
  },
  'automation.schedule_tick': async () => {
    // Several pages in a busy minute; each claims its rows (SKIP LOCKED).
    while ((await tickSchedules(deps.db)) > 0);
    // Runs a dead worker left `running` end as failed (audit 2026-10-10, automations #3).
    for (const r of await failStaleRuns(deps.db, new Date(Date.now() - STALE_RUN_MS)))
      await recordRunOutcome(deps.db, r.automationId, 'error');
  },
  // Incoming email: one message → an update / a new item; provider failures retry.
  [INBOUND_TASK]: async (payload) => {
    await processInboundEmail(deps, z.object({ email_id: z.string().min(1) }).parse(payload).email_id);
  },
  // Location cells → coordinates (M8 ד10): the `geo` queue runs one job at a time (Nominatim: 1 request a second).
  [GEOCODE_TASK]: async (payload) => {
    const p = geocodePayload.parse(payload);
    if (await accountClosed(deps.db, p.account_id)) return;
    await runGeocode(deps, p);
  },
  [GEOCODE_SWEEP_TASK]: async () => {
    await sweepGeocodes(deps.db);
  },
  // Agents (מ6–מ7): runs, resumes after an approval, approval expiry.
  ...agentTasks(deps),
  // AI columns (מ11): queued runs and debounced auto-runs.
  ...ai2Tasks(deps),
  // Scheduled cleaning (M8 ד13): every account's enabled rules, once a day.
  ...tidyTasks(deps),
  // Extensions (ת6): the daily update check.
  ...extensionTasks(deps),
  // Column type conversions (D28): large ones in the background; old backups removed daily.
  ...conversionTasks(deps),
  // Computed item names: a big board's recompute after its name source changed.
  ...nameTasks(deps),
  // External flows: new failures → alerts.
  ...flowTasks(deps),
  // Plans: scheduled status steps → `account.plan_changed` to the account's members.
  ...billingTasks(deps),
  // Platform costs: the daily sync at the owner's hour, "sync now".
  ...costTasks(deps),
  // Self sign-up (D32): expired links and old ended requests, daily.
  ...signupTasks(deps),
  // Account export and deletion: the export build, the purge, the hourly sweep.
  ...accountDeletionTasks(deps),
  // Errors hub: alerts, the daily digest, auto-resolve and retention.
  ...errorTasks(deps),
  // Support agent: an investigation, in the api process (it uses the console's services).
  [SUPPORT_AGENT_TASK]: async (payload) => {
    await executeSupportRun(deps, z.object({ run_id: z.string().min(1) }).parse(payload).run_id);
  },
  [SUPPORT_AGENT_DEVELOP_TASK]: async (payload) => {
    await executeSupportDevelop(deps, z.object({ run_id: z.string().min(1) }).parse(payload).run_id);
  },
  // Phase 3: new errors of the chosen severities, investigated by themselves (when the owner turned it on).
  [SUPPORT_AGENT_AUTO_TASK]: async () => {
    await autoInvestigate(deps);
  },
  // License server: expiry reminders, hourly (nothing where this is not a license server).
  ...licenseTasks(deps),
});

/** Scheduled triggers (04 §5.6): the tick runs every minute. Object form — crontab strings reject dotted names. */
export const automationCronItems: CronItem[] = [
  { task: 'automation.schedule_tick', match: '* * * * *', identifier: 'automation.schedule_tick' },
  { task: 'maintenance.idempotency_purge', match: '20 * * * *', identifier: 'maintenance.idempotency_purge' },
  { task: RETENTION_TASK, match: '50 3 * * *', identifier: RETENTION_TASK },
  { task: INCIDENTS_REMIND_TASK, match: '5 * * * *', identifier: INCIDENTS_REMIND_TASK },
  { task: 'geo.sweep', match: '*/10 * * * *', identifier: 'geo.sweep' },
  ...agentCronItems,
  ...ai2CronItems,
  ...tidyCronItems,
  ...extensionCronItems,
  ...conversionCronItems,
  ...flowCronItems,
  ...billingCronItems,
  ...costCronItems,
  ...signupCronItems,
  ...accountDeletionCronItems,
  ...errorCronItems,
  { task: SUPPORT_AGENT_AUTO_TASK, match: '*/5 * * * *', identifier: SUPPORT_AGENT_AUTO_TASK },
  ...licenseCronItems,
];

/**
 * `database`: a connection string, or a pool (standalone mode: the embedded database's pg-like pool, one process).
 * `extra`: more tasks and schedules for the same runner — standalone mode runs the maintenance worker's here too.
 */
export const startAutomationRunner = async (
  deps: AppDeps,
  database: string | { pgPool: Pool },
  extra: { tasks?: TaskList; cron?: CronItem[]; concurrency?: number } = {},
): Promise<Runner> =>
  run({
    ...(typeof database === 'string' ? { connectionString: database } : { pgPool: database.pgPool }),
    concurrency: extra.concurrency ?? Number(process.env.AUTOMATION_CONCURRENCY ?? 4),
    noHandleSignals: true,
    pollInterval: 1000,
    // A job that fails its last attempt is recorded in the errors hub (source `job`).
    taskList: { ...capturingTasks(deps.db, automationTasks(deps)), ...extra.tasks },
    parsedCronItems: parseCronItems([...automationCronItems, ...(extra.cron ?? [])]),
  });
