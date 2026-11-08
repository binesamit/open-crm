// SPDX-License-Identifier: AGPL-3.0-only
import type Anthropic from '@anthropic-ai/sdk';
import {
  AI_TOOLS,
  type AiToolDef,
  AppError,
  ASSISTANT_INSTRUCTIONS,
  type AssistantAction,
  type AssistantContext,
  type AssistantConversation,
  type AssistantMessage,
  type AssistantRef,
  type AssistantStatus,
  type AssistantStreamEvent,
  assistantActionPreview,
  assistantContextText,
  assistantTitle,
  assistantTools,
  MAX_TOOL_RESULT_BYTES,
  plainDescription,
  newId,
  SEARCH_KNOWLEDGE,
  statusBlocksAi,
} from '@bines/shared';
import { safeAiError } from '@bines/server-ai';
import type { Db } from '../../db/client';
import type { AppDeps } from '../../types';
import { findConnection } from '../ai/ai.repo';
import { completeWith, loadAiSettings, modelReadsImages } from '../ai/ai.service';
import { ownUploadedAssets } from '../files/files.service';
import { fileMark, filesOfContent, withAttachments } from './attachments';
import { refsOfContent, resolveRefs } from './refs';
import { describeToolCall } from '../ai/tools/describe';
import { previewFlowCall } from '../flows/flows.ai';
import { guardToolCall, refusalReason, ToolGuardError } from '../ai/tools/guard';
import { callTool } from '../ai/tools/risk';
import { TOOL_RUNNERS } from '../ai/tools/runners';
import { toolParams } from '../agents/engine/prompt';
import { assertBoard, loadBoardAccess, readableBoardIds } from '../boards/boards.access';
import { closeChatRun, openChatRun } from '../agents/runs.service';
import { agentActor } from '../agents/engine/context';
import { searchKnowledgeFor } from '../agents/knowledge.service';
import { loadDashboardAccess } from '../dashboards/dashboards.access';
import { assertDoc, loadDocAccess } from '../docs/docs.access';
import { boardNames } from './ai2.repo';
import { agentChatSystem, agentChatTools, type ChatAgent, loadChatAgent } from './agent-chat';
import { type Actor, loadItem } from '../items/items.service';
import {
  type AiConversationRow,
  type AiMessageRow,
  type ConversationWhere,
  findConversation,
  findMessage,
  insertConversation,
  insertMessage,
  insertMessageFiles,
  listConversations,
  listMessages,
  swapMessageActions,
  updateConversation,
  updateMessage,
  userMessagesSince,
} from './ai2.repo';
import { inAiScope } from './context';
import { assertAiStatusAllows, entitlements } from '../billing/entitlements';
import { missingFeatures } from '../billing/entitlements';

/**
 * The AI assistant panel (the planning notes "AGENTS-MCP" מ12, D26). The assistant is the person chatting: every tool
 * runs as them (their boards, view_items, column restrictions — never more). Read tools run during the answer;
 * any other tool only becomes a proposed action, shown with an "approve" button (the agents' learner mode), and
 * approved actions run together as one undoable batch. Conversations are per person per board / item, stored
 * and deletable. Costs go to ai_usage (source `assistant`), within the account budget and the panel's limits
 * (Administration → AI ו-MCP: connection, model, steps and dollars per message, messages a day).
 */
type Deps = AppDeps;

/** `claimed`: an approval is running it (AI-RT6) — a second approval of the same action does nothing. */
type StoredAction = AssistantAction & { tool_use_id: string; noted?: boolean; claimed?: boolean };

/** Tool calls one model turn may make (AI-RT3); the rest are answered with an error and never run. */
export const MAX_ASSISTANT_TOOL_USES_PER_TURN = 20;

// ---- availability ----

