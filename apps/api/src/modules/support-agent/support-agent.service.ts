// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, notExists, or, sql } from 'drizzle-orm';
import {
  AppError,
  type ApproveDevelopment,
  type DecideSupportAgentAction,
  newId,
  type StartSupportAgentRun,
  type SupportAgentRun,
  type SupportAgentRunDetail,
  supportAgentReportSchema,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { errorEvents, supportAgentActions, supportAgentRuns, supportAgentSteps, users } from '../../db/schema';
import type { AppDeps, RequestMeta } from '../../types';
import { type HubActor, updateError } from '../errors/errors.service';
import { replyAsStaff } from '../tickets/console.service';
import { findTicket } from '../tickets/tickets.repo';
import { auditRun, developPrompt, phaseStart, queueSupportDevelop, queueSupportRun } from './engine';
import {
  loadSupportAgentSettings,
  mayDevelop,
  supportAgentAiReady,
  supportAgentMonthSpend,
} from './support-agent.settings';
import { openOpsTask, type OpsTaskResult, pickOpsType } from './ops-tasks';
import { ticketOfRun } from './tools';

type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'secrets' | 'aiClient' | 'mailer' | 'storage' | 'auth'>;
type RunRow = typeof supportAgentRuns.$inferSelect;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const namesOf = async (db: Db, ids: (string | null)[]) => {
  const want = [...new Set(ids.filter((x): x is string => !!x))];
  if (!want.length) return new Map<string, string>();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, want));
  return new Map(rows.map((r) => [r.id, r.name]));
};

const runDto = (r: RunRow, names: Map<string, string>): SupportAgentRun => {
  const report = r.report ? supportAgentReportSchema.safeParse(r.report) : null;
  return {
    id: r.id,
    status: r.status as SupportAgentRun['status'],
    trigger: r.trigger,
    error_id: r.errorEventId,
    ticket_id: r.ticketId,
    account_id: r.accountId,
    prompt: r.prompt,
    model: r.model,
    report: report?.success ? report.data : null,
    final_text: r.finalText,
    error: r.error,
    steps: r.steps,
    tool_calls: r.toolCalls,
    cost_usd: Math.round(r.costUsd * 10_000) / 10_000,
    code_ref: r.codeRef,
    requested_by: r.requestedBy ? { id: r.requestedBy, name: names.get(r.requestedBy) ?? '' } : null,
    created_at: r.createdAt.toISOString(),
    started_at: iso(r.startedAt),
    finished_at: iso(r.finishedAt),
    dev_status: (r.devStatus as SupportAgentRun['dev_status']) ?? null,
    dev_approved_by: r.devApprovedBy ? { id: r.devApprovedBy, name: names.get(r.devApprovedBy) ?? '' } : null,
    dev_branch: r.devBranch,
    dev_pr_url: r.devPrUrl,
    dev_error: r.devError,
  };
};

const mustRun = async (db: Db, id: string) => {
  const [r] = await db.select().from(supportAgentRuns).where(eq(supportAgentRuns.id, id)).limit(1);
  if (!r) throw new AppError('not_found', 'support_agent_run_not_found');
  return r;
};

/** GET /platform/support-agent/runs/{id} — the run, its steps (what it read, its reasoning) and its proposals. */
export const supportRunDetail = async (db: Db, id: string): Promise<SupportAgentRunDetail> => {
  const r = await mustRun(db, id);
  const steps = await db
    .select()
    .from(supportAgentSteps)
    .where(eq(supportAgentSteps.runId, id))
    .orderBy(asc(supportAgentSteps.seq));
  const actions = await db
    .select()
    .from(supportAgentActions)
    .where(eq(supportAgentActions.runId, id))
    .orderBy(asc(supportAgentActions.createdAt));
  const names = await namesOf(db, [r.requestedBy, r.devApprovedBy, ...actions.map((a) => a.decidedBy)]);
  const devFrom = phaseStart(steps, 'develop');
  const devSeq = devFrom >= 0 ? steps[devFrom]!.seq : Number.POSITIVE_INFINITY;
  return {
    ...runDto(r, names),
    step_list: steps
      .filter((s) => s.kind !== 'prompt')
      .map((s) => ({
        seq: s.seq,
        phase: s.seq > devSeq ? ('develop' as const) : ('investigate' as const),
        kind: s.kind as 'prompt' | 'model' | 'tool',
        tool: s.tool,
        input: s.kind === 'tool' ? (s.input ?? null) : null,
        is_error: s.isError,
        text: s.kind === 'model' ? ((s.output as { text?: string | null } | null)?.text ?? null) : null,
        created_at: s.createdAt.toISOString(),
      })),
    actions: actions.map((a) => ({
      id: a.id,
      kind: a.kind as SupportAgentRunDetail['actions'][number]['kind'],
      payload: a.payload,
      status: a.status as 'pending' | 'approved' | 'rejected',
      decided_by: a.decidedBy ? { id: a.decidedBy, name: names.get(a.decidedBy) ?? '' } : null,
      decided_at: iso(a.decidedAt),
      created_at: a.createdAt.toISOString(),
    })),
  };
};

