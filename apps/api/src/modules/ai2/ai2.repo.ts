// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  aiColumnPending,
  aiColumnRuns,
  aiColumnUsage,
  aiConversations,
  aiMessageFiles,
  aiMessages,
  boards,
  columns,
} from '../../db/schema';

/** AI columns (מ11) and the assistant (מ12): every query filters by account (rule 7). */
export type AiColumnRunRow = typeof aiColumnRuns.$inferSelect;
export type AiConversationRow = typeof aiConversations.$inferSelect;
export type AiMessageRow = typeof aiMessages.$inferSelect;

// ---- column runs ----

export const insertColumnRun = (db: Db, row: typeof aiColumnRuns.$inferInsert) =>
  db.insert(aiColumnRuns).values(row).returning();

export const updateColumnRun = (db: Db, id: string, patch: Partial<typeof aiColumnRuns.$inferInsert>) =>
  db.update(aiColumnRuns).set(patch).where(eq(aiColumnRuns.id, id)).returning();

export const findColumnRun = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(aiColumnRuns)
      .where(and(eq(aiColumnRuns.accountId, accountId), eq(aiColumnRuns.id, id)))
      .limit(1)
  )[0];

export const findColumnRunById = async (db: Db, id: string) =>
  (await db.select().from(aiColumnRuns).where(eq(aiColumnRuns.id, id)).limit(1))[0];

/** A queued run, claimed once (queued → running). */
export const claimColumnRun = async (db: Db, id: string) =>
  (
    await db
      .update(aiColumnRuns)
      .set({ status: 'running' })
      .where(and(eq(aiColumnRuns.id, id), eq(aiColumnRuns.status, 'queued')))
      .returning()
  )[0];

export const recentColumnRuns = (db: Db, accountId: string, columnId: string, limit = 5) =>
  db
    .select()
    .from(aiColumnRuns)
    .where(and(eq(aiColumnRuns.accountId, accountId), eq(aiColumnRuns.columnId, columnId)))
    .orderBy(desc(aiColumnRuns.createdAt))
    .limit(limit);

// ---- column usage ----

export const addColumnUsage = (db: Db, row: { accountId: string; columnId: string; month: string; costUsd: number }) =>
  db
    .insert(aiColumnUsage)
    .values({ ...row, calls: 1 })
    .onConflictDoUpdate({
      target: [aiColumnUsage.columnId, aiColumnUsage.month],
      set: { calls: sql`${aiColumnUsage.calls} + 1`, costUsd: sql`${aiColumnUsage.costUsd} + excluded.cost_usd` },
    });

export const columnMonthUsd = async (db: Db, accountId: string, columnId: string, month: string) =>
  (
    await db
      .select({ usd: aiColumnUsage.costUsd })
      .from(aiColumnUsage)
      .where(
        and(
          eq(aiColumnUsage.accountId, accountId),
          eq(aiColumnUsage.columnId, columnId),
          eq(aiColumnUsage.month, month),
        ),
      )
  )[0]?.usd ?? 0;

// ---- auto-run ----

/** Live auto-run AI columns of a board. */
export const autoRunColumns = (db: Db, accountId: string, boardId: string) =>
  db
    .select()
    .from(columns)
    .where(
      and(
        eq(columns.accountId, accountId),
        eq(columns.boardId, boardId),
        eq(columns.type, 'ai'),
        isNull(columns.deletedAt),
        sql`${columns.settings} ->> 'auto_run' = 'true'`,
      ),
    );

/** (Re)sets the debounce of one cell: the latest change wins, and so does its author. */
export const upsertPending = (db: Db, row: typeof aiColumnPending.$inferInsert) =>
  db
    .insert(aiColumnPending)
    .values(row)
    .onConflictDoUpdate({
      target: [aiColumnPending.itemId, aiColumnPending.columnId],
      // The last change decides: its person, and its token's board limit and scopes (S-64).
      set: {
        dueAt: row.dueAt,
        actorId: row.actorId,
        boardLimit: row.boardLimit ?? null,
        tokenScopes: row.tokenScopes ?? null,
      },
    });

/** Cells whose inputs stopped changing, taken off the list (one claim each). */
export const takeDuePending = (db: Db, now: Date, limit = 50) =>
  db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(aiColumnPending)
      .where(lte(aiColumnPending.dueAt, now))
      .orderBy(asc(aiColumnPending.dueAt))
      .limit(limit);
    for (const r of rows)
      await tx
        .delete(aiColumnPending)
        .where(
          and(
            eq(aiColumnPending.itemId, r.itemId),
            eq(aiColumnPending.columnId, r.columnId),
            eq(aiColumnPending.dueAt, r.dueAt),
          ),
        );
    return rows;
  });