export const assistantStatus = async (deps: Pick<Deps, 'db'>, a: Actor): Promise<AssistantStatus> => {
  const ai = await loadAiSettings(deps.db, a.ctx.accountId);
  const s = ai.assistant;
  const canConfigure = a.ctx.role === 'admin';
  const no = (reason: NonNullable<AssistantStatus['reason']>): AssistantStatus => ({
    available: false,
    reason,
    model: null,
    can_configure: canConfigure,
  });
  // plan-lock: read-only / suspended / closed — the assistant does not open at all.
  if (statusBlocksAi((await entitlements(deps.db, a.ctx.accountId)).status)) return no('plan_status');
  if (!ai.enabled) return no('ai_disabled');
  if (!s.enabled) return no('assistant_disabled');
  if (a.ctx.role !== 'admin' && !(s.roles as string[]).includes(a.ctx.role)) return no('role');
  const conn = s.connection_id ? await findConnection(deps.db, a.ctx.accountId, s.connection_id) : undefined;
  if (!conn) return no('not_configured');
  return { available: true, reason: null, model: s.model ?? conn.defaultModel ?? null, can_configure: canConfigure };
};

const assertAvailable = async (deps: Pick<Deps, 'db'>, a: Actor) => {
  // The status's own error (423 plan_read_only / plan_suspended, 403 account_closed), like every AI surface.
  await assertAiStatusAllows(deps.db, a.ctx.accountId);
  const st = await assistantStatus(deps, a);
  if (!st.available) throw new AppError('forbidden', `assistant_${st.reason}`);
};

/**
 * A chat with an agent needs AI on for the account and a plan status that allows it — not the
 * assistant's own settings (the agent brings its connection, model and limits).
 */
const assertAgentChatAvailable = async (deps: Pick<Deps, 'db'>, a: Actor) => {
  await assertAiStatusAllows(deps.db, a.ctx.accountId);
  if (!(await loadAiSettings(deps.db, a.ctx.accountId)).enabled)
    throw new AppError('forbidden', 'assistant_ai_disabled');
};

// ---- conversations ----

const conversationDto = (c: AiConversationRow): AssistantConversation => ({
  id: c.id,
  board_id: c.boardId,
  item_id: c.itemId,
  doc_id: c.docId,
  dashboard_id: c.dashboardId,
  agent_id: c.agentId,
  title: c.title,
  cost_usd: Math.round(c.costUsd * 1_000_000) / 1_000_000,
  created_at: c.createdAt.toISOString(),
  updated_at: c.updatedAt.toISOString(),
});

/**
 * The tours the assistant offered in this answer ("show me"): its `show_me` calls that ran, read
 * from the stored turn (the call's id → its result's tour) — nothing stored twice.
 */
export const toursOfContent = (content: unknown[]): { id: string; title: string }[] => {
  const calls = new Set<string>();
  const out = new Map<string, string>();
  for (const turn of content) {
    const blocks = (turn as { content?: unknown }).content;
    if (!Array.isArray(blocks)) continue;
    for (const b of blocks as {
      type?: string;
      name?: string;
      id?: string;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    }[]) {
      if (b.type === 'tool_use' && b.name === 'show_me' && b.id) calls.add(b.id);
      if (
        b.type === 'tool_result' &&
        b.tool_use_id &&
        calls.has(b.tool_use_id) &&
        !b.is_error &&
        typeof b.content === 'string'
      ) {
        try {
          const r = JSON.parse(b.content) as { tour_id?: unknown; title?: unknown };
          if (typeof r.tour_id === 'string' && typeof r.title === 'string') out.set(r.tour_id, r.title);
        } catch {
          // Not a tour's answer.
        }
      }
    }
  }
  return [...out].map(([id, title]) => ({ id, title }));
};

const messageDto = (m: AiMessageRow): AssistantMessage => ({
  id: m.id,
  role: m.role as AssistantMessage['role'],
  text: m.text,
  reads: m.reads,
  actions: (m.actions as unknown as StoredAction[]).map(
    ({ tool_use_id: _t, noted: _n, claimed: _c, ...rest }) => rest as AssistantAction,
  ),
  cost_usd: Math.round(m.costUsd * 1_000_000) / 1_000_000,
  error: m.error,
  created_at: m.createdAt.toISOString(),
  // the files the person attached (the marks in their stored turn).
  files: m.role === 'user' ? filesOfContent(m.content) : [],
  refs: m.role === 'user' ? refsOfContent(m.content) : [],
  tours: m.role === 'assistant' ? toursOfContent(m.content as unknown[]) : [],
});

type Named = { id: string; name: string };

