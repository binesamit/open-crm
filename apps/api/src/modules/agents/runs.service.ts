// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  type AgentApproval,
  type AgentLimits,
  agentLimitsSchema,
  type AgentRun,
  type AgentRunDetail,
  type AgentRunStep,
  type AgentRunTrigger,
  AppError,
  type DecideApproval,
  newId,
  type StartAgentRun,
  startAgentRunSchema,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { aiStatusError, entitlements, hasFeature, planAiBudgetUsedUp } from '../billing/entitlements';
import { activityLog, notifications } from '../../db/schema';
import type { AppDeps } from '../../types';
import { undoBatch } from '../activity/undo.service';
import { loadAiSettings } from '../ai/ai.service';
import { describeCache, describeToolCall } from '../ai/tools/describe';
import { getItem, type Actor } from '../items/items.service';
import {
  type AgentApprovalRow,
  type AgentRow,
  type AgentRunRow,
  decideApprovalRow,
  findAgent,
  findApproval,
  findRun,
  insertRun,
  insertStep,
  listApprovalRows,
  listAgentRows,
  listRunRows,
  listSteps,
  runApprovals,
  runsSince,
  updateRunRow,
} from './agents.repo';
import { loadManagedAgent, mayManageAgent } from './agents.service';
import { agentActor } from './engine/context';
import { expireApprovals, monthSpend, queueRun } from './engine/loop';
import { firstMessage, wrapUntrusted } from './engine/prompt';

/**
 * Agent runs (מ6–מ7): "run now" with a prompt, history and transcript ("what the agent did"), approvals (inbox,
 * bell, run page), cancel, and undo the whole run (its writes share one batch = the run id). Visible to the agent's
 * managers only (its creator and admins, plan §8 "נראה ליוצר הסוכן ולמנהלים").
 */
type Deps = AppDeps;

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null;

const changesOf = async (db: Db, accountId: string, runIds: string[]) => {
  if (!runIds.length) return new Map<string, number>();
  const rows = await db
    .select({ batchId: activityLog.batchId, n: count() })
    .from(activityLog)
    .where(
      and(eq(activityLog.accountId, accountId), inArray(activityLog.batchId, runIds), isNull(activityLog.undoneAt)),
    )
    .groupBy(activityLog.batchId);
  return new Map(rows.map((r) => [r.batchId!, Number(r.n)]));
};

const runDto = (
  r: AgentRunRow,
  extra: { agentName: string | null; requestedByName: string | null; changes: number },
): AgentRun => ({
  id: r.id,
  agent_id: r.agentId,
  agent_name: extra.agentName,
  trigger: r.trigger,
  prompt: r.prompt,
  item_id: r.itemId,
  dry_run: r.dryRun,
  status: r.status as AgentRun['status'],
  skip_reason: r.skipReason,
  error: r.error,
  final_text: r.finalText,
  model: r.model,
  steps: r.steps,
  tool_calls: r.toolCalls,
  input_tokens: Number(r.inputTokens),
  output_tokens: Number(r.outputTokens),
  cache_read_tokens: Number(r.cacheReadTokens),
  cost_usd: Math.round(r.costUsd * 1_000_000) / 1_000_000,
  requested_by: r.requestedBy,
  requested_by_name: extra.requestedByName,
  created_at: r.createdAt.toISOString(),
  started_at: iso(r.startedAt),
  finished_at: iso(r.finishedAt),
  undone_at: iso(r.undoneAt),
  changes: extra.changes,
});

const approvalDto = (
  p: AgentApprovalRow,
  extra: { agentName: string | null; decidedByName: string | null },
): AgentApproval => ({
  id: p.id,
  agent_id: p.agentId,
  agent_name: extra.agentName,
  run_id: p.runId,
  tool: p.tool,
  input: p.input ?? null,
  preview: p.preview,
  status: p.status as AgentApproval['status'],
  reason: p.reason,
  decided_by_name: extra.decidedByName,
  decided_at: iso(p.decidedAt),
  expires_at: p.expiresAt.toISOString(),
  created_at: p.createdAt.toISOString(),
});

