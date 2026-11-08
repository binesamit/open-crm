// SPDX-License-Identifier: AGPL-3.0-only
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { packAgentTemplates } from '../extensions/extensions.service';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  type Agent,
  type AgentWebSearch,
  type AgentAutomationRef,
  type AgentDirectory,
  type AgentDirectoryEntry,
  type AgentUnavailableEntry,
  type AgentUnavailableReason,
  AGENT_AVATAR_AUTO,
  AGENT_TOOL_NAMES,
  AVATAR_ANIMALS,
  animalAvatarCode,
  animalAvatarDataUrl,
  ownBackground,
  pickAnimalAvatar,
  agentLimitsSchema,
  agentTriggersSchema,
  agentTemplateSchema,
  type AgentTemplate,
  aiModel,
  type AiProvider,
  catalogueModels,
  AppError,
  canEditAllItems,
  createAgentSchema,
  type CreateAgent,
  newId,
  type UpdateAgent,
  updateAgentSchema,
  isMcpToolAlias,
  statusBlocksAi,
  isChatProvider,
} from '@bines/shared';
import { entitlements } from '../billing/entitlements';
import type { Db } from '../../db/client';
import {
  accountMembers,
  agentKnowledge,
  agentRuns,
  automations,
  boards as boardsTable,
  knowledgeChunks,
  users,
} from '../../db/schema';
import { releaseAssets } from '../files/files.service';
import type { AppDeps, RequestMeta } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { findConnection, listConnectionRows } from '../ai/ai.repo';
import { completeWith, loadAiSettings } from '../ai/ai.service';
import {
  assertListedModel,
  capabilitiesOf,
  connectionDefaultModel,
  connectionModels,
  defaultModelOf,
  manualOf,
  withManual,
} from '../ai/models.service';
import { recordAudit } from '../audit/audit.repo';
import { loadBoardAccess, readableBoardIds } from '../boards/boards.access';
import type { Actor } from '../items/items.service';
import { knowledgeCounts, listKnowledgeRows } from './knowledge.repo';
import { assertAgentMcpTools } from '../mcp-servers/mcp-servers.service';
import {
  type AgentRow,
  agentBoardRows,
  agentStats,
  agentTemplateKeys,
  ensureWorkspaceMember,
  findAgent,
  insertAgent,
  listAgentRows,
  removeAgentBoards,
  updateAgentRow,
  upsertAgentBoard,
} from './agents.repo';

/**
 * Agents (the planning notes "AGENTS-MCP" מ6, D26): CRUD of agents built in the UI. Who manages agents: admins, and
 * members when the account allows it (`settings.ai.agent_creators`); a member manages only the agents they
 * created. An agent gets its own service user; its boards are that user's subscriptions, each one checked against
 * what its creator can do (never more access than its creator).
 */
type Deps = Pick<AppDeps, 'db'> & Partial<Pick<AppDeps, 'aiClient' | 'secrets'>>;

/**
 * "The agent picks its own avatar": its model chooses one of our animals from its name and role
 * (one word back). Never in the way of creating the agent: no AI here, a refusal, an error or an answer that is not
 * an animal → a stable pick from the name and role.
 */
const agentPicksAvatar = async (
  deps: Deps,
  accountId: string,
  agent: { name: string; role: string; connection_id: string; model: string },
) => {
  const fallback = pickAnimalAvatar(`${agent.name}
${agent.role}`);
  if (!deps.aiClient || !deps.secrets || !('env' in deps)) return fallback;
  const ids = AVATAR_ANIMALS.map((x) => x.id);
  try {
    const out = await completeWith(deps as AppDeps, accountId, agent.connection_id, 'agent', {
      model: agent.model,
      system: `You choose a friendly avatar for a work assistant. Answer with exactly one word from this list: ${ids.join(', ')}.`,
      messages: [
        {
          role: 'user',
          content: `Name: ${agent.name}
Role: ${agent.role}`,
        },
      ],
      maxTokens: 10,
      effort: 'low',
    });
    const id = out.text
      .toLowerCase()
      .match(/[a-z]+/g)
      ?.find((w) => ids.includes(w));
    const art = id ? AVATAR_ANIMALS.find((x) => x.id === id) : undefined;
    return art ? animalAvatarCode(art.id, ownBackground(art)) : fallback;
  } catch {
    return fallback;
  }
};