/**
 * What a chat is about — readable by the person, or 404 (it does not exist for them): an item (and its board), a
 * board, a document, a dashboard (with the boards it shows that the person can see) or nothing; and
 * the agent answering, when it is a chat with an agent the person may still use.
 */
const loadContext = async (db: Db, a: Actor, where: ConversationWhere) => {
  let board: Named | null = null;
  let item: Named | null = null;
  let doc: Named | null = null;
  let dashboard: (Named & { boards: Named[] }) | null = null;
  if (where.itemId) {
    const found = await loadItem(db, a, where.itemId);
    item = { id: found.item.id, name: found.item.name };
    board = { id: found.access.board.id, name: found.access.board.name };
  } else if (where.boardId) {
    const access = await loadBoardAccess(db, a.ctx, a.user, where.boardId);
    assertBoard(access, 'item.read');
    board = { id: access.board.id, name: access.board.name };
  } else if (where.docId) {
    const access = await loadDocAccess(db, a.ctx, a.user, where.docId);
    assertDoc(access, 'doc.read');
    doc = { id: access.doc.id, name: access.doc.name };
  } else if (where.dashboardId) {
    const access = await loadDashboardAccess(db, a.ctx, a.user, where.dashboardId);
    const ids = ((access.dashboard.settings as { board_ids?: unknown }).board_ids ?? []) as string[];
    const readable = await readableBoardIds(db, a.ctx, a.user, Array.isArray(ids) ? ids : []);
    dashboard = {
      id: access.dashboard.id,
      name: access.dashboard.name,
      boards: await boardNames(db, a.ctx.accountId, [...readable]),
    };
  }
  const agent: ChatAgent | null = where.agentId ? await loadChatAgent(db, a, where.agentId) : null;
  return { board, item, doc, dashboard, agent };
};

/** One place per chat: an item wins over a board, a board over a document, a document over a dashboard. */
const contextOf = (q: AssistantContext): ConversationWhere => {
  const itemId = q.item_id ?? null;
  const boardId = itemId ? null : (q.board_id ?? null);
  const docId = itemId || boardId ? null : (q.doc_id ?? null);
  const dashboardId = itemId || boardId || docId ? null : (q.dashboard_id ?? null);
  return { boardId, itemId, docId, dashboardId, agentId: q.agent_id ?? null };
};

const whereOf = (c: AiConversationRow): ConversationWhere => ({
  boardId: c.boardId,
  itemId: c.itemId,
  docId: c.docId,
  dashboardId: c.dashboardId,
  agentId: c.agentId,
});

export const listAssistantConversations = async (deps: Pick<Deps, 'db'>, a: Actor, q: AssistantContext) => {
  const where = contextOf(q);
  await assertAiStatusAllows(deps.db, a.ctx.accountId);
  await loadContext(deps.db, a, where);
  const rows = await listConversations(deps.db, a.ctx.accountId, a.user.id, where);
  return { data: rows.map(conversationDto) };
};

export const createAssistantConversation = async (deps: Pick<Deps, 'db'>, a: Actor, q: AssistantContext) => {
  const where = contextOf(q);
  await loadContext(deps.db, a, where);
  await (where.agentId ? assertAgentChatAvailable(deps, a) : assertAvailable(deps, a));
  const [row] = await insertConversation(deps.db, {
    id: newId(),
    accountId: a.ctx.accountId,
    userId: a.user.id,
    ...where,
  });
  return conversationDto(row!);
};

/** Only the person's own conversation, about something they can still read. */
const ownConversation = async (db: Db, a: Actor, id: string) => {
  const c = await findConversation(db, a.ctx.accountId, a.user.id, id);
  if (!c) throw new AppError('not_found', 'Conversation not found');
  const ctx = await loadContext(db, a, whereOf(c));
  return { c, ...ctx };
};

export const getAssistantConversation = async (deps: Pick<Deps, 'db'>, a: Actor, id: string) => {
  await assertAiStatusAllows(deps.db, a.ctx.accountId);
  const { c } = await ownConversation(deps.db, a, id);
  const messages = await listMessages(deps.db, c.id);
  return { conversation: conversationDto(c), messages: messages.map(messageDto) };
};