/** GET /platform/support-agent/runs?error_id|ticket_id — the investigations of an error / a ticket, newest first. */
export const listSupportRuns = async (db: Db, f: { error_id?: string; ticket_id?: string }) => {
  const rows = await db
    .select()
    .from(supportAgentRuns)
    .where(
      and(
        f.error_id ? eq(supportAgentRuns.errorEventId, f.error_id) : undefined,
        f.ticket_id ? eq(supportAgentRuns.ticketId, f.ticket_id) : undefined,
      ),
    )
    .orderBy(desc(supportAgentRuns.createdAt))
    .limit(20);
  const names = await namesOf(
    db,
    rows.flatMap((r) => [r.requestedBy, r.devApprovedBy]),
  );
  return { data: rows.map((r) => runDto(r, names)) };
};

/** POST /platform/support-agent/runs — any support console person; refused while off, unset or over the month's cap. */
export const startSupportRun = async (
  deps: Deps,
  s: HubActor,
  input: StartSupportAgentRun,
  trigger: 'manual' | 'auto' = 'manual',
) => {
  const settings = await loadSupportAgentSettings(deps.db);
  if (!settings.enabled) throw new AppError('conflict', 'support_agent_disabled');
  if (!(await supportAgentAiReady(deps.db, settings))) throw new AppError('conflict', 'support_agent_no_ai');
  if ((await supportAgentMonthSpend(deps.db)) >= settings.max_usd_per_month)
    throw new AppError('conflict', 'support_agent_month_cap');
  let accountId: string | null = null;
  let errorId: string | null = null;
  let ticketId: string | null = null;
  if (input.error_id) {
    const [e] = await deps.db
      .select({ id: errorEvents.id, accountId: errorEvents.accountId, ticketId: errorEvents.ticketId })
      .from(errorEvents)
      .where(eq(errorEvents.id, input.error_id))
      .limit(1);
    if (!e) throw new AppError('not_found', 'error_not_found');
    errorId = e.id;
    accountId = e.accountId;
  }
  if (input.ticket_id) {
    const t = await findTicket(deps.db, input.ticket_id);
    if (!t) throw new AppError('not_found', 'ticket_not_found');
    ticketId = t.id;
    accountId = accountId ?? t.accountId;
    // A ticket opened from an error: investigate both.
    const fromError = (t.context as { error_event_id?: string } | null)?.error_event_id;
    if (!errorId && fromError) errorId = fromError;
  }
  // One investigation at a time per error / ticket.
  const running = await deps.db
    .select({ id: supportAgentRuns.id })
    .from(supportAgentRuns)
    .where(
      and(
        inArray(supportAgentRuns.status, ['queued', 'running']),
        errorId ? eq(supportAgentRuns.errorEventId, errorId) : eq(supportAgentRuns.ticketId, ticketId!),
      ),
    )
    .limit(1);
  if (running.length) throw new AppError('conflict', 'support_agent_already_running');
  const id = newId();
  await deps.db.insert(supportAgentRuns).values({
    id,
    errorEventId: errorId,
    ticketId,
    accountId,
    prompt: input.prompt ?? '',
    codeRef: deps.env.RAILWAY_GIT_COMMIT_SHA ?? null,
    requestedBy: s.user.id,
    trigger,
  });
  await auditRun(deps.db, id, s.user.id, 'run_started', { error_id: errorId, ticket_id: ticketId, trigger });
  await queueSupportRun(deps, id);
  return supportRunDetail(deps.db, id);
};