/** The agent's user shows its animal everywhere a person shows a photo (`users.image`); no animal → no image. */
const syncAgentImage = (tx: Db, userId: string, avatar: string | null) =>
  tx
    .update(users)
    .set({ image: animalAvatarDataUrl(avatar) })
    .where(eq(users.id, userId));

export const mayCreateAgents = async (db: Db, a: Actor) => {
  if (a.ctx.role === 'admin') return true;
  if (a.ctx.role !== 'member') return false;
  return (await loadAiSettings(db, a.ctx.accountId)).agent_creators === 'members';
};

const assertMayCreate = async (db: Db, a: Actor) => {
  if (!(await mayCreateAgents(db, a))) throw new AppError('forbidden', 'agents_admins_only');
};

/** May `a` see / edit / run this agent? Admins any; its creator while they may still create agents. */
export const mayManageAgent = async (db: Db, a: Actor, agent: Pick<AgentRow, 'createdBy'>) =>
  a.ctx.role === 'admin' || (agent.createdBy === a.user.id && (await mayCreateAgents(db, a)));

/** The agent, or 404 (another account's id, a deleted agent, or one I may not manage — same answer). */
export const loadManagedAgent = async (db: Db, a: Actor, id: string) => {
  const found = await findAgent(db, a.ctx.accountId, id);
  if (!found || !(await mayManageAgent(db, a, found.a))) throw new AppError('not_found', 'Agent not found');
  return found;
};

/** An agent's stored web search state, with defaults for agents saved before it. */
const webSearchOf = (raw: unknown): AgentWebSearch => {
  const r = (raw ?? {}) as Partial<AgentWebSearch>;
  return {
    status: r.status === 'requested' || r.status === 'approved' ? r.status : 'off',
    requested_by: r.requested_by ?? null,
    decided_by: r.decided_by ?? null,
    at: r.at ?? null,
  };
};

/**
 * "Web search" switched on or off in the editor: an admin's "on" approves it; anyone else's asks (the agent does not
 * search until an admin approves); "on" again keeps an approval; "off" revokes it.
 */
const nextWebSearch = (a: Actor, wanted: boolean, current: AgentWebSearch): AgentWebSearch => {
  const at = new Date().toISOString();
  if (!wanted) return current.status === 'off' ? current : { ...current, status: 'off', decided_by: a.user.id, at };
  if (current.status === 'approved') return current;
  if (a.ctx.role === 'admin') return { status: 'approved', requested_by: a.user.id, decided_by: a.user.id, at };
  return { status: 'requested', requested_by: a.user.id, decided_by: null, at };
};

const monthStartDate = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

const dto = (
  r: { a: AgentRow; connectionName: string | null; createdByName: string | null },
  boards: { boardId: string; level: string | null; name: string | null }[],
  stats?: { runs7d: number; costMonth: number; lastRun: string | null; pending: number },
  knowledge?: { sources: number; ready: number },
): Agent => {
  const triggers = agentTriggersSchema.parse(r.a.triggers ?? {});
  return {
    id: r.a.id,
    name: r.a.name,
    avatar: r.a.avatar,
    role: r.a.role,
    instructions: r.a.instructions,
    connection_id: r.connectionName ? r.a.connectionId : null,
    connection_name: r.connectionName,
    model: r.a.model,
    effort: r.a.effort as Agent['effort'],
    tools: r.a.tools,
    approval_tools: r.a.approvalTools,
    boards: boards.map((b) => ({
      board_id: b.boardId,
      level: b.level === 'contributor' ? 'edit' : 'view',
      name: b.name,
    })),
    approval_mode: r.a.approvalMode as Agent['approval_mode'],
    limits: agentLimitsSchema.parse(r.a.limits ?? {}),
    triggers,
    knowledge: knowledge ?? { sources: 0, ready: 0 },
    web_search: webSearchOf(r.a.webSearch),
    is_active: r.a.isActive,
    user_id: r.a.userId,
    template_key: r.a.templateKey,
    created_by: r.a.createdBy,
    created_by_name: r.createdByName,
    revision: r.a.revision,
    created_at: r.a.createdAt.toISOString(),
    updated_at: r.a.updatedAt.toISOString(),
    stats: {
      runs_7d: stats?.runs7d ?? 0,
      cost_month_usd: Math.round((stats?.costMonth ?? 0) * 1_000_000) / 1_000_000,
      pending_approvals: stats?.pending ?? 0,
      last_run_at: stats?.lastRun ? new Date(stats.lastRun).toISOString() : null,
    },
  };
};

