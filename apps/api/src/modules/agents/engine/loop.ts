// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import { and, eq, gte } from 'drizzle-orm';
import {
  AGENT_APPROVAL_TTL_HOURS,
  agentLimitsSchema,
  type AiToolDef,
  aiTool,
  AppError,
  MAX_TOOL_RESULT_BYTES,
  needsApproval,
  newId,
  SEARCH_KNOWLEDGE,
  readWebPage,
  searchKnowledge,
  WEB_TOOL_NAMES,
  webSearch,
  plainDescription,
} from '@bines/shared';
import { safeAiError } from '@bines/server-ai';
import type { Db } from '../../../db/client';
import { accountMembers, boards, items, notifications } from '../../../db/schema';
import { enqueueJob } from '../../../lib/jobs';
import type { AppDeps } from '../../../types';
import { usageBetween } from '../../ai/ai.repo';
import { completeWith, loadAiSettings } from '../../ai/ai.service';
import { describeToolCall } from '../../ai/tools/describe';
import { previewFlowCall } from '../../flows/flows.ai';
import { guardToolCall, ToolGuardError } from '../../ai/tools/guard';
import { callTool } from '../../ai/tools/risk';
import { TOOL_RUNNERS } from '../../ai/tools/runners';
import type { Actor } from '../../items/items.service';
import { notifyUsers } from '../../notifications/notify';
import { replyToUpdate } from '../../updates/updates.service';
import { hasKnowledge, searchKnowledgeFor } from '../knowledge.service';
import { runWebTool, webSearchService } from '../../web-search/web-search.service';
import {
  type AgentRow,
  type AgentRunRow,
  type AgentStepRow,
  bumpToolCalls,
  claimRun,
  decideApprovalRow,
  dueApprovals,
  findAgent,
  findRunById,
  insertApproval,
  insertStep,
  listSteps,
  runApprovals,
  updateRunRow,
} from '../agents.repo';
import { agentActor, inAgentScope } from './context';
import { agentTools, approvalPreview, systemBlocks, toolParams } from './prompt';
import {
  agentMcpToolDefs,
  isMcpAgentTool,
  type McpAgentToolDef,
  runAgentMcpTool,
} from '../../mcp-servers/mcp-servers.service';
import { recordAgentRun } from '../../errors/errors.sources';

/**
 * The agent run loop (plan §5): a hand-written tool-use loop — not the SDK's tool runner — because a run must stop
 * for hours while a person approves a step and continue in another job (`agent.resume`). Every step is persisted
 * (agent_run_steps) before the next one, so the transcript is rebuilt from the database on every (re)start and
 * sent back exactly as the model wrote it (preserved thinking: append-only, never edited).
 *
 * Limits are code, not prompt: tools outside the agent's list are refused, its boards are the actor's board
 * limit, approvals stop the run, and steps / dollars per run / the account budget end it.
 */
type Deps = AppDeps;

/** Wall-clock time one job may keep a run running (plan §5 step 7). */
export const RUN_TIMEOUT_MS = 10 * 60_000;
/** Tool failures in a row that end a run. */
const MAX_TOOL_ERRORS = 3;
/**
 * Tool calls one model turn may make (AI-RT3): the rest are answered with an error and never run — a turn of
 * hundreds of writes is a runaway (or a hijacked) model, not a plan. Every call still gets its tool_result.
 */
export const MAX_TOOL_USES_PER_TURN = 20;

/** Key-order-insensitive JSON equality: an approval covers exactly the input a person saw. */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
const sameJson = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

type Decision = { status: string; reason: string | null; decidedByName: string | null; tool: string; input: unknown };

type ToolUse = { id: string; name: string; input: unknown };
const toolUsesOf = (content: unknown): ToolUse[] =>
  ((content as Anthropic.ContentBlock[] | null) ?? []).flatMap((b) =>
    b.type === 'tool_use' ? [{ id: b.id, name: b.name, input: b.input }] : [],
  );