/** Deleted from the person's history (soft; the transcript goes with it). */
export const deleteAssistantConversation = async (deps: Pick<Deps, 'db'>, a: Actor, id: string) => {
  const c = await findConversation(deps.db, a.ctx.accountId, a.user.id, id);
  if (!c) throw new AppError('not_found', 'Conversation not found');
  await updateConversation(deps.db, c.id, { deletedAt: new Date() });
  return { ok: true as const };
};

// ---- one message ----

const today = () => new Date().toISOString().slice(0, 10);
const startOfDay = () => new Date(`${today()}T00:00:00Z`);

/** The person's tools: everything their role allows (viewers read only); sensitive ones as the account says. */
const toolsFor = (a: Actor, sensitive: 'allow' | 'block') =>
  assistantTools({ readOnly: a.ctx.role === 'viewer' || a.ctx.role === 'guest', sensitive });

/** What happened to earlier proposals since the last message — told to the model in the next user turn. */
const decisionNotes = (rows: AiMessageRow[]) => {
  const lines: string[] = [];
  for (const m of rows)
    for (const x of m.actions as unknown as StoredAction[]) {
      if (x.status === 'pending' || x.noted) continue;
      const what =
        x.status === 'done'
          ? 'approved and done'
          : x.status === 'rejected'
            ? 'rejected by the person'
            : `failed (${x.error ?? 'error'})`;
      lines.push(`- ${x.title} (action ${x.id}): ${what}`);
    }
  return lines.length ? `<action_updates>\n${lines.join('\n')}\n</action_updates>` : null;
};

const SYSTEM: Anthropic.TextBlockParam[] = [
  { type: 'text', text: ASSISTANT_INSTRUCTIONS, cache_control: { type: 'ephemeral' } },
];

/**
 * Checks before the stream opens (they answer as ordinary HTTP errors): the panel is available, the daily limit,
 * the conversation is mine and its board / item still readable. A chat with an agent instead opens
 * a `chat` run of the agent — its runs a day and the budgets are the limit.
 */
export const prepareAssistantMessage = async (
  deps: Pick<Deps, 'db'>,
  a: Actor,
  id: string,
  text: string,
  fileIds: string[] = [],
  refInputs: { type: AssistantRef['type']; id: string }[] = [],
) => {
  const own = await ownConversation(deps.db, a, id);
  // attached files — uploaded by this person, finished (else an ordinary 422 before the stream).
  const files = fileIds.length ? await ownUploadedAssets(deps.db, a, fileIds) : [];
  // "@" references: each one this person can open (else 404, before the stream).
  const refs = refInputs.length ? await resolveRefs(deps.db, a, refInputs) : [];
  if (own.agent) {
    await assertAgentChatAvailable(deps, a);
    const ai = await loadAiSettings(deps.db, a.ctx.accountId);
    const run = await openChatRun(deps, own.agent.agent, {
      requestedBy: a.user.id,
      prompt: text || [...files.map((f) => f.fileName), ...refs.map((r) => r.name)].join(', '),
      conversationId: own.c.id,
      boardScope: own.agent.boardScope,
    });
    return { ...own, ai, run, files, refs };
  }
  await assertAvailable(deps, a);
  const ai = await loadAiSettings(deps.db, a.ctx.accountId);
  const sent = await userMessagesSince(deps.db, a.ctx.accountId, a.user.id, startOfDay());
  if (sent >= ai.assistant.daily_messages_per_user) throw new AppError('rate_limited', 'assistant_daily_limit');
  return { ...own, ai, run: null, files, refs };
};

type Prepared = Awaited<ReturnType<typeof prepareAssistantMessage>>;

/** POST …/messages: the answer streams through `emit`; read tools run, write tools become pending actions. */
export const sendAssistantMessage = async (
  deps: Deps,
  a: Actor,
  p: Prepared,
  text: string,
  emit: (e: AssistantStreamEvent) => Promise<void> | void,
) => {
  // A chat with an agent: its run is closed whatever happens to the answer.
  const chat = p.agent && p.run ? { agent: p.agent.agent, run: p.run } : null;
  try {
    return await answer(deps, a, p, text, emit, chat);
  } catch (err) {
    if (chat) await closeChatRun(deps, chat.run.id, { steps: 0, costUsd: 0, text: '', error: 'internal' });
    throw err;
  }
};