const statsFor = async (db: Db, accountId: string) => {
  const now = new Date();
  const { rows, pending } = await agentStats(
    db,
    accountId,
    new Date(now.getTime() - 7 * 86_400_000),
    monthStartDate(now),
  );
  const by = new Map(rows.map((r) => [r.agentId, r]));
  return (agentId: string) => {
    const r = by.get(agentId);
    return {
      runs7d: Number(r?.runs7d ?? 0),
      costMonth: Number(r?.costMonth ?? 0),
      lastRun: r?.lastRun ?? null,
      pending: pending.get(agentId) ?? 0,
    };
  };
};

export const listAgents = async (deps: Deps, a: Actor) => {
  if (a.ctx.role === 'guest' || a.ctx.role === 'viewer') return { data: [], can_create: false };
  const canCreate = await mayCreateAgents(deps.db, a);
  if (a.ctx.role !== 'admin' && !canCreate) return { data: [], can_create: false };
  // The editor starts a new agent from the account's choice.
  const newAgentMention = (await loadAiSettings(deps.db, a.ctx.accountId)).agent_mention_default;
  const rows = await listAgentRows(deps.db, a.ctx.accountId, a.ctx.role === 'admin' ? undefined : a.user.id);
  const stats = await statsFor(deps.db, a.ctx.accountId);
  const knowledge = await knowledgeCounts(deps.db, a.ctx.accountId);
  const data = [];
  for (const r of rows)
    data.push(dto(r, await agentBoardRows(deps.db, a.ctx.accountId, r.a.userId), stats(r.a.id), knowledge.get(r.a.id)));
  return { data, can_create: canCreate, new_agent_mention: newAgentMention };
};

export const getAgent = async (deps: Deps, a: Actor, id: string) => {
  const found = await loadManagedAgent(deps.db, a, id);
  const stats = await statsFor(deps.db, a.ctx.accountId);
  const knowledge = await knowledgeCounts(deps.db, a.ctx.accountId);
  return dto(
    found,
    await agentBoardRows(deps.db, a.ctx.accountId, found.a.userId),
    stats(found.a.id),
    knowledge.get(found.a.id),
  );
};

/**
 * GET /agents/directory — the account's active agents that act on a mention or an assignment, for the mention list
 * and the people pickers ("digital workers", מ8). Everyone in the account sees them (a guest only those that allow
 * guests), each with the boards — of the ones the reader can see — where it acts. No instructions, no settings.
 * `unavailable`: the other agents the reader could mention, each with why it does not act now — the
 * mention list shows them disabled with the reason. A guest hears only of agents on boards they can see.
 */
export const agentDirectory = async (deps: Deps, a: Actor): Promise<AgentDirectory> => {
  const out: AgentDirectoryEntry[] = [];
  const unavailable: AgentUnavailableEntry[] = [];
  const guest = a.ctx.role === 'guest';
  const aiOn = (await loadAiSettings(deps.db, a.ctx.accountId)).enabled;
  // plan-lock: in a read-only / suspended / closed account no agent acts (each is listed with the reason).
  const statusOff = statusBlocksAi((await entitlements(deps.db, a.ctx.accountId)).status);
  const rows = (await listAgentRows(deps.db, a.ctx.accountId)).sort((x, y) => x.a.name.localeCompare(y.a.name));
  for (const { a: agent, connectionName } of rows) {
    const triggers = agentTriggersSchema.parse(agent.triggers ?? {});
    const own = (await agentBoardRows(deps.db, agent.accountId, agent.userId)).map((b) => b.boardId);
    const scoped = triggers.board_ids.length ? own.filter((id) => triggers.board_ids.includes(id)) : own;
    const visible = await readableBoardIds(deps.db, a.ctx, a.user, scoped);
    const boardIds = scoped.filter((id) => visible.has(id));
    const reason: AgentUnavailableReason | null = statusOff
      ? 'plan_status'
      : !agent.isActive
        ? 'inactive'
        : !connectionName || !aiOn
          ? 'no_connection'
          : !triggers.mention && !triggers.assign
            ? 'mention_off'
            : guest && !triggers.allow_guests
              ? 'guests_not_allowed'
              : !boardIds.length
                ? 'not_on_board'
                : null;
    const who = { id: agent.id, user_id: agent.userId, name: agent.name, avatar: agent.avatar, role: agent.role };
    if (!reason) {
      out.push({ ...who, mention: triggers.mention, assign: triggers.assign, board_ids: boardIds });
      continue;
    }
    // A guest never learns of an agent working only on boards they cannot see.
    if (guest && !boardIds.length) continue;
    unavailable.push({ ...who, reason });
  }
  return { data: out, unavailable };
};