/** The conversation from the stored steps: prompt → (assistant, user[tool_result…])*. */
export const messagesOf = (steps: AgentStepRow[]): Anthropic.MessageParam[] => {
  const out: Anthropic.MessageParam[] = [];
  for (const s of steps) {
    if (s.kind === 'prompt') out.push({ role: 'user', content: s.content as Anthropic.ContentBlockParam[] });
    else if (s.kind === 'model') out.push({ role: 'assistant', content: s.content as Anthropic.ContentBlockParam[] });
    else if (s.kind === 'tool') {
      const last = out[out.length - 1];
      const block = s.content as Anthropic.ToolResultBlockParam;
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result'))
        (last.content as Anthropic.ToolResultBlockParam[]).push(block);
      else out.push({ role: 'user', content: [block] });
    }
  }
  return out;
};

const finish = (db: Db, run: AgentRunRow, patch: Partial<AgentRunRow>) =>
  updateRunRow(db, run.id, { finishedAt: new Date(), ...patch });

// ---- notifications ----

/** Who hears about an agent's run: its creator and whoever started the run; admins when neither is around. */
const runAudience = async (db: Db, agent: AgentRow, run: AgentRunRow) => {
  const members = await db
    .select({ userId: accountMembers.userId, role: accountMembers.role })
    .from(accountMembers)
    .where(and(eq(accountMembers.accountId, agent.accountId), eq(accountMembers.status, 'active')));
  const active = new Set(members.map((m) => m.userId));
  const want = [agent.createdBy, run.requestedBy].filter((x): x is string => !!x && active.has(x));
  return want.length ? [...new Set(want)] : members.filter((m) => m.role === 'admin').map((m) => m.userId);
};

const notifyApproval = async (db: Db, agent: AgentRow, run: AgentRunRow, approvalId: string, preview: string) => {
  // About an item: its board's (and parent board's) settings and mutes apply too.
  const [board] = run.itemId
    ? await db
        .select({ id: items.boardId, parentId: boards.parentBoardId })
        .from(items)
        .innerJoin(boards, eq(boards.id, items.boardId))
        .where(and(eq(items.accountId, agent.accountId), eq(items.id, run.itemId)))
        .limit(1)
    : [];
  await notifyUsers(
    db,
    {
      accountId: agent.accountId,
      type: 'agent_approval',
      actorId: agent.userId,
      boardIds: board ? [board.id, board.parentId] : [],
      target: { itemId: run.itemId },
      payload: {
        excerpt: preview,
        agent: { agent_id: agent.id, agent_name: agent.name, run_id: run.id, approval_id: approvalId },
      },
    },
    await runAudience(db, agent, run),
  );
};

const monthStart = (now: Date) => `${now.toISOString().slice(0, 7)}-01`;
const nextMonthStart = (now: Date) => {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return d.toISOString().slice(0, 10);
};

/** This month's AI spend of the account (every source), from the ai_usage ledger. */
export const monthSpend = async (db: Db, accountId: string, now = new Date()) =>
  (await usageBetween(db, accountId, monthStart(now), nextMonthStart(now))).reduce((s, r) => s + Number(r.costUsd), 0);

/**
 * The budget alert (plan §9): once a month, when the account's AI spend passes `budget_alert_pct` of its monthly
 * budget, every admin gets an `ai_budget` notification. At 100 % `completeWith` refuses further calls.
 */
export const budgetAlert = async (db: Db, accountId: string, now = new Date()) => {
  const ai = await loadAiSettings(db, accountId);
  if (ai.monthly_budget_usd === null || ai.monthly_budget_usd <= 0) return false;
  const spent = await monthSpend(db, accountId, now);
  if (spent < (ai.monthly_budget_usd * ai.budget_alert_pct) / 100) return false;
  const already = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.accountId, accountId),
        eq(notifications.type, 'ai_budget'),
        gte(notifications.createdAt, new Date(`${monthStart(now)}T00:00:00Z`)),
      ),
    )
    .limit(1);
  if (already.length) return false;
  const admins = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.status, 'active'),
        eq(accountMembers.role, 'admin'),
      ),
    );
  // Required (billing): the admins cannot switch it off, so the month's row also marks the alert as sent.
  await notifyUsers(
    db,
    {
      accountId,
      type: 'ai_budget',
      actorId: null,
      payload: { excerpt: `$${spent.toFixed(2)} / $${ai.monthly_budget_usd!.toFixed(2)}` },
    },
    admins.map((a) => a.userId),
  );
  return true;
};

