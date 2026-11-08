// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  agentApprovals,
  agentRuns,
  agentRunSteps,
  agents,
  aiConnections,
  boardMembers,
  boards,
  users,
  workspaceMembers,
} from '../../db/schema';

/** Agents' tables (מ6–מ7). Every query filters by account (CLAUDE.md rule 7). */
export type AgentRow = typeof agents.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentStepRow = typeof agentRunSteps.$inferSelect;
export type AgentApprovalRow = typeof agentApprovals.$inferSelect;

// ---- agents ----

export const listAgentRows = (db: Db, accountId: string, createdBy?: string) =>
  db
    .select({ a: agents, connectionName: aiConnections.name, createdByName: users.name })
    .from(agents)
    .leftJoin(aiConnections, and(eq(aiConnections.id, agents.connectionId), isNull(aiConnections.deletedAt)))
    .leftJoin(users, eq(users.id, agents.createdBy))
    .where(
      and(
        eq(agents.accountId, accountId),
        isNull(agents.deletedAt),
        createdBy ? eq(agents.createdBy, createdBy) : undefined,
      ),
    )
    .orderBy(asc(agents.createdAt));

export const findAgent = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select({ a: agents, connectionName: aiConnections.name, createdByName: users.name })
      .from(agents)
      .leftJoin(aiConnections, and(eq(aiConnections.id, agents.connectionId), isNull(aiConnections.deletedAt)))
      .leftJoin(users, eq(users.id, agents.createdBy))
      .where(and(eq(agents.accountId, accountId), eq(agents.id, id), isNull(agents.deletedAt)))
      .limit(1)
  )[0];

export const insertAgent = (db: Db, row: typeof agents.$inferInsert) => db.insert(agents).values(row).returning();

export const updateAgentRow = (db: Db, id: string, patch: Partial<typeof agents.$inferInsert>) =>
  db
    .update(agents)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(agents.id, id))
    .returning();

export const agentTemplateKeys = async (db: Db, accountId: string) =>
  new Set(
    (
      await db
        .select({ key: agents.templateKey })
        .from(agents)
        .where(and(eq(agents.accountId, accountId), isNull(agents.deletedAt)))
    ).flatMap((r) => (r.key ? [r.key] : [])),
  );

// ---- boards (the agent user's subscriptions) ----

export const agentBoardRows = (db: Db, accountId: string, userId: string) =>
  db
    .select({ boardId: boardMembers.boardId, level: boardMembers.level, name: boards.name })
    .from(boardMembers)
    .innerJoin(boards, eq(boards.id, boardMembers.boardId))
    .where(and(eq(boardMembers.accountId, accountId), eq(boardMembers.userId, userId), isNull(boards.deletedAt)))
    .orderBy(asc(boards.name));

export const removeAgentBoards = (db: Db, accountId: string, userId: string, boardIds: string[]) =>
  boardIds.length
    ? db
        .delete(boardMembers)
        .where(
          and(
            eq(boardMembers.accountId, accountId),
            eq(boardMembers.userId, userId),
            inArray(boardMembers.boardId, boardIds),
          ),
        )
    : Promise.resolve();

export const upsertAgentBoard = (
  db: Db,
  row: { accountId: string; boardId: string; userId: string; level: 'viewer' | 'contributor'; addedBy: string },
) =>
  db
    .insert(boardMembers)
    .values({ ...row, role: 'subscriber' })
    .onConflictDoUpdate({ target: [boardMembers.boardId, boardMembers.userId], set: { level: row.level } });

export const ensureWorkspaceMember = (
  db: Db,
  row: { id: string; accountId: string; workspaceId: string; userId: string; addedBy: string },
) =>
  db
    .insert(workspaceMembers)
    .values({ ...row, role: 'member' })
    .onConflictDoNothing();

// ---- runs ----

export const insertRun = (db: Db, row: typeof agentRuns.$inferInsert) => db.insert(agentRuns).values(row).returning();

export const findRun = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.accountId, accountId), eq(agentRuns.id, id)))
      .limit(1)
  )[0];

export const findRunById = async (db: Db, id: string) =>
  (await db.select().from(agentRuns).where(eq(agentRuns.id, id)).limit(1))[0];

export const updateRunRow = (db: Db, id: string, patch: Partial<typeof agentRuns.$inferInsert>) =>
  db.update(agentRuns).set(patch).where(eq(agentRuns.id, id)).returning();

export const bumpToolCalls = (db: Db, id: string) =>
  db
    .update(agentRuns)
    .set({ toolCalls: sql`${agentRuns.toolCalls} + 1` })
    .where(eq(agentRuns.id, id));

/** Claims a queued run (one worker wins). */
export const claimRun = async (db: Db, id: string) =>
  (
    await db
      .update(agentRuns)
      .set({ status: 'running', startedAt: sql`coalesce(${agentRuns.startedAt}, now())` })
      .where(and(eq(agentRuns.id, id), eq(agentRuns.status, 'queued')))
      .returning()
  )[0];

/** Live, active agents whose service users are among `userIds` (a mention / an assignment names users). */
export const activeAgentsOfUsers = (db: Db, accountId: string, userIds: string[]) =>
  userIds.length
    ? db
        .select()
        .from(agents)
        .where(
          and(
            eq(agents.accountId, accountId),
            inArray(agents.userId, userIds),
            eq(agents.isActive, true),
            isNull(agents.deletedAt),
          ),
        )
    : Promise.resolve([] as AgentRow[]);