/** GET /agents/:id/automations — the automations that run this agent (`run_agent`), for its "when it acts" tab. */
export const agentAutomations = async (deps: Deps, a: Actor, id: string): Promise<{ data: AgentAutomationRef[] }> => {
  const found = await loadManagedAgent(deps.db, a, id);
  const rows = await deps.db
    .select({
      id: automations.id,
      title: automations.title,
      boardId: automations.boardId,
      boardName: boardsTable.name,
      isActive: automations.isActive,
    })
    .from(automations)
    .leftJoin(boardsTable, eq(boardsTable.id, automations.boardId))
    .where(
      and(
        eq(automations.accountId, a.ctx.accountId),
        isNull(automations.deletedAt),
        sql`jsonb_path_exists(${automations.recipe}, '$.actions[*] ? (@.type == "run_agent" && @.agent == $id)', jsonb_build_object('id', ${found.a.id}::text))`,
      ),
    );
  return {
    data: rows.map((r) => ({
      id: r.id,
      title: r.title,
      board_id: r.boardId,
      board_name: r.boardName,
      is_active: r.isActive,
    })),
  };
};

/**
 * The AI connections an agent may pick (name + default model, never the key): for whoever may create agents —
 * a member creator cannot read Administration → AI, but must choose a connection.
 */
export const agentConnections = async (deps: Deps, a: Actor) => {
  await assertMayCreate(deps.db, a);
  // Chat providers only (a speech-only connection — Soniox — is not offered).
  const rows = (await listConnectionRows(deps.db, a.ctx.accountId)).filter((r) =>
    isChatProvider(r.c.provider as AiProvider),
  );
  return {
    data: rows.map((r) => ({ id: r.c.id, name: r.c.name, provider: r.c.provider, default_model: r.c.defaultModel })),
  };
};

// ---- validation ----

/** The connection exists and the model is on its list (live from the provider, else the catalogue — Fix: ). */
const assertConnectionAndModel = async (deps: Deps, accountId: string, connectionId: string, model: string) => {
  const conn = await findConnection(deps.db, accountId, connectionId);
  if (!conn) throw new AppError('invalid_value', 'unknown_ai_connection', { connection_id: connectionId });
  if (deps.aiClient && deps.secrets) {
    const entry = await connectionModels({ aiClient: deps.aiClient, secrets: deps.secrets, db: deps.db }, conn);
    assertListedModel(entry, model, manualOf(conn));
    // An agent works through tools: a model that cannot call them is refused when the agent is saved.
    const listed = withManual(entry, manualOf(conn)).find((m) => m.id === model);
    if (!capabilitiesOf(conn.provider, listed ?? { id: model }).tools)
      throw new AppError('invalid_value', 'ai_model_no_tools', { model });
    return;
  }
  const m = aiModel(model);
  if (!m || m.provider !== conn.provider) throw new AppError('invalid_value', 'unknown_model', { model });
};

const assertTools = (tools: string[], approvalTools: string[]) => {
  // A remote MCP tool (מ10) is checked against the account's enabled tools by assertAgentMcpTools.
  const unknown = tools.filter((t) => !AGENT_TOOL_NAMES.includes(t) && !isMcpToolAlias(t));
  if (unknown.length) throw new AppError('invalid_value', 'unknown_tools', { tools: unknown });
  const outside = approvalTools.filter((t) => !tools.includes(t));
  if (outside.length) throw new AppError('invalid_value', 'approval_tools_not_in_tools', { tools: outside });
};

/**
 * Boards for the agent: each one its creator can read ("view") or edit items on ("edit"). A board the creator
 * cannot see is a 404 (its id must not leak), one they cannot edit is a 403.
 */