/** Who answers and with what: the assistant (as the person, the panel's settings) or an agent (its own). */
const engineOf = async (
  deps: Deps,
  a: Actor,
  ai: Prepared['ai'],
  chat: { agent: ChatAgent['agent']; run: NonNullable<Prepared['run']> } | null,
) => {
  if (!chat)
    return {
      reader: a,
      tools: toolsFor(a, ai.mcp_sensitive),
      system: SYSTEM,
      connectionId: ai.assistant.connection_id!,
      model: ai.assistant.model,
      effort: 'medium' as const,
      maxSteps: ai.assistant.max_steps,
      maxUsd: ai.assistant.max_usd_per_message,
      source: 'assistant' as const,
      agent: null,
    };
  const { agent, run } = chat;
  return {
    // The agent's own service user, limited to its boards that this person can see (the run's board scope).
    reader: await agentActor(deps.db, agent, run.id),
    tools: await agentChatTools(deps.db, agent, ai.mcp_sensitive),
    system: agentChatSystem(agent),
    connectionId: agent.connectionId!,
    model: agent.model,
    effort: agent.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max',
    maxSteps: run.limits.max_steps,
    maxUsd: run.limits.max_usd_per_run,
    source: 'agent' as const,
    agent,
  };
};

type Engine = Awaited<ReturnType<typeof engineOf>>;