/** A run this agent already has for this event (a redelivered dispatch job starts nothing twice). */
export const runForEvent = async (db: Db, agentId: string, eventId: string) =>
  (
    await db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.agentId, agentId), sql`${agentRuns.meta} ->> 'event_id' = ${eventId}`))
      .limit(1)
  )[0];

export const listRunRows = (
  db: Db,
  accountId: string,
  opts: { agentId?: string; agentIds?: string[]; status?: string; before?: string; limit: number },
) =>
  db
    .select({ r: agentRuns, agentName: agents.name, requestedByName: users.name })
    .from(agentRuns)
    .innerJoin(agents, eq(agents.id, agentRuns.agentId))
    .leftJoin(users, eq(users.id, agentRuns.requestedBy))
    .where(
      and(
        eq(agentRuns.accountId, accountId),
        opts.agentId ? eq(agentRuns.agentId, opts.agentId) : undefined,
        opts.agentIds ? inArray(agentRuns.agentId, opts.agentIds.length ? opts.agentIds : ['-']) : undefined,
        opts.status ? eq(agentRuns.status, opts.status) : undefined,
        opts.before ? lt(agentRuns.id, opts.before) : undefined,
      ),
    )
    .orderBy(desc(agentRuns.id))
    .limit(opts.limit);

/** Runs that count toward the day quota (dry runs and skipped ones do not). */
export const runsSince = async (db: Db, agentId: string, since: Date) =>
  Number(
    (
      await db
        .select({ n: count() })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.agentId, agentId),
            gte(agentRuns.createdAt, since),
            eq(agentRuns.dryRun, false),
            sql`${agentRuns.status} <> 'skipped'`,
          ),
        )
    )[0]?.n ?? 0,
  );

/** Per agent: runs in the last 7 days, cost this month, last run. */
export const agentStats = async (db: Db, accountId: string, since7d: Date, monthStart: Date) => {
  const rows = await db
    .select({
      agentId: agentRuns.agentId,
      runs7d: sql<number>`count(*) filter (where ${agentRuns.createdAt} >= ${since7d.toISOString()}::timestamptz)::int`,
      costMonth: sql<number>`coalesce(sum(${agentRuns.costUsd}) filter (where ${agentRuns.createdAt} >= ${monthStart.toISOString()}::timestamptz), 0)`,
      lastRun: sql<string | null>`max(${agentRuns.createdAt})`,
    })
    .from(agentRuns)
    .where(eq(agentRuns.accountId, accountId))
    .groupBy(agentRuns.agentId);
  const pending = await db
    .select({ agentId: agentApprovals.agentId, n: sql<number>`count(*)::int` })
    .from(agentApprovals)
    .where(and(eq(agentApprovals.accountId, accountId), eq(agentApprovals.status, 'pending')))
    .groupBy(agentApprovals.agentId);
  return { rows, pending: new Map(pending.map((p) => [p.agentId, Number(p.n)])) };
};

// ---- steps ----

export const listSteps = (db: Db, runId: string) =>
  db.select().from(agentRunSteps).where(eq(agentRunSteps.runId, runId)).orderBy(asc(agentRunSteps.seq));

export const insertStep = (db: Db, row: typeof agentRunSteps.$inferInsert) =>
  db.insert(agentRunSteps).values(row).returning();

// ---- approvals ----

export const insertApproval = (db: Db, row: typeof agentApprovals.$inferInsert) =>
  db.insert(agentApprovals).values(row).onConflictDoNothing().returning();

export const runApprovals = (db: Db, runId: string) =>
  db
    .select({ p: agentApprovals, decidedByName: users.name })
    .from(agentApprovals)
    .leftJoin(users, eq(users.id, agentApprovals.decidedBy))
    .where(eq(agentApprovals.runId, runId))
    .orderBy(asc(agentApprovals.createdAt));

export const findApproval = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(agentApprovals)
      .where(and(eq(agentApprovals.accountId, accountId), eq(agentApprovals.id, id)))
      .limit(1)
  )[0];

export const listApprovalRows = (
  db: Db,
  accountId: string,
  opts: { status?: string; agentIds?: string[]; limit: number },
) =>
  db
    .select({ p: agentApprovals, agentName: agents.name, decidedByName: users.name })
    .from(agentApprovals)
    .innerJoin(agents, eq(agents.id, agentApprovals.agentId))
    .leftJoin(users, eq(users.id, agentApprovals.decidedBy))
    .where(
      and(
        eq(agentApprovals.accountId, accountId),
        opts.status ? eq(agentApprovals.status, opts.status) : undefined,
        opts.agentIds ? inArray(agentApprovals.agentId, opts.agentIds.length ? opts.agentIds : ['-']) : undefined,
      ),
    )
    .orderBy(desc(agentApprovals.createdAt))
    .limit(opts.limit);

/** Decides a pending approval (only once: the status guard makes a double click a no-op). */
export const decideApprovalRow = async (
  db: Db,
  id: string,
  patch: { status: 'approved' | 'rejected' | 'expired'; decidedBy?: string | null; reason?: string | null },
) =>
  (
    await db
      .update(agentApprovals)
      .set({ ...patch, decidedAt: new Date() })
      .where(and(eq(agentApprovals.id, id), eq(agentApprovals.status, 'pending')))
      .returning()
  )[0];

export const dueApprovals = (db: Db, now: Date, limit = 200) =>
  db
    .select()
    .from(agentApprovals)
    .where(and(eq(agentApprovals.status, 'pending'), lt(agentApprovals.expiresAt, now)))
    .limit(limit);