const checkBoards = async (db: Db, creator: Actor, boards: { board_id: string; level: 'view' | 'edit' }[]) => {
  const out: { boardId: string; workspaceId: string; workspaceKind: string; level: 'viewer' | 'contributor' }[] = [];
  const seen = new Set<string>();
  for (const b of boards) {
    if (seen.has(b.board_id)) continue;
    seen.add(b.board_id);
    const access = await loadBoardAccess(db, creator.ctx, creator.user, b.board_id);
    if (access.board.parentBoardId) throw new AppError('invalid_value', 'subitems_board', { board_id: b.board_id });
    // "Edit" = every item of the board: a creator limited to their assigned items cannot hand that out (AI-RT1).
    if (b.level === 'edit' && !canEditAllItems(access.perm))
      throw new AppError('forbidden', 'agent_board_exceeds_creator', { board_id: b.board_id });
    out.push({
      boardId: b.board_id,
      workspaceId: access.workspace.id,
      workspaceKind: access.workspace.kind,
      level: b.level === 'edit' ? 'contributor' : 'viewer',
    });
  }
  return out;
};

/**
 * Makes the agent user's subscriptions exactly `boards` (a closed workspace also gets the agent as member) — plus
 * the boards in its knowledge base (מ9), which it keeps reading while they are there.
 */
const syncBoards = async (db: Db, agent: AgentRow, by: Actor, boards: Awaited<ReturnType<typeof checkBoards>>) => {
  const current = await agentBoardRows(db, agent.accountId, agent.userId);
  const knowledgeBoards = (await listKnowledgeRows(db, agent.accountId, agent.id)).flatMap((k) =>
    k.kind === 'board' && k.boardId ? [k.boardId] : [],
  );
  const wanted = new Set([...boards.map((b) => b.boardId), ...knowledgeBoards]);
  await removeAgentBoards(
    db,
    agent.accountId,
    agent.userId,
    current.filter((c) => !wanted.has(c.boardId)).map((c) => c.boardId),
  );
  for (const b of boards) {
    await upsertAgentBoard(db, {
      accountId: agent.accountId,
      boardId: b.boardId,
      userId: agent.userId,
      level: b.level,
      addedBy: by.user.id,
    });
    if (b.workspaceKind === 'closed')
      await ensureWorkspaceMember(db, {
        id: newId(),
        accountId: agent.accountId,
        workspaceId: b.workspaceId,
        userId: agent.userId,
        addedBy: by.user.id,
      });
  }
};

const event = (
  db: Db,
  a: Actor,
  meta: RequestMeta | null,
  action: 'created' | 'updated' | 'deleted',
  agent: AgentRow,
  payload: Record<string, unknown> = {},
) =>
  Promise.all([
    recordEvent(db, {
      accountId: agent.accountId,
      type: `agent.${action}`,
      actorId: a.user.id,
      requestId: a.requestId ?? meta?.requestId ?? null,
      meta: { agent_id: agent.id, name: agent.name, ...payload },
    }),
    recordAudit(db, {
      accountId: agent.accountId,
      actorId: a.user.id,
      action: `agent.${action}`,
      targetType: 'agent',
      targetId: agent.id,
      payload: { name: agent.name, ...payload },
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    }),
  ]);

// ---- create / update / delete ----

/** The trigger scope names only boards of the agent (a board taken away leaves the scope too). */
const scopeTriggers = (triggers: unknown, boardIds: string[]) => {
  const t = agentTriggersSchema.parse(triggers ?? {});
  return { ...t, board_ids: t.board_ids.filter((id) => boardIds.includes(id)) };
};

const insertAgentTx = async (
  tx: Db,
  a: Actor,
  input: NewAgentInput,
  boards: Awaited<ReturnType<typeof checkBoards>>,
  templateKey: string | null,
) => {
  const id = newId();
  const userId = newId();
  await tx.insert(users).values({
    id: userId,
    email: `agent-${userId.toLowerCase()}@agents.bines.invalid`,
    name: input.name,
    image: animalAvatarDataUrl(input.avatar),
    isService: true,
  });
  await tx.insert(accountMembers).values({
    id: newId(),
    accountId: a.ctx.accountId,
    userId,
    role: 'member',
    status: 'active',
    invitedBy: a.user.id,
    joinedAt: new Date(),
  });
  const [row] = await insertAgent(tx, {
    id,
    accountId: a.ctx.accountId,
    userId,
    name: input.name,
    avatar: input.avatar,
    role: input.role,
    instructions: input.instructions,
    connectionId: input.connection_id,
    model: input.model,
    effort: input.effort,
    tools: [...new Set(input.tools)],
    approvalTools: [...new Set(input.approval_tools)],
    approvalMode: input.approval_mode,
    limits: input.limits,
    triggers: scopeTriggers(
      input.triggers,
      boards.map((b) => b.boardId),
    ),
    isActive: input.is_active,
    webSearch: input.web_search ? nextWebSearch(a, true, webSearchOf(null)) : webSearchOf(null),
    templateKey,
    createdBy: a.user.id,
  });
  await syncBoards(tx, row!, a, boards);
  return row!;
};