const answer = async (
  deps: Deps,
  a: Actor,
  p: Prepared,
  text: string,
  emit: (e: AssistantStreamEvent) => Promise<void> | void,
  chat: { agent: ChatAgent['agent']; run: NonNullable<Prepared['run']> } | null,
) => {
  const { db } = deps;
  const { c, ai } = p;
  const engine = await engineOf(deps, a, ai, chat);
  const history = await listMessages(db, c.id);
  const prior = history.flatMap((m) => m.content as Anthropic.MessageParam[]);
  let seq = (history.at(-1)?.seq ?? 0) + 1;

  // The user's turn: where the panel is (ids — ours; names — wrapped data), what happened to earlier proposals,
  // then the person's own words.
  const notes = decisionNotes(history);
  const userTurn: Anthropic.MessageParam = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: assistantContextText({
          today: today(),
          board: p.board,
          item: p.item,
          doc: p.doc,
          dashboard: p.dashboard,
          missing_features: await missingFeatures(deps.db, a.ctx.accountId),
        }),
      },
      ...(notes ? [{ type: 'text' as const, text: notes }] : []),
      // A message of files alone has no text block (a provider refuses an empty one).
      ...(text ? [{ type: 'text' as const, text }] : []),
      // a mark per attached file — read from storage each time the chat goes to the model.
      ...(p.files.map(fileMark) as unknown as Anthropic.TextBlockParam[]),
      // "@" references: a mark each — its ids and name go to the model (refs.ts).
      ...(p.refs as unknown as Anthropic.TextBlockParam[]),
    ],
  };
  const [userRow] = await insertMessage(db, {
    id: newId(),
    accountId: a.ctx.accountId,
    conversationId: c.id,
    seq: seq++,
    role: 'user',
    text,
    content: [userTurn],
  });
  if (p.files.length)
    await insertMessageFiles(
      db,
      p.files.map((f, i) => ({ messageId: userRow!.id, assetId: f.id, accountId: a.ctx.accountId, position: i })),
    );
  // Those decisions are now told: mark them so they are not repeated.
  for (const m of history) {
    const acts = m.actions as unknown as StoredAction[];
    if (acts.some((x) => x.status !== 'pending' && !x.noted))
      await updateMessage(db, m.id, {
        actions: acts.map((x) => (x.status !== 'pending' ? { ...x, noted: true } : x)) as never,
      });
  }
  await emit({ type: 'user', message: messageDto(userRow!) });

  const tools = engine.tools;
  const params = toolParams(tools);
  const turn: Anthropic.MessageParam[] = [userTurn];
  // The transcript with its attached files read (images only for a model that sees them) — once per message.
  const vision = await modelReadsImages(deps, a.ctx.accountId, engine.connectionId, engine.model);
  const sent = await withAttachments(deps, a.ctx.accountId, [...prior, userTurn], vision);
  const reads: string[] = [];
  const actions: StoredAction[] = [];
  const texts: string[] = [];
  let cost = 0;
  let steps = 0;
  let error: string | null = null;

  for (let step = 0; ; step += 1) {
    if (step >= engine.maxSteps) {
      error = 'limit_steps';
      break;
    }
    if (cost >= engine.maxUsd) {
      error = 'limit_message_usd';
      break;
    }
    let out: Awaited<ReturnType<typeof completeWith>>;
    steps = step + 1;
    try {
      out = await completeWith(deps, a.ctx.accountId, engine.connectionId, engine.source, {
        ...(engine.model ? { model: engine.model } : {}),
        system: engine.system,
        tools: params,
        messages: [...sent, ...turn.slice(1)],
        agentic: true,
        effort: engine.effort,
        maxTokens: 16000,
        onText: (delta) => void emit({ type: 'delta', text: delta }),
      });
    } catch (err) {
      error = err instanceof AppError ? err.message : safeAiError(err);
      break;
    }
    cost += out.costUsd;
    turn.push({ role: 'assistant', content: out.content as Anthropic.ContentBlockParam[] });
    if (out.text) texts.push(out.text);
    if (out.stopReason === 'refusal') {
      error = 'refusal';
      break;
    }
    const uses = out.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (out.stopReason !== 'tool_use' || !uses.length) {
      if (out.stopReason === 'max_tokens') error = 'max_tokens';
      break;
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const [i, tu] of uses.entries()) {
      const r: ToolOutcome =
        i < MAX_ASSISTANT_TOOL_USES_PER_TURN
          ? await handleToolUse(deps, a, tools, tu, { sensitive: ai.mcp_sensitive, engine })
          : {
              result: errorPayload(
                'too_many_tool_calls',
                `At most ${MAX_ASSISTANT_TOOL_USES_PER_TURN} tool calls per turn; this one was not run.`,
              ),
              isError: true,
            };
      if (r.read) {
        reads.push(tu.name);
        await emit({ type: 'read', tool: tu.name });
      }
      if (r.action) {
        actions.push(r.action);
        const { tool_use_id: _t, ...dto } = r.action;
        await emit({ type: 'action', action: dto });
      }
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(r.result),
        ...(r.isError ? { is_error: true } : {}),
      });
    }
    turn.push({ role: 'user', content: results });
  }

  const [row] = await insertMessage(db, {
    id: newId(),
    accountId: a.ctx.accountId,
    conversationId: c.id,
    seq,
    role: 'assistant',
    text: texts.join('\n\n').trim(),
    // The model's turns and the tool results, as sent — the next message replays them unchanged.
    content: turn.slice(1),
    reads,
    actions: actions as never,
    costUsd: Math.round(cost * 1_000_000) / 1_000_000,
    error,
  });
  await updateConversation(db, c.id, {
    costUsd: c.costUsd + cost,
    ...(c.title ? {} : { title: assistantTitle(text || p.files[0]?.fileName || p.refs[0]?.name || '') }),
  });
  const dto = messageDto(row!);
  if (chat) await closeChatRun(deps, chat.run.id, { steps, costUsd: cost, text: dto.text, error });
  await emit(error && !dto.text ? { type: 'error', code: error, message: dto } : { type: 'done', message: dto });
  return dto;
};

type ToolOutcome = { result: unknown; isError?: boolean; read?: boolean; action?: StoredAction };

const errorPayload = (code: string, message: string, details?: Record<string, unknown>) => ({
  error: { code, message, ...(details ? { details } : {}) },
});

const runRead = async (deps: Deps, a: Actor, def: AiToolDef, input: unknown, engine: Engine) => {
  // An agent's knowledge (מ9) — its own files, searched for it.
  if (engine.agent && def.name === SEARCH_KNOWLEDGE)
    return searchKnowledgeFor(deps.db, engine.agent, input as { query: string });
  const runner = TOOL_RUNNERS[def.name];
  if (!runner) throw new AppError('unprocessable', `Tool ${def.name} is not available`);
  // The shared gate (aiguard): a suspended account / a plan without AI reads nothing either.
  await guardToolCall(deps, { surface: engine.agent ? 'agent' : 'assistant', actor: a, tool: def, input });
  const out = await runner({ deps, actor: a, scopes: [], batchId: null }, input);
  const structured = out && typeof out === 'object' && !Array.isArray(out) ? out : { result: out };
  const bytes = Buffer.byteLength(JSON.stringify(structured));
  if (bytes > MAX_TOOL_RESULT_BYTES)
    throw new AppError('payload_too_large', 'The answer is too large — ask for fewer rows (limit) or columns', {
      bytes,
      max_bytes: MAX_TOOL_RESULT_BYTES,
    });
  return structured;
};