// ---- one tool call ----

type ToolStep =
  | { kind: 'step'; step: AgentStepRow }
  | { kind: 'waiting' }
  /** The shared gate refused the call for the whole run (the plan's status, AI off in the plan, the rate). */
  | { kind: 'stop'; step: AgentStepRow; reason: string };

/** Gate refusals that end the run (with that reason) rather than go back to the model as one tool's error. */
const stopsRun = (err: ToolGuardError) =>
  err.reason === 'plan_read_only' ||
  err.reason === 'plan_suspended' ||
  err.reason === 'ai_write_rate_limited' ||
  (err.reason === 'plan_feature_unavailable' && (err.details as { feature?: string } | undefined)?.feature === 'ai');

const resultBlock = (id: string, payload: unknown, isError: boolean): Anthropic.ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: id,
  content: JSON.stringify(payload),
  ...(isError ? { is_error: true } : {}),
});

const errorPayload = (code: string, message: string, details?: Record<string, unknown>) => ({
  error: { code, message, ...(details ? { details } : {}) },
});

type Ctx = {
  deps: Deps;
  agent: AgentRow;
  run: AgentRunRow;
  actor: Actor;
  seq: () => number;
  knowledge: boolean;
  /** Web search: approved for this agent, allowed by the platform, the account has a key. */
  web: boolean;
  /** The agent's remote MCP tools still enabled (מ10), loaded once per job. */
  external: McpAgentToolDef[];
};

/** The chain depth of a run (מ8 loop protection): its writes carry it, and what they trigger goes one deeper. */
export const runDepth = (run: Pick<AgentRunRow, 'meta'>) => {
  const d = (run.meta as { depth?: unknown } | null)?.depth;
  return typeof d === 'number' && Number.isFinite(d) ? d : 0;
};

/** The tools of this run: the agent's, plus `search_knowledge` (מ9) and the web tools when it has them. */
const runTools = (c: Pick<Ctx, 'agent' | 'knowledge' | 'web' | 'external'>): AiToolDef[] => [
  ...agentTools(c.agent),
  ...(c.knowledge ? [searchKnowledge as unknown as AiToolDef] : []),
  ...(c.web ? [webSearch as unknown as AiToolDef, readWebPage as unknown as AiToolDef] : []),
  ...c.external,
];

const runTool = async (c: Ctx, def: AiToolDef, input: unknown, seq: number) => {
  if (def.name === SEARCH_KNOWLEDGE) return searchKnowledgeFor(c.deps.db, c.agent, input as { query: string });
  if ((WEB_TOOL_NAMES as readonly string[]).includes(def.name))
    return runWebTool(c.deps, { accountId: c.agent.accountId, runId: c.run.id }, def.name, input as never);
  // A remote MCP tool (מ10): called through the outbound helper, its answer wrapped as untrusted content.
  if (isMcpAgentTool(def)) return runAgentMcpTool(c.deps, c.agent, c.run.id, def, input as Record<string, unknown>);
  const runner = TOOL_RUNNERS[def.name];
  if (!runner) throw new AppError('unprocessable', `Tool ${def.name} is not available`);
  if (def.risk === 'read')
    return runner({ deps: c.deps, actor: c.actor, scopes: [], batchId: null }, input) as Promise<unknown>;
  const scope = { agent_id: c.agent.id, run_id: c.run.id, step: seq, tool: def.name, depth: runDepth(c.run) };
  return inAgentScope(c.deps.db, scope, (tx) =>
    runner({ deps: { ...c.deps, db: tx }, actor: c.actor, scopes: [], batchId: c.run.id }, input),
  );
};