/** POST /platform/support-agent/runs/{id}/stop — the run stops before its next model call. */
export const stopSupportRun = async (db: Db, s: HubActor, id: string) => {
  const r = await mustRun(db, id);
  if (r.status === 'queued' || r.status === 'running') {
    await db
      .update(supportAgentRuns)
      .set({ status: 'stopped', error: 'stopped_by_person', finishedAt: new Date() })
      .where(eq(supportAgentRuns.id, id));
    await auditRun(db, id, s.user.id, 'run_stopped');
  }
  return supportRunDetail(db, id);
};

/**
 * POST /platform/support-agent/actions/{id} — a person approves or rejects a proposal. Approving runs it as that
 * person, through the same services as the console's buttons (resolve / mute the error, a public ticket reply —
 * the reply as the person edited it).
 */
export const decideSupportAction = async (
  deps: Deps,
  s: HubActor,
  id: string,
  input: DecideSupportAgentAction,
  meta: RequestMeta,
) => {
  const [a] = await deps.db.select().from(supportAgentActions).where(eq(supportAgentActions.id, id)).limit(1);
  if (!a) throw new AppError('not_found', 'support_agent_action_not_found');
  if (a.status !== 'pending') throw new AppError('conflict', 'support_agent_action_decided');
  const run = await mustRun(deps.db, a.runId);
  let task: OpsTaskResult | null = null;
  if (input.approve) {
    const p = a.payload as { reason?: string; mute_hours?: number; body?: string; title?: string; ops_type?: string };
    if (a.kind === 'resolve_error' && run.errorEventId)
      await updateError(deps, s, run.errorEventId, { status: 'resolved' });
    else if (a.kind === 'mute_error' && run.errorEventId)
      await updateError(deps, s, run.errorEventId, {
        muted_until: new Date(Date.now() + (p.mute_hours ?? 24) * 3_600_000).toISOString(),
      });
    else if (a.kind === 'reply_to_customer') {
      const ticketId = await ticketOfRun(deps.db, run);
      if (!ticketId) throw new AppError('invalid_value', 'no_ticket_in_this_run');
      await replyAsStaff(deps, s, ticketId, { body: input.body ?? p.body ?? '', visibility: 'public' }, meta);
    } else if (a.kind === 'open_ops_task') {
      // The type as the person chose it (else the agent's), as it is in the settings now.
      const type = pickOpsType((await loadSupportAgentSettings(deps.db)).ops_tasks, input.ops_type ?? p.ops_type);
      if (!type) throw new AppError('invalid_value', 'no_ops_task_types');
      task = await openOpsTask(
        deps,
        s.user,
        run,
        type,
        { title: input.title ?? p.title ?? '', body: input.body ?? p.body ?? '', reason: p.reason ?? '' },
        s.user.locale === 'en' ? 'en' : 'he',
      );
    } else throw new AppError('invalid_value', 'support_agent_action_unsupported');
  }
  // Only a pending row changes (two people deciding at once: the second gets a conflict above or nothing here).
  await deps.db
    .update(supportAgentActions)
    .set({
      status: input.approve ? 'approved' : 'rejected',
      decidedBy: s.user.id,
      decidedAt: new Date(),
      ...(input.approve && input.body && a.kind === 'reply_to_customer'
        ? { payload: { ...a.payload, sent_body: input.body } }
        : {}),
      ...(task ? { payload: { ...a.payload, task } } : {}),
    })
    .where(and(eq(supportAgentActions.id, id), eq(supportAgentActions.status, 'pending')));
  await auditRun(deps.db, run.id, s.user.id, input.approve ? 'action_approved' : 'action_rejected', {
    action_id: id,
    kind: a.kind,
    ...(task ? { item_id: task.item_id, account_id: task.account_id } : {}),
  });
  return supportRunDetail(deps.db, run.id);
};

/**
 * POST /platform/support-agent/runs/{id}/develop — "approve development": the owner, or a role the settings name,
 * sends the agent to implement the report's fix on its own `agent/…` branch and open a DRAFT pull request. Only a
 * finished investigation with a report; again after a failed attempt (a new conversation, same branch).
 */