/**
 * One tool call of the model: outside the tools → refused; read → run (as the reader: the person, or the agent
 * within its scope); anything else → an action the person approves (it must pass the reader's checks too).
 */
const handleToolUse = async (
  deps: Deps,
  person: Actor,
  tools: AiToolDef[],
  tu: Anthropic.ToolUseBlock,
  ctx: { sensitive: 'allow' | 'block'; engine: Engine },
): Promise<ToolOutcome> => {
  const a = ctx.engine.reader;
  const surface = ctx.engine.agent ? 'agent' : 'assistant';
  const def = tools.find((t) => t.name === tu.name);
  if (!def)
    return {
      result: errorPayload('tool_not_allowed', `"${tu.name}" is not available to you.`),
      isError: true,
    };
  const parsed = def.input.safeParse(tu.input);
  if (!parsed.success)
    return {
      result: errorPayload('invalid_input', 'The input does not match the tool schema', {
        issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
      }),
      isError: true,
    };
  if (def.risk === 'read') {
    try {
      return { result: await runRead(deps, a, def, parsed.data, ctx.engine), read: true };
    } catch (err) {
      if (err instanceof AppError)
        return { result: errorPayload(err.code, err.message, err.details), isError: true, read: true };
      deps.logger.error({ err, tool: def.name }, 'assistant read tool failed');
      return { result: errorPayload('internal', 'Internal error'), isError: true, read: true };
    }
  }
  // An automation that sends data out is sensitive (AI-RT9): not even proposed when the account blocks those.
  if (ctx.sensitive === 'block' && (await callTool(deps, a, def, parsed.data)).risk === 'sensitive')
    return {
      result: errorPayload('forbidden', 'This action is blocked for AI in this account.'),
      isError: true,
    };
  // Nothing is proposed that could not run now (aiguard: a read-only plan, a feature the plan lacks …); the
  // approval checks again, counting the change.
  try {
    await guardToolCall(deps, { surface, actor: a, tool: def, input: parsed.data, count: false });
  } catch (err) {
    if (err instanceof ToolGuardError)
      return { result: errorPayload(err.code, err.message, err.details), isError: true };
    throw err;
  }
  // An external flow's change: the card shows the real diff; a call that could never run (editing
  // where the platform cannot, an edit that does not fit) is answered to the model instead of proposed.
  let flowCard: Awaited<ReturnType<typeof previewFlowCall>> = null;
  try {
    flowCard = await previewFlowCall(deps, a, def.name, parsed.data as never);
  } catch (err) {
    if (err instanceof AppError) return { result: errorPayload(err.code, err.message, err.details), isError: true };
    deps.logger.warn({ err, tool: def.name }, 'assistant flow preview failed');
  }
  // The change in words, with the names this person sees (sync-ai); the JSON stays as technical details.
  const description = flowCard ?? (await describeToolCall(deps.db, person, def.name, parsed.data).catch(() => null));
  const action: StoredAction = {
    id: newId(),
    tool_use_id: tu.id,
    tool: def.name,
    title: def.title,
    preview: description ? plainDescription(def.title, description) : assistantActionPreview(def, parsed.data),
    description,
    input: parsed.data,
    status: 'pending',
    batch_id: null,
    error: null,
  };
  return {
    action,
    result: {
      status: 'waiting_for_approval',
      action_id: action.id,
      note: 'Proposed to the person; it runs only when they approve it. Do not call it again.',
    },
  };
};

// ---- decisions ----

/**
 * POST /ai/assistant/messages/{id}/actions — approve and / or reject proposed actions. Approved ones run now, as
 * the person (re-checked: the tool is still theirs, the input still valid), each in its own savepoint inside one
 * transaction that marks every write as one batch — a single undo takes them all back.
 */