const handleToolUse = async (c: Ctx, tu: ToolUse, approvals: Map<string, Decision>): Promise<ToolStep> => {
  const save = async (output: unknown, isError: boolean, outcome: string) => {
    const seq = c.seq();
    const [step] = await insertStep(c.deps.db, {
      id: newId(),
      accountId: c.agent.accountId,
      runId: c.run.id,
      seq,
      kind: 'tool',
      tool: tu.name,
      toolUseId: tu.id,
      input: tu.input,
      output,
      isError,
      outcome,
      content: resultBlock(tu.id, output, isError),
    });
    await bumpToolCalls(c.deps.db, c.run.id);
    return { kind: 'step' as const, step: step! };
  };
  /** The shared gate (aiguard); a refusal is saved as the call's result and may end the run. */
  const guard = async (def: AiToolDef, input: unknown, count: boolean): Promise<ToolStep | null> => {
    if (def.name === SEARCH_KNOWLEDGE || (WEB_TOOL_NAMES as readonly string[]).includes(def.name)) return null;
    try {
      await guardToolCall(c.deps, { surface: 'agent', actor: c.actor, tool: def, input, count });
      return null;
    } catch (err) {
      if (!(err instanceof ToolGuardError)) throw err;
      const r = await save(errorPayload(err.code, err.message, err.details), true, 'blocked');
      return stopsRun(err) ? { kind: 'stop', step: r.step, reason: err.reason } : r;
    }
  };

  const allowed = runTools(c);
  const def = allowed.find((t) => t.name === tu.name) ?? aiTool(tu.name);
  // The agent's tool list is enforced here — whatever the model was talked into (plan §8).
  if (!def || !allowed.some((t) => t.name === def.name)) {
    return save(
      errorPayload('tool_not_allowed', `This agent may not use "${tu.name}".`, {
        tools: allowed.map((t) => t.name),
      }),
      true,
      'blocked',
    );
  }
  const parsed = def.input.safeParse(tu.input);
  if (!parsed.success) {
    return save(
      errorPayload('invalid_input', 'The input does not match the tool schema', {
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      }),
      true,
      'failed',
    );
  }
  if (def.risk !== 'read' && c.run.dryRun) {
    return save(
      { dry_run: true, would_call: def.name, input: parsed.data, note: 'Nothing was changed (dry run).' },
      false,
      'dry_run',
    );
  }
  // Before anything is proposed or run: may this account do it at all now (no change counted yet)?
  const early = await guard(def, parsed.data, false);
  if (early) return early;
  // The call's own risk: an automation that sends data out is sensitive, whatever the tool says (AI-RT9).
  const effective = def.risk === 'read' ? def : await callTool(c.deps, c.actor, def, parsed.data);
  const meta = (c.run.meta ?? {}) as { guest?: boolean; untrusted_requester?: boolean };
  if (
    needsApproval(effective, {
      // A run a guest started (when the agent allows it) — or someone who may not edit the board (AI-RT10) — waits
      // for a person on every write (plan §8).
      approval_mode:
        meta.guest || meta.untrusted_requester ? 'learner' : (c.agent.approvalMode as 'learner' | 'autonomous'),
      approval_tools: c.agent.approvalTools,
    })
  ) {
    const decided = approvals.get(tu.id);
    // A decision covers exactly the call a person saw (AI-RT2): another tool or input under the same id is refused.
    if (decided && (decided.tool !== def.name || !sameJson(decided.input, parsed.data)))
      return save(
        errorPayload('approval_mismatch', 'This call does not match the action a person decided on.'),
        true,
        'blocked',
      );
    if (!decided) {
      const id = newId();
      // In words with the names the agent sees (sync-ai) — the notification's excerpt; the approval screens
      // describe it again for each reader.
      const described =
        (await previewFlowCall(c.deps, c.actor, def.name, parsed.data as never).catch(() => null)) ??
        (await describeToolCall(c.deps.db, c.actor, def.name, parsed.data).catch(() => null));
      const preview = described ? plainDescription(def.title, described) : approvalPreview(def, parsed.data);
      await insertApproval(c.deps.db, {
        id,
        accountId: c.agent.accountId,
        agentId: c.agent.id,
        runId: c.run.id,
        toolUseId: tu.id,
        tool: def.name,
        input: parsed.data,
        preview,
        expiresAt: new Date(Date.now() + AGENT_APPROVAL_TTL_HOURS * 3_600_000),
      });
      await notifyApproval(c.deps.db, c.agent, c.run, id, preview);
      return { kind: 'waiting' };
    }
    if (decided.status === 'pending') return { kind: 'waiting' };
    if (decided.status === 'rejected')
      return save(
        errorPayload(
          'rejected',
          `A person rejected this action${decided.decidedByName ? ` (${decided.decidedByName})` : ''}${decided.reason ? `: ${decided.reason}` : ''}. Do not retry it.`,
        ),
        true,
        'rejected',
      );
    if (decided.status === 'expired')
      return save(
        errorPayload('approval_expired', 'Nobody approved this action in time. Do not retry it.'),
        true,
        'expired',
      );
  }
  // Again when it runs — an approval given before a downgrade does not outlive it; this one counts the change.
  const gated = await guard(effective, parsed.data, true);
  if (gated) return gated;
  try {
    const out = await runTool(c, def, parsed.data, c.seq() /* peek */);
    const structured = out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out };
    const bytes = Buffer.byteLength(JSON.stringify(structured));
    if (bytes > MAX_TOOL_RESULT_BYTES)
      return save(
        errorPayload('result_too_large', 'The answer is too large — ask for fewer rows (limit) or columns', {
          bytes,
          max_bytes: MAX_TOOL_RESULT_BYTES,
        }),
        true,
        'failed',
      );
    return save(structured, false, 'ran');
  } catch (err) {
    if (err instanceof AppError) return save(errorPayload(err.code, err.message, err.details), true, 'failed');
    c.deps.logger.error({ err, tool: def.name, runId: c.run.id }, 'agent tool failed');
    return save(errorPayload('internal', 'Internal error'), true, 'failed');
  }
};