// ---- conversations ----

export const insertConversation = (db: Db, row: typeof aiConversations.$inferInsert) =>
  db.insert(aiConversations).values(row).returning();

export const findConversation = async (db: Db, accountId: string, userId: string, id: string) =>
  (
    await db
      .select()
      .from(aiConversations)
      .where(
        and(
          eq(aiConversations.accountId, accountId),
          eq(aiConversations.userId, userId),
          eq(aiConversations.id, id),
          isNull(aiConversations.deletedAt),
        ),
      )
      .limit(1)
  )[0];

/** One chat's place: at most one of item / board / doc / dashboard, and who answers. */
export type ConversationWhere = {
  boardId: string | null;
  itemId: string | null;
  docId: string | null;
  dashboardId: string | null;
  agentId: string | null;
};

export const listConversations = (db: Db, accountId: string, userId: string, where: ConversationWhere) =>
  db
    .select()
    .from(aiConversations)
    .where(
      and(
        eq(aiConversations.accountId, accountId),
        eq(aiConversations.userId, userId),
        isNull(aiConversations.deletedAt),
        where.boardId ? eq(aiConversations.boardId, where.boardId) : isNull(aiConversations.boardId),
        where.itemId ? eq(aiConversations.itemId, where.itemId) : isNull(aiConversations.itemId),
        where.docId ? eq(aiConversations.docId, where.docId) : isNull(aiConversations.docId),
        where.dashboardId ? eq(aiConversations.dashboardId, where.dashboardId) : isNull(aiConversations.dashboardId),
        where.agentId ? eq(aiConversations.agentId, where.agentId) : isNull(aiConversations.agentId),
      ),
    )
    .orderBy(desc(aiConversations.updatedAt))
    .limit(50);

export const updateConversation = (db: Db, id: string, patch: Partial<typeof aiConversations.$inferInsert>) =>
  db
    .update(aiConversations)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(aiConversations.id, id))
    .returning();

// ---- messages ----

export const listMessages = (db: Db, conversationId: string) =>
  db.select().from(aiMessages).where(eq(aiMessages.conversationId, conversationId)).orderBy(asc(aiMessages.seq));

export const insertMessage = (db: Db, row: typeof aiMessages.$inferInsert) =>
  db.insert(aiMessages).values(row).returning();

/** the files attached to a chat message (kept in use, so the orphan-file sweep leaves them). */
export const insertMessageFiles = (db: Db, rows: (typeof aiMessageFiles.$inferInsert)[]) =>
  rows.length ? db.insert(aiMessageFiles).values(rows).onConflictDoNothing() : Promise.resolve();

export const updateMessage = (db: Db, id: string, patch: Partial<typeof aiMessages.$inferInsert>) =>
  db.update(aiMessages).set(patch).where(eq(aiMessages.id, id)).returning();

/** Compare-and-swap of a message's actions: null when someone changed them since `before` was read. */
export const swapMessageActions = async (db: Db, id: string, before: unknown, after: unknown) =>
  (
    await db
      .update(aiMessages)
      .set({ actions: after as never })
      .where(and(eq(aiMessages.id, id), sql`${aiMessages.actions} = ${JSON.stringify(before)}::jsonb`))
      .returning({ id: aiMessages.id })
  )[0] ?? null;

export const findMessage = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select({ m: aiMessages, c: aiConversations })
      .from(aiMessages)
      .innerJoin(aiConversations, eq(aiConversations.id, aiMessages.conversationId))
      .where(and(eq(aiMessages.accountId, accountId), eq(aiMessages.id, id), isNull(aiConversations.deletedAt)))
      .limit(1)
  )[0];

/** Messages a person sent today (UTC), every conversation of the account — the daily limit. */
export const userMessagesSince = async (db: Db, accountId: string, userId: string, since: Date) =>
  (
    await db
      .select({ n: count() })
      .from(aiMessages)
      .innerJoin(aiConversations, eq(aiConversations.id, aiMessages.conversationId))
      .where(
        and(
          eq(aiMessages.accountId, accountId),
          eq(aiConversations.userId, userId),
          eq(aiMessages.role, 'user'),
          gte(aiMessages.createdAt, since),
        ),
      )
  )[0]?.n ?? 0;

/** The names of these boards of the account (a dashboard's boards in a chat's context). */
export const boardNames = async (db: Db, accountId: string, ids: string[]) =>
  ids.length
    ? db
        .select({ id: boards.id, name: boards.name })
        .from(boards)
        .where(and(eq(boards.accountId, accountId), inArray(boards.id, ids), isNull(boards.deletedAt)))
    : [];