export const decideAssistantActions = async (
  deps: Deps,
  a: Actor,
  messageId: string,
  body: { approve: string[]; reject: string[] },
) => {
  const found = await findMessage(deps.db, a.ctx.accountId, messageId);
  if (!found || found.c.userId !== a.user.id) throw new AppError('not_found', 'Message not found');
  // A chat with an agent: the agent must still be one the person may use; the actions are its tools
  // and they run as the person (who approves them), marked with the agent.
  const chatAgent = found.c.agentId ? (await loadChatAgent(deps.db, a, found.c.agentId)).agent : null;
  await (chatAgent ? assertAgentChatAvailable(deps, a) : assertAvailable(deps, a));
  const ai = await loadAiSettings(deps.db, a.ctx.accountId);
  const tools = chatAgent ? await agentChatTools(deps.db, chatAgent, ai.mcp_sensitive) : toolsFor(a, ai.mcp_sensitive);
  const stored = found.m.actions as unknown as StoredAction[];
  const acts = stored.map((x) => ({ ...x }));
  const approve = acts.filter((x) => x.status === 'pending' && !x.claimed && body.approve.includes(x.id));
  for (const x of acts) if (x.status === 'pending' && !x.claimed && body.reject.includes(x.id)) x.status = 'rejected';
  for (const x of approve) x.claimed = true;
  // Claim them first (compare-and-swap, AI-RT6): two approvals sent at once never run an action twice.
  if (
    (approve.length || acts.some((x, i) => x.status !== stored[i]!.status)) &&
    !(await swapMessageActions(deps.db, found.m.id, stored, acts))
  )
    throw new AppError('conflict', 'actions_changed');

  let batchId: string | null = null;
  if (approve.length) {
    const batch = newId();
    const release = async () => {
      // The whole batch rolled back: the actions are pending again, free to approve once more.
      for (const x of approve) Object.assign(x, { status: 'pending', batch_id: null, error: null, claimed: undefined });
      await updateMessage(deps.db, found.m.id, { actions: acts as never });
    };
    await inAiScope(
      deps.db,
      {
        source: 'assistant',
        batch_id: batch,
        conversation_id: found.c.id,
        message_id: found.m.id,
        ...(chatAgent ? { agent_id: chatAgent.id } : {}),
      },
      async (tx) => {
        for (const x of approve) {
          const def = tools.find((t) => t.name === x.tool) ?? AI_TOOLS.find((t) => t.name === x.tool);
          const runner = TOOL_RUNNERS[x.tool];
          const parsed = def?.input.safeParse(x.input);
          if (!def || !tools.includes(def) || !runner || !parsed?.success) {
            x.status = 'failed';
            x.error = 'tool_not_allowed';
            continue;
          }
          // The account may have blocked sensitive actions since it was proposed (AI-RT9).
          if (ai.mcp_sensitive === 'block' && (await callTool({ db: tx }, a, def, parsed.data)).risk === 'sensitive') {
            x.status = 'failed';
            x.error = 'forbidden';
            continue;
          }
          // The shared gate again at run time (aiguard): a downgrade since the proposal, the shared change rate.
          try {
            await guardToolCall({ db: tx }, { surface: 'assistant', actor: a, tool: def, input: parsed.data, ai });
          } catch (err) {
            if (!(err instanceof ToolGuardError)) throw err;
            x.status = 'failed';
            x.error = refusalReason(err);
            continue;
          }
          try {
            await tx.transaction((sp) =>
              runner({ deps: { ...deps, db: sp }, actor: a, scopes: [], batchId: batch }, parsed.data),
            );
            x.status = 'done';
            x.batch_id = batch;
          } catch (err) {
            if (!(err instanceof AppError)) deps.logger.error({ err, tool: x.tool }, 'assistant action failed');
            x.status = 'failed';
            x.error = err instanceof AppError ? err.code : 'internal';
          }
        }
      },
    ).catch(async (err: unknown) => {
      await release();
      throw err;
    });
    if (approve.some((x) => x.status === 'done')) batchId = batch;
  }
  for (const x of approve) delete x.claimed;
  const [row] = await updateMessage(deps.db, found.m.id, { actions: acts as never });
  return { batch_id: batchId, message: messageDto(row!) };
};