/** A tool call answered with an error without running (over the per-turn cap). */
const refuseToolUse = async (c: Ctx, tu: ToolUse, payload: unknown): Promise<ToolStep> => {
  const [step] = await insertStep(c.deps.db, {
    id: newId(),
    accountId: c.agent.accountId,
    runId: c.run.id,
    seq: c.seq(),
    kind: 'tool',
    tool: tu.name,
    toolUseId: tu.id,
    input: tu.input,
    output: payload,
    isError: true,
    outcome: 'blocked',
    content: resultBlock(tu.id, payload, true),
  });
  return { kind: 'step', step: step! };
};

// ---- the loop ----

const failWith = (db: Db, run: AgentRunRow, error: string, status: 'failed' | 'cancelled' = 'failed') =>
  finish(db, run, { status, error });

/** `agent.run` / `agent.resume`: claim the run, then step until it ends or waits for a person. */
export const executeRun = async (deps: Deps, runId: string) => {
  const run = await claimRun(deps.db, runId);
  if (!run) return null;
  try {
    await drive(deps, run);
  } catch (err) {
    deps.logger.error({ err, runId }, 'agent run crashed');
    await failWith(deps.db, run, err instanceof AppError ? err.message : 'internal');
  }
  const done = await findRunById(deps.db, runId);
  if (done?.status === 'succeeded') await replyToMention(deps, done);
  // Errors hub: a run that failed (not one a person cancelled or that waits for approval).
  if (done?.status === 'failed')
    recordAgentRun(deps.db, {
      accountId: done.accountId,
      agentId: done.agentId,
      runId: done.id,
      itemId: done.itemId,
      error: done.error,
    });
  return findRunById(deps.db, runId);
};

/**
 * A run started by a mention answers in the thread (מ8): its final text is posted as a reply to the update that
 * mentioned the agent — as the agent, in the run's batch (so "undo the run" takes it back too). Never on a dry run.
 */
const replyToMention = async (deps: Deps, run: AgentRunRow) => {
  const updateId = (run.meta as { reply_to_update?: unknown } | null)?.reply_to_update;
  const text = run.finalText?.trim();
  if (typeof updateId !== 'string' || !text || run.dryRun) return;
  try {
    const found = await findAgent(deps.db, run.accountId, run.agentId);
    if (!found) return;
    const actor = await agentActor(deps.db, found.a, run.id);
    // The reply is a change like any tool's (aiguard): not in a read-only account, within the shared rate.
    await guardToolCall(deps, {
      surface: 'agent',
      actor,
      tool: { name: 'reply_update', risk: 'write' },
      input: { update_id: updateId },
    });
    const scope = { agent_id: found.a.id, run_id: run.id, step: run.steps + 1, tool: 'reply', depth: runDepth(run) };
    // The model answers in Markdown: stored as a formatted update unless the account turned that off (sync-ai).
    const { format_markdown } = await loadAiSettings(deps.db, run.accountId);
    const body = text.slice(0, 20_000);
    await inAgentScope(deps.db, scope, (tx) =>
      replyToUpdate(tx, actor, updateId, format_markdown ? { markdown: body } : { body }),
    );
  } catch (err) {
    deps.logger.warn({ err, runId: run.id }, 'agent reply to the mention failed');
  }
};