export const approveDevelopment = async (deps: Deps, s: HubActor, id: string, input: ApproveDevelopment) => {
  const settings = await loadSupportAgentSettings(deps.db);
  if (!settings.enabled) throw new AppError('conflict', 'support_agent_disabled');
  if (!mayDevelop(s.role, settings)) throw new AppError('forbidden', 'support_agent_develop_not_allowed');
  const r = await mustRun(deps.db, id);
  if (r.status !== 'succeeded' || !r.report) throw new AppError('conflict', 'support_agent_no_report');
  if (r.devStatus && r.devStatus !== 'failed') throw new AppError('conflict', 'support_agent_develop_started');
  if ((await supportAgentMonthSpend(deps.db)) >= settings.max_usd_per_month)
    throw new AppError('conflict', 'support_agent_month_cap');
  const [last] = await deps.db
    .select({ seq: supportAgentSteps.seq })
    .from(supportAgentSteps)
    .where(eq(supportAgentSteps.runId, id))
    .orderBy(desc(supportAgentSteps.seq))
    .limit(1);
  await deps.db.insert(supportAgentSteps).values({
    id: newId(),
    runId: id,
    seq: (last?.seq ?? -1) + 1,
    kind: 'prompt',
    output: { phase: 'develop' },
    content: [{ type: 'text', text: developPrompt(r.report, input.instructions ?? '') }],
  });
  const [claimed] = await deps.db
    .update(supportAgentRuns)
    .set({ devStatus: 'approved', devApprovedBy: s.user.id, devApprovedAt: new Date(), devError: null })
    .where(eq(supportAgentRuns.id, id))
    .returning();
  await auditRun(deps.db, id, s.user.id, 'development_approved', { instructions: !!input.instructions });
  await queueSupportDevelop(deps, claimed!.id);
  return supportRunDetail(deps.db, id);
};

export const SUPPORT_AGENT_AUTO_TASK = 'support_agent.auto';

/**
 * `support_agent.auto` (every 5 minutes; phase 3): when the owner turned auto-investigation on, each
 * new error of the chosen severities (seen in the last day, still `new`, not muted, never investigated) gets an
 * investigation — as the person who turned it on, at most `max_per_day` a day. Off = nothing.
 */
export const autoInvestigate = async (deps: Deps, now = new Date()) => {
  const settings = await loadSupportAgentSettings(deps.db);
  const auto = settings.auto;
  if (!settings.enabled || !auto.enabled || !auto.run_as) return 0;
  const [user] = await deps.db.select().from(users).where(eq(users.id, auto.run_as)).limit(1);
  if (!user) return 0;
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const [{ n } = { n: 0 }] = await deps.db
    .select({ n: count() })
    .from(supportAgentRuns)
    .where(and(eq(supportAgentRuns.trigger, 'auto'), gte(supportAgentRuns.createdAt, dayStart)));
  const room = auto.max_per_day - Number(n);
  if (room <= 0) return 0;
  const fresh = await deps.db
    .select({ id: errorEvents.id })
    .from(errorEvents)
    .where(
      and(
        inArray(errorEvents.severity, auto.severities),
        eq(errorEvents.status, 'new'),
        gte(errorEvents.firstSeenAt, new Date(now.getTime() - 24 * 3_600_000)),
        or(isNull(errorEvents.mutedUntil), lt(errorEvents.mutedUntil, now)),
        notExists(
          deps.db
            .select({ x: sql`1` })
            .from(supportAgentRuns)
            .where(eq(supportAgentRuns.errorEventId, errorEvents.id)),
        ),
      ),
    )
    .orderBy(desc(errorEvents.firstSeenAt))
    .limit(room);
  const actor: HubActor = {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: user.emailVerified,
      isPlatformOwner: user.isPlatformOwner,
      locale: user.locale,
      timezone: user.timezone,
    },
    role: user.isPlatformOwner ? 'owner' : 'lead',
  };
  let started = 0;
  for (const e of fresh) {
    try {
      const run = await startSupportRun(deps, actor, { error_id: e.id }, 'auto');
      if (run) started += 1;
    } catch (err) {
      // Off, no AI, the month's cap, already running: the next tick tries again (or nothing to do).
      deps.logger.warn({ err, errorId: e.id }, 'support agent auto-investigation not started');
      if (err instanceof AppError && err.message !== 'support_agent_already_running') break;
    }
  }
  return started;
};