/** A new agent's mention trigger when the request does not say (the account's AI setting, on by default). */
const withMentionDefault = async (db: Db, accountId: string, input: ReturnType<typeof createAgentSchema.parse>) => {
  const sent = input.triggers?.mention;
  const mention = typeof sent === 'boolean' ? sent : (await loadAiSettings(db, accountId)).agent_mention_default;
  return { ...input, triggers: agentTriggersSchema.parse({ ...input.triggers, mention }) };
};
type NewAgentInput = Awaited<ReturnType<typeof withMentionDefault>>;

export const createAgent = async (deps: Deps, a: Actor, raw: CreateAgent, meta: RequestMeta) => {
  await assertMayCreate(deps.db, a);
  const parsed = await withMentionDefault(deps.db, a.ctx.accountId, createAgentSchema.parse(raw));
  await assertConnectionAndModel(deps, a.ctx.accountId, parsed.connection_id, parsed.model);
  const input =
    parsed.avatar === AGENT_AVATAR_AUTO
      ? { ...parsed, avatar: await agentPicksAvatar(deps, a.ctx.accountId, parsed) }
      : parsed;
  assertTools(input.tools, input.approval_tools);
  await assertAgentMcpTools(deps.db, a.ctx.accountId, input.tools);
  const boards = await checkBoards(deps.db, a, input.boards);
  const row = await deps.db.transaction(async (tx) => {
    const created = await insertAgentTx(tx, a, input, boards, null);
    await event(tx, a, meta, 'created', created);
    return created;
  });
  return getAgent(deps, a, row.id);
};

export const updateAgent = async (deps: Deps, a: Actor, id: string, raw: UpdateAgent, meta: RequestMeta) => {
  const found = await loadManagedAgent(deps.db, a, id);
  const input = updateAgentSchema.parse(raw);
  const agent = found.a;
  const connectionId = input.connection_id ?? agent.connectionId;
  const model = input.model ?? agent.model;
  if (input.connection_id !== undefined || input.model !== undefined) {
    if (!connectionId) throw new AppError('invalid_value', 'unknown_ai_connection');
    await assertConnectionAndModel(deps, a.ctx.accountId, connectionId, model);
  }
  const avatar =
    input.avatar === AGENT_AVATAR_AUTO
      ? await agentPicksAvatar(deps, a.ctx.accountId, {
          name: input.name ?? agent.name,
          role: input.role ?? agent.role,
          connection_id: connectionId ?? '',
          model,
        })
      : input.avatar;
  const tools = input.tools ?? agent.tools;
  const approvalTools = (input.approval_tools ?? agent.approvalTools).filter((t) => tools.includes(t));
  assertTools(tools, approvalTools);
  // Only remote tools added now are checked: one switched off since stays until the editor removes it (it is not
  // offered to the model meanwhile — agentMcpToolDefs).
  if (input.tools)
    await assertAgentMcpTools(
      deps.db,
      a.ctx.accountId,
      input.tools.filter((x) => !agent.tools.includes(x)),
    );
  // A board change is checked against the person editing — an edit can never grant more than they can do.
  const boards = input.boards ? await checkBoards(deps.db, a, input.boards) : null;
  const changed = Object.keys(input);
  const boardIds = boards
    ? boards.map((b) => b.boardId)
    : (await agentBoardRows(deps.db, agent.accountId, agent.userId)).map((b) => b.boardId);
  const triggers =
    input.triggers !== undefined || boards ? scopeTriggers(input.triggers ?? agent.triggers, boardIds) : undefined;
  const webBefore = webSearchOf(agent.webSearch);
  const webSearch = input.web_search !== undefined ? nextWebSearch(a, input.web_search, webBefore) : null;
  await deps.db.transaction(async (tx) => {
    const [next] = await updateAgentRow(tx, agent.id, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(avatar !== undefined ? { avatar } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.connection_id !== undefined ? { connectionId: input.connection_id } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      tools: [...new Set(tools)],
      approvalTools: [...new Set(approvalTools)],
      ...(input.approval_mode !== undefined ? { approvalMode: input.approval_mode } : {}),
      ...(input.limits !== undefined ? { limits: agentLimitsSchema.parse(input.limits) } : {}),
      ...(triggers ? { triggers } : {}),
      ...(input.is_active !== undefined ? { isActive: input.is_active } : {}),
      ...(webSearch ? { webSearch } : {}),
      revision: agent.revision + 1,
    });
    if (input.name !== undefined) await tx.update(users).set({ name: input.name }).where(eq(users.id, agent.userId));
    if (avatar !== undefined) await syncAgentImage(tx, agent.userId, avatar);
    if (boards) await syncBoards(tx, next!, a, boards);
    await event(tx, a, meta, 'updated', next!, { fields: changed });
    if (webSearch && webSearch.status !== webBefore.status) await webSearchAudit(tx, a, meta, next!, webSearch.status);
  });
  return getAgent(deps, a, agent.id);
};