const drive = async (deps: Deps, run: AgentRunRow) => {
  const { db } = deps;
  const found = await findAgent(db, run.accountId, run.agentId);
  if (!found) return failWith(db, run, 'agent_deleted', 'cancelled');
  const agent = found.a;
  if (!agent.isActive) return failWith(db, run, 'agent_inactive', 'cancelled');
  if (!agent.connectionId || !found.connectionName) return failWith(db, run, 'no_ai_connection');
  const ai = await loadAiSettings(db, run.accountId);
  if (!ai.enabled) return failWith(db, run, 'ai_disabled');
  let actor: Actor;
  try {
    actor = await agentActor(db, agent, run.id);
  } catch (err) {
    return failWith(db, run, err instanceof AppError ? err.message : 'agent_actor');
  }
  const limits = agentLimitsSchema.parse(agent.limits ?? {});
  const knowledge = await hasKnowledge(db, agent);
  // Web search: the admin's approval for this agent, the platform's switch and the account's key — each run anew.
  const web =
    (agent.webSearch as { status?: string } | null)?.status === 'approved' &&
    !!(await webSearchService(deps, agent.accountId));
  const external = await agentMcpToolDefs(db, agent.accountId, agent.tools);
  const tools = toolParams(runTools({ agent, knowledge, web, external }));
  const system = systemBlocks(agent);
  const startedAt = Date.now();

  let steps = await listSteps(db, run.id);
  let nextSeq = (steps.at(-1)?.seq ?? 0) + 1;
  let current = run;
  let toolErrors = 0;
  const c: Ctx = { deps, agent, run, actor, seq: () => nextSeq, knowledge, web, external };

  for (;;) {
    // A person may cancel between steps.
    const fresh = await findRunById(db, run.id);
    if (!fresh || fresh.status !== 'running') return;
    current = fresh;
    c.run = fresh;
    if (Date.now() - startedAt > RUN_TIMEOUT_MS) return failWith(db, current, 'timeout');

    // 1. Answer the last model turn's tool calls (in order; all results go back in one message).
    const lastModel = [...steps].reverse().find((s) => s.kind === 'model');
    if (lastModel) {
      const uses = toolUsesOf(lastModel.content);
      if (!uses.length) {
        // The model already finished (a restart after the final answer was saved).
        return finish(db, current, { status: 'succeeded' });
      }
      // Tool-use ids are one call each (AI-RT2): a repeated id — in this turn or from an earlier one — could ride on
      // an approval given for another call. The model's output is not trusted to keep them unique: the run ends.
      const earlier = new Set(steps.filter((s) => s.kind === 'tool' && s.seq < lastModel.seq).map((s) => s.toolUseId));
      if (new Set(uses.map((u) => u.id)).size !== uses.length || uses.some((u) => earlier.has(u.id)))
        return failWith(db, current, 'duplicate_tool_use_id');
      const answered = new Set(steps.filter((s) => s.kind === 'tool' && s.seq > lastModel.seq).map((s) => s.toolUseId));
      const decisions = new Map<string, Decision>(
        (await runApprovals(db, run.id)).map((r) => [
          r.p.toolUseId,
          { status: r.p.status, reason: r.p.reason, decidedByName: r.decidedByName, tool: r.p.tool, input: r.p.input },
        ]),
      );
      for (const [i, tu] of uses.entries()) {
        if (answered.has(tu.id)) continue;
        const r =
          i < MAX_TOOL_USES_PER_TURN
            ? await handleToolUse(c, tu, decisions)
            : await refuseToolUse(
                c,
                tu,
                errorPayload(
                  'too_many_tool_calls',
                  `At most ${MAX_TOOL_USES_PER_TURN} tool calls per turn; this one was not run. Do fewer at a time.`,
                ),
              );
        if (r.kind === 'waiting') {
          await updateRunRow(db, run.id, { status: 'waiting_approval' });
          return;
        }
        nextSeq = r.step.seq + 1;
        steps = [...steps, r.step];
        if (r.kind === 'stop') return failWith(db, current, r.reason);
        toolErrors = r.step.isError && r.step.outcome === 'failed' ? toolErrors + 1 : 0;
        if (toolErrors >= MAX_TOOL_ERRORS) return failWith(db, current, 'tool_errors');
      }
    }

    // 2. Limits before the next model call.
    if (current.steps >= limits.max_steps) return failWith(db, current, 'limit_steps');
    if (current.costUsd >= limits.max_usd_per_run) return failWith(db, current, 'limit_run_usd');

    // 3. One model call (priced and recorded in ai_usage; refused when the month's budget is used up).
    let out: Awaited<ReturnType<typeof completeWith>>;
    try {
      out = await completeWith(deps, run.accountId, agent.connectionId, 'agent', {
        model: agent.model,
        system,
        tools,
        messages: messagesOf(steps),
        effort: agent.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
        agentic: true,
        maxTokens: 16000,
      });
    } catch (err) {
      if (err instanceof AppError)
        return failWith(db, current, err.message === 'ai_budget_exceeded' ? 'quota_budget' : err.message);
      return failWith(db, current, safeAiError(err));
    }
    const [step] = await insertStep(db, {
      id: newId(),
      accountId: run.accountId,
      runId: run.id,
      seq: nextSeq,
      kind: 'model',
      content: out.content,
      output: { stop_reason: out.stopReason, text: out.text || null, model: out.model },
      costUsd: out.costUsd,
    });
    nextSeq += 1;
    steps = [...steps, step!];
    const [updated] = await updateRunRow(db, run.id, {
      model: out.model,
      steps: current.steps + 1,
      inputTokens: current.inputTokens + out.usage.input_tokens,
      outputTokens: current.outputTokens + out.usage.output_tokens,
      cacheReadTokens: current.cacheReadTokens + (out.usage.cache_read_input_tokens ?? 0),
      cacheWriteTokens: current.cacheWriteTokens + (out.usage.cache_creation_input_tokens ?? 0),
      costUsd: Math.round((current.costUsd + out.costUsd) * 1_000_000) / 1_000_000,
    });
    current = updated!;
    await budgetAlert(db, run.accountId).catch((err) => deps.logger.warn({ err }, 'ai budget alert failed'));

    // 4. What the model's turn means.
    switch (out.stopReason) {
      case 'tool_use':
      case 'pause_turn':
        continue;
      case 'end_turn':
      case 'stop_sequence':
        return finish(db, current, { status: 'succeeded', finalText: out.text || null });
      case 'refusal':
        return failWith(db, current, 'refusal');
      case 'max_tokens':
        return failWith(db, current, 'max_tokens');
      default:
        return failWith(db, current, `stop_${out.stopReason ?? 'unknown'}`);
    }
  }
};

/** Queues a run (graphile, in the api process); without the queue (tests) it runs right here. */
export const queueRun = async (deps: Deps, runId: string, task: 'agent.run' | 'agent.resume' = 'agent.run') => {
  if (!(await enqueueJob(deps.db, task, { run_id: runId }, { maxAttempts: 1 }))) await executeRun(deps, runId);
};

/**
 * `agent.expire_approvals` (hourly): a request nobody answered in time expires; its run continues and the model is
 * told the action was not approved.
 */
export const expireApprovals = async (deps: Deps, now = new Date()) => {
  let n = 0;
  for (const p of await dueApprovals(deps.db, now)) {
    const row = await decideApprovalRow(deps.db, p.id, { status: 'expired' });
    if (!row) continue;
    n += 1;
    const run = await findRunById(deps.db, p.runId);
    if (run?.status === 'waiting_approval') {
      await updateRunRow(deps.db, run.id, { status: 'queued' });
      await queueRun(deps, run.id, 'agent.resume');
    }
  }
  return n;
};
