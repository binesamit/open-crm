// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { aiConnections, aiUsage, users } from '../../db/schema';

export type AiConnectionRow = typeof aiConnections.$inferSelect;

export const listConnectionRows = (db: Db, accountId: string) =>
  db
    .select({ c: aiConnections, createdByName: users.name })
    .from(aiConnections)
    .leftJoin(users, eq(users.id, aiConnections.createdBy))
    .where(and(eq(aiConnections.accountId, accountId), isNull(aiConnections.deletedAt)))
    .orderBy(asc(aiConnections.createdAt));

export const findConnection = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(aiConnections)
      .where(and(eq(aiConnections.accountId, accountId), eq(aiConnections.id, id), isNull(aiConnections.deletedAt)))
      .limit(1)
  )[0];

export const insertConnection = (db: Db, row: typeof aiConnections.$inferInsert) =>
  db.insert(aiConnections).values(row).returning();

export const updateConnectionRow = (db: Db, id: string, patch: Partial<typeof aiConnections.$inferInsert>) =>
  db
    .update(aiConnections)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(aiConnections.id, id))
    .returning();

/** One model call's usage, added to its day's row (account × day × source × connection × model). */
export const addUsage = (
  db: Db,
  row: {
    accountId: string;
    day: string;
    source: string;
    connectionId: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  },
) =>
  db
    .insert(aiUsage)
    .values({ ...row, calls: 1 })
    .onConflictDoUpdate({
      target: [aiUsage.accountId, aiUsage.day, aiUsage.source, aiUsage.connectionId, aiUsage.model],
      set: {
        calls: sql`${aiUsage.calls} + 1`,
        inputTokens: sql`${aiUsage.inputTokens} + excluded.input_tokens`,
        outputTokens: sql`${aiUsage.outputTokens} + excluded.output_tokens`,
        cacheReadTokens: sql`${aiUsage.cacheReadTokens} + excluded.cache_read_tokens`,
        cacheWriteTokens: sql`${aiUsage.cacheWriteTokens} + excluded.cache_write_tokens`,
        costUsd: sql`${aiUsage.costUsd} + excluded.cost_usd`,
      },
    });

/**
 * Usage rows of [from, to) summed per connection × source × model — what the account pays: help answers (source
 * `help`) served by the platform's own connection are the platform's, never the account's spend.
 */
export const usageBetween = (db: Db, accountId: string, from: string, to: string) =>
  db
    .select({
      connectionId: aiUsage.connectionId,
      source: aiUsage.source,
      model: aiUsage.model,
      calls: sql<number>`sum(${aiUsage.calls})::int`,
      inputTokens: sql<number>`sum(${aiUsage.inputTokens})::bigint`,
      outputTokens: sql<number>`sum(${aiUsage.outputTokens})::bigint`,
      costUsd: sql<number>`sum(${aiUsage.costUsd})`,
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.accountId, accountId),
        gte(aiUsage.day, from),
        lt(aiUsage.day, to),
        sql`not (${aiUsage.source} = 'help' and ${aiUsage.connectionId} not in (select ${aiConnections.id} from ${aiConnections} where ${aiConnections.accountId} = ${accountId}))`,
      ),
    )
    .groupBy(aiUsage.connectionId, aiUsage.source, aiUsage.model);

/** Every connection ever made in the account (deleted too): names for the usage report. */
export const connectionNames = async (db: Db, accountId: string) =>
  new Map(
    (
      await db
        .select({ id: aiConnections.id, name: aiConnections.name })
        .from(aiConnections)
        .where(eq(aiConnections.accountId, accountId))
    ).map((r) => [r.id, r.name]),
  );