/** Every web search request, approval and revocation is recorded. */
const webSearchAudit = (
  db: Db,
  a: Actor,
  meta: RequestMeta | null,
  agent: AgentRow,
  status: AgentWebSearch['status'],
) =>
  recordAudit(db, {
    accountId: agent.accountId,
    actorId: a.user.id,
    action: `agent.web_search_${status === 'off' ? 'revoked' : status}`,
    targetType: 'agent',
    targetId: agent.id,
    payload: { name: agent.name },
    ip: meta?.ip ?? null,
    userAgent: meta?.userAgent ?? null,
  });

/** POST /agents/{id}/web-search/{approve|reject} (account admins): decide an agent's request to search the web. */
export const decideAgentWebSearch = async (deps: Deps, a: Actor, id: string, approve: boolean, meta: RequestMeta) => {
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  const { a: agent } = await loadManagedAgent(deps.db, a, id);
  const current = webSearchOf(agent.webSearch);
  if (current.status !== 'requested') throw new AppError('conflict', 'web_search_not_requested');
  const next: AgentWebSearch = {
    ...current,
    status: approve ? 'approved' : 'off',
    decided_by: a.user.id,
    at: new Date().toISOString(),
  };
  await deps.db.transaction(async (tx) => {
    const [row] = await updateAgentRow(tx, agent.id, { webSearch: next, revision: agent.revision + 1 });
    await webSearchAudit(tx, a, meta, row!, next.status);
  });
  return getAgent(deps, a, agent.id);
};

/** Soft delete: the service user leaves the account and its boards; history (runs, activity) stays. */
export const deleteAgent = async (
  deps: Pick<AppDeps, 'db' | 'storage' | 'logger'>,
  a: Actor,
  id: string,
  meta: RequestMeta,
) => {
  const found = await loadManagedAgent(deps.db, a, id);
  const agent = found.a;
  // Its knowledge leaves the index; files uploaded for it leave storage (מ9).
  const knowledge = await listKnowledgeRows(deps.db, agent.accountId, agent.id);
  await deps.db.transaction(async (tx) => {
    if (knowledge.length) {
      await tx
        .update(agentKnowledge)
        .set({ deletedAt: new Date() })
        .where(and(eq(agentKnowledge.agentId, agent.id), isNull(agentKnowledge.deletedAt)));
      await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.agentId, agent.id));
    }
    await updateAgentRow(tx, agent.id, { deletedAt: new Date(), isActive: false });
    await tx
      .update(accountMembers)
      .set({ status: 'deactivated' })
      .where(and(eq(accountMembers.accountId, agent.accountId), eq(accountMembers.userId, agent.userId)));
    const boards = await agentBoardRows(tx, agent.accountId, agent.userId);
    await removeAgentBoards(
      tx,
      agent.accountId,
      agent.userId,
      boards.map((b) => b.boardId),
    );
    await tx
      .update(agentRuns)
      .set({ status: 'cancelled', error: 'agent_deleted', finishedAt: new Date() })
      .where(and(eq(agentRuns.agentId, agent.id), eq(agentRuns.status, 'waiting_approval')));
    await event(tx, a, meta, 'deleted', agent);
  });
  const files = knowledge.flatMap((k) => (k.assetId ? [k.assetId] : []));
  if (files.length) await releaseAssets(deps, agent.accountId, files);
  return { ok: true as const };
};