/** The agents whose runs and approvals I may see (admins: all; a member: the ones they manage). */
const managedAgentIds = async (db: Db, a: Actor) => {
  if (a.ctx.role === 'admin') return undefined;
  const mine = await listAgentRows(db, a.ctx.accountId, a.user.id);
  const out: string[] = [];
  for (const r of mine) if (await mayManageAgent(db, a, r.a)) out.push(r.a.id);
  return out;
};

const loadManagedRun = async (db: Db, a: Actor, runId: string) => {
  const run = await findRun(db, a.ctx.accountId, runId);
  if (!run) throw new AppError('not_found', 'Run not found');
  const found = await findAgent(db, a.ctx.accountId, run.agentId);
  if (!found || !(await mayManageAgent(db, a, found.a))) throw new AppError('not_found', 'Run not found');
  return { run, agent: found.a };
};

const dayStartUtc = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

/** Runs of one agent are counted and inserted one at a time (AI-RT12). */
const lockAgentRuns = (tx: Db, agentId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`agent-runs:${agentId}`}))`);

/**
 * Why a run of `agent` may not start now (null = it may): runs a day for the agent, the account's monthly budget
 * and the plan's, the plan's `ai` feature, the plan status. Under `lockAgentRuns`.
 */
const runSkipReason = async (
  tx: Db,
  agent: AgentRow,
  o: { ai: Awaited<ReturnType<typeof loadAiSettings>>; limits: AgentLimits; now: Date; dryRun: boolean },
): Promise<string | null> => {
  const { ai, limits, now, dryRun } = o;
  let reason: string | null = null;
  if (!dryRun && (await runsSince(tx, agent.id, dayStartUtc(now))) >= limits.max_runs_per_day)
    reason = 'quota_runs_per_day';
  else if (ai.monthly_budget_usd !== null && (await monthSpend(tx, agent.accountId, now)) >= ai.monthly_budget_usd)
    reason = 'quota_budget';
  // Plans: the plan's monthly AI budget, on top of the account's own.
  else if (!dryRun && (await planAiBudgetUsedUp(tx, agent.accountId, now))) reason = 'quota_budget';
  // Plans: agents are the plan's `ai` — a scheduled / triggered run is skipped, the agent kept.
  if (!reason && !(await hasFeature(tx, agent.accountId, 'ai'))) reason = 'plan_feature_unavailable';
  // plan-lock: no AI at all in a read-only / suspended / closed account — the run is recorded as skipped.
  if (!reason) reason = aiStatusError((await entitlements(tx, agent.accountId)).status)?.code ?? null;
  return reason;
};

/**
 * One message of a chat with `agent` in the AI panel: recorded as a `chat` run, running now (the
 * panel drives it, not the job queue), within the same quotas as every run — over one, nothing is recorded and the
 * reason is the error. `boardScope`: the agent's boards the person can see; the run reads only those.
 */
export const openChatRun = async (
  deps: Pick<Deps, 'db'>,
  agent: AgentRow,
  o: { requestedBy: string; prompt: string; conversationId: string; boardScope: string[] },
) => {
  const ai = await loadAiSettings(deps.db, agent.accountId);
  const limits = agentLimitsSchema.parse(agent.limits ?? {});
  const now = new Date();
  const id = newId();
  await deps.db.transaction(async (tx) => {
    await lockAgentRuns(tx, agent.id);
    const reason = await runSkipReason(tx, agent, { ai, limits, now, dryRun: false });
    if (reason) throw new AppError(reason.startsWith('quota_') ? 'rate_limited' : 'forbidden', reason);
    await insertRun(tx, {
      id,
      accountId: agent.accountId,
      agentId: agent.id,
      trigger: 'chat',
      prompt: o.prompt,
      itemId: null,
      dryRun: false,
      status: 'running',
      model: agent.model,
      requestedBy: o.requestedBy,
      // The person is not the agent's manager: like a guest's mention (S-66) the run reads only `board_scope`, and
      // every change waits for the person (learner).
      meta: { conversation_id: o.conversationId, untrusted_requester: true, board_scope: o.boardScope },
      startedAt: now,
    });
  });
  return { id, limits };
};

/** The chat message is answered: the run ends with its cost, steps and the answer (or the error). */
export const closeChatRun = (
  deps: Pick<Deps, 'db'>,
  runId: string,
  o: { steps: number; costUsd: number; text: string; error: string | null },
) =>
  updateRunRow(deps.db, runId, {
    status: o.error ? 'failed' : 'succeeded',
    steps: o.steps,
    costUsd: o.costUsd,
    finalText: o.text || null,
    error: o.error,
    finishedAt: new Date(),
  });

/**
 * Records and queues one run of `agent` — the single entry point for every trigger: "run now" today, and the
 * automation action / mention / assignment / schedule of stage מ8 (they pass their `trigger`, the `untrusted`
 * text that started them — wrapped as data, never as the task — and `meta` such as the event and chain depth).
 * Quotas are checked before anything is spent: runs a day for the agent and the account's monthly budget — over
 * either, the run is recorded as `skipped` with the reason.
 */
export const createAgentRun = async (
  deps: Deps,
  agent: AgentRow,
  opts: {
    trigger: AgentRunTrigger;
    prompt: string;
    item: { id: string; name: string; board_id: string } | null;
    requestedBy: string | null;
    dryRun?: boolean;
    untrusted?: { source: string; text: string } | null;
    meta?: Record<string, unknown>;
    /** Recorded as skipped with this reason, never run (a trigger chain past its depth). */
    skip?: string | null;
  },
) => {
  const ai = await loadAiSettings(deps.db, agent.accountId);
  const limits = agentLimitsSchema.parse(agent.limits ?? {});
  const now = new Date();
  const id = newId();
  // Count and insert under a per-agent lock (AI-RT12): runs started at the same moment (a burst of mentions, a
  // bulk change firing an automation) cannot all pass the day's quota check before any of them is recorded.
  const skip = await deps.db.transaction(async (tx) => {
    await lockAgentRuns(tx, agent.id);
    const reason = opts.skip ?? (await runSkipReason(tx, agent, { ai, limits, now, dryRun: !!opts.dryRun }));
    await insertRun(tx, {
      id,
      accountId: agent.accountId,
      agentId: agent.id,
      trigger: opts.trigger,
      prompt: opts.prompt,
      itemId: opts.item?.id ?? null,
      dryRun: !!opts.dryRun,
      status: reason ? 'skipped' : 'queued',
      skipReason: reason,
      model: agent.model,
      requestedBy: opts.requestedBy,
      meta: opts.meta ?? {},
      finishedAt: reason ? now : null,
    });
    return reason;
  });
  if (!skip) {
    const text = [
      firstMessage(opts.prompt, opts.item),
      opts.untrusted ? wrapUntrusted(opts.untrusted.source, opts.untrusted.text) : null,
    ]
      .filter((x) => x !== null)
      .join('\n');
    await insertStep(deps.db, {
      id: newId(),
      accountId: agent.accountId,
      runId: id,
      seq: 1,
      kind: 'prompt',
      content: [{ type: 'text', text }],
    });
    await queueRun(deps, id);
  }
  return id;
};

/** POST /agents/:id/runs — "run now" with a prompt (optionally about an item I can see, optionally a dry run). */
export const startRun = async (deps: Deps, a: Actor, agentId: string, raw: StartAgentRun) => {
  const input = startAgentRunSchema.parse(raw);
  const found = await loadManagedAgent(deps.db, a, agentId);
  const agent = found.a;
  if (!agent.isActive) throw new AppError('conflict', 'agent_inactive');
  const ai = await loadAiSettings(deps.db, a.ctx.accountId);
  if (!ai.enabled) throw new AppError('forbidden', 'ai_disabled');
  if (!agent.connectionId || !found.connectionName) throw new AppError('invalid_value', 'no_ai_connection');
  // The item must be one the person starting the run can see (its name goes to the model).
  const item = input.item_id ? await getItem(deps.db, a, input.item_id) : null;
  const id = await createAgentRun(deps, agent, {
    trigger: 'manual',
    prompt: input.prompt,
    item: item ? { id: item.id, name: item.name, board_id: item.board_id } : null,
    requestedBy: a.user.id,
    dryRun: input.dry_run,
  });
  return (await getRun(deps, a, id)).run;
};

export const listRuns = async (
  deps: Deps,
  a: Actor,
  q: { agent_id?: string; status?: string; before?: string; limit?: number },
) => {
  if (q.agent_id) await loadManagedAgent(deps.db, a, q.agent_id);
  const agentIds = q.agent_id ? undefined : await managedAgentIds(deps.db, a);
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 100);
  const rows = await listRunRows(deps.db, a.ctx.accountId, {
    agentId: q.agent_id,
    agentIds,
    status: q.status,
    before: q.before,
    limit: limit + 1,
  });
  const page = rows.slice(0, limit);
  const changes = await changesOf(
    deps.db,
    a.ctx.accountId,
    page.map((r) => r.r.id),
  );
  return {
    data: page.map((r) =>
      runDto(r.r, { agentName: r.agentName, requestedByName: r.requestedByName, changes: changes.get(r.r.id) ?? 0 }),
    ),
    next_cursor: rows.length > limit ? page[page.length - 1]!.r.id : null,
  };
};

const stepDto = (s: Awaited<ReturnType<typeof listSteps>>[number]): AgentRunStep => {
  const blocks = (Array.isArray(s.content) ? s.content : []) as { type: string; text?: string }[];
  const text =
    s.kind === 'prompt' || s.kind === 'model'
      ? blocks.flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join('\n') || null
      : null;
  return {
    seq: s.seq,
    kind: s.kind as AgentRunStep['kind'],
    text,
    tool: s.tool,
    input: s.input ?? null,
    output: s.kind === 'tool' ? (s.output ?? null) : null,
    is_error: s.isError,
    outcome: s.outcome,
    cost_usd: s.costUsd,
    created_at: s.createdAt.toISOString(),
  };
};

/**
 * Tool steps and approvals in words for the reader (sync-ai): names resolved with *their* access, lookups shared
 * across the list. A failure leaves the JSON fallback (description null), never the page.
 */
const describeAll = async <T extends { tool: string | null; input: unknown }>(db: Db, a: Actor, rows: T[]) => {
  const cache = describeCache();
  const out: (T & { description: AgentApproval['description'] })[] = [];
  for (const r of rows)
    out.push({
      ...r,
      description: r.tool ? await describeToolCall(db, a, r.tool, r.input, cache).catch(() => null) : null,
    });
  return out;
};

/** GET /agents/runs/:id — the run, every step ("what the agent did") and its approvals. */
export const getRun = async (deps: Deps, a: Actor, runId: string): Promise<AgentRunDetail> => {
  const { run, agent } = await loadManagedRun(deps.db, a, runId);
  const [steps, approvals, changes] = await Promise.all([
    listSteps(deps.db, run.id),
    runApprovals(deps.db, run.id),
    changesOf(deps.db, a.ctx.accountId, [run.id]),
  ]);
  const requester = run.requestedBy
    ? await deps.db.query.users.findFirst({ where: (u, { eq: e }) => e(u.id, run.requestedBy!) })
    : null;
  return {
    run: runDto(run, {
      agentName: agent.name,
      requestedByName: requester?.name ?? null,
      changes: changes.get(run.id) ?? 0,
    }),
    // Only tool steps carry a tool; prompt / model steps get no description.
    steps: await describeAll(deps.db, a, steps.map(stepDto)),
    approvals: await describeAll(
      deps.db,
      a,
      approvals.map((r) => approvalDto(r.p, { agentName: agent.name, decidedByName: r.decidedByName })),
    ),
  };
};

/** POST /agents/runs/:id/cancel — stops a queued / waiting / running run; pending approvals expire with it. */
export const cancelRun = async (deps: Deps, a: Actor, runId: string) => {
  const { run } = await loadManagedRun(deps.db, a, runId);
  if (!['queued', 'running', 'waiting_approval'].includes(run.status)) throw new AppError('conflict', 'run_not_active');
  await updateRunRow(deps.db, run.id, { status: 'cancelled', error: 'cancelled', finishedAt: new Date() });
  for (const r of await runApprovals(deps.db, run.id))
    if (r.p.status === 'pending')
      await decideApprovalRow(deps.db, r.p.id, { status: 'rejected', decidedBy: a.user.id, reason: 'cancelled' });
  return (await getRun(deps, a, run.id)).run;
};

/**
 * POST /agents/runs/:id/undo — every change of the run is one batch (the 0028 trigger), so this is the batch undo
 * of the activity log, with its `changed_since` guard (`force` to undo anyway). An admin undoes as themselves; the
 * agent's (non-admin) creator undoes through the agent.
 */
export const undoRun = async (deps: Deps, a: Actor, runId: string, force = false) => {
  const { run, agent } = await loadManagedRun(deps.db, a, runId);
  if (['queued', 'running'].includes(run.status)) throw new AppError('conflict', 'run_active');
  const by = a.ctx.role === 'admin' ? a : await agentActor(deps.db, agent, run.id);
  let undone: unknown;
  try {
    undone = (await undoBatch(deps.db, by, run.id, force)).undone;
  } catch (err) {
    if (err instanceof AppError && err.code === 'not_found') throw new AppError('conflict', 'nothing_to_undo');
    throw err;
  }
  await updateRunRow(deps.db, run.id, { undoneAt: new Date() });
  return { ok: true as const, undone: Array.isArray(undone) ? undone.length : Number(undone ?? 0) };
};

// ---- approvals ----

export const listApprovals = async (deps: Deps, a: Actor, q: { status?: string; limit?: number }) => {
  if (a.ctx.role === 'guest' || a.ctx.role === 'viewer') return { data: [] };
  const agentIds = await managedAgentIds(deps.db, a);
  const rows = await listApprovalRows(deps.db, a.ctx.accountId, {
    status: q.status,
    agentIds,
    limit: Math.min(Math.max(q.limit ?? 100, 1), 200),
  });
  return {
    data: await describeAll(
      deps.db,
      a,
      rows.map((r) => approvalDto(r.p, { agentName: r.agentName, decidedByName: r.decidedByName })),
    ),
  };
};

/**
 * POST /agents/approvals/:id — approve or reject (from the bell, the inbox or the run page). Once only; the run
 * resumes from its saved step (`agent.resume`): approved → the tool runs, rejected → the model is told who rejected
 * it and why. The approval's notifications are marked read for everyone.
 */
export const decideApproval = async (deps: Deps, a: Actor, approvalId: string, input: DecideApproval) => {
  const p = await findApproval(deps.db, a.ctx.accountId, approvalId);
  if (!p) throw new AppError('not_found', 'Approval not found');
  const found = await findAgent(deps.db, a.ctx.accountId, p.agentId);
  if (!found || !(await mayManageAgent(deps.db, a, found.a))) throw new AppError('not_found', 'Approval not found');
  // Past its time it can no longer be approved, even before the hourly job marks it (AI-RT5).
  if (input.decision === 'approve' && p.status === 'pending' && p.expiresAt.getTime() <= Date.now()) {
    await expireApprovals(deps);
    throw new AppError('conflict', 'approval_expired');
  }
  const row = await decideApprovalRow(deps.db, p.id, {
    status: input.decision === 'approve' ? 'approved' : 'rejected',
    decidedBy: a.user.id,
    reason: input.reason ?? null,
  });
  if (!row) throw new AppError('conflict', 'already_decided');
  await deps.db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.accountId, a.ctx.accountId),
        eq(notifications.type, 'agent_approval'),
        isNull(notifications.readAt),
        sql`${notifications.payload} -> 'agent' ->> 'approval_id' = ${p.id}`,
      ),
    );
  const run = await findRun(deps.db, a.ctx.accountId, p.runId);
  if (run?.status === 'waiting_approval') {
    await updateRunRow(deps.db, run.id, { status: 'queued' });
    await queueRun(deps, run.id, 'agent.resume');
  }
  return approvalDto(row, { agentName: found.a.name, decidedByName: a.user.name });
};