// ---- starter templates (data: seed/agents/*.json) ----

/** Where the templates live: AGENT_TEMPLATES_DIR, else seed/agents from the working dir or from this file. */
const templatesDir = () => {
  const candidates = [
    process.env.AGENT_TEMPLATES_DIR,
    resolve(process.cwd(), '../../seed/agents'),
    resolve(process.cwd(), 'seed/agents'),
    fileURLToPath(new URL('../../../../../seed/agents', import.meta.url)),
  ].filter((x): x is string => !!x);
  return candidates.find((d) => existsSync(d)) ?? null;
};

export const loadAgentTemplates = (dir = templatesDir()): AgentTemplate[] => {
  if (!dir) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .flatMap((f) => {
      const parsed = agentTemplateSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
      return parsed.success ? [parsed.data] : [];
    });
};

/** The starter templates plus those of the account's installed data packs (D27 ת1) — a pack never overrides one. */
const accountAgentTemplates = async (db: Deps['db'], accountId: string): Promise<AgentTemplate[]> => {
  const base = loadAgentTemplates();
  const keys = new Set(base.map((t) => t.key));
  const extra = (await packAgentTemplates(db, accountId)).flatMap((raw) => {
    const parsed = agentTemplateSchema.safeParse(raw);
    if (!parsed.success || keys.has(parsed.data.key)) return [];
    keys.add(parsed.data.key);
    return [parsed.data];
  });
  return [...base, ...extra];
};

export const listAgentTemplates = async (deps: Deps, a: Actor) => {
  await assertMayCreate(deps.db, a);
  const used = await agentTemplateKeys(deps.db, a.ctx.accountId);
  return {
    data: (await accountAgentTemplates(deps.db, a.ctx.accountId)).map((t) => ({ ...t, added: used.has(t.key) })),
  };
};

/**
 * Adds starter agents from the templates to this account — only when asked, never on their own (D21/D26). They
 * start inactive, in learner mode and without boards: an admin picks boards and switches them on. Templates already
 * added are skipped.
 */
export const seedAgentTemplates = async (
  deps: Deps,
  a: Actor,
  input: { connection_id: string; keys?: string[] },
  meta: RequestMeta,
) => {
  await assertMayCreate(deps.db, a);
  const conn = await findConnection(deps.db, a.ctx.accountId, input.connection_id);
  if (!conn) throw new AppError('invalid_value', 'unknown_ai_connection');
  // The connection's default model, else the newest tool-calling model of its live list (never an id fixed in code).
  const model =
    conn.defaultModel ??
    (deps.aiClient && deps.secrets
      ? await connectionDefaultModel({ aiClient: deps.aiClient, secrets: deps.secrets, db: deps.db }, conn)
      : defaultModelOf({ models: catalogueModels(conn.provider as AiProvider) }, conn));
  if (!model) throw new AppError('invalid_value', 'ai_no_model');
  const used = await agentTemplateKeys(deps.db, a.ctx.accountId);
  const templates = (await accountAgentTemplates(deps.db, a.ctx.accountId)).filter(
    (t) => !used.has(t.key) && (!input.keys || input.keys.includes(t.key)),
  );
  const ids: string[] = [];
  for (const t of templates) {
    const parsed = createAgentSchema.parse({
      name: t.name,
      avatar: t.avatar,
      role: t.role,
      instructions: t.instructions,
      connection_id: conn.id,
      model,
      effort: t.effort,
      tools: t.tools.filter((x) => AGENT_TOOL_NAMES.includes(x)),
      approval_mode: t.approval_mode,
      limits: agentLimitsSchema.parse(t.limits),
      is_active: false,
    });
    const withMention = await withMentionDefault(deps.db, a.ctx.accountId, parsed);
    const row = await deps.db.transaction(async (tx) => {
      const created = await insertAgentTx(tx, a, withMention, [], t.key);
      await event(tx, a, meta, 'created', created, { template: t.key });
      return created;
    });
    ids.push(row.id);
  }
  const all = await listAgents(deps, a);
  return { data: all.data.filter((x) => ids.includes(x.id)) };
};
