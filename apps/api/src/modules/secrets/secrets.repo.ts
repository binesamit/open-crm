// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq, gte, inArray, like, lt, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  accountSecretKeys,
  auditLog,
  boards,
  items,
  secretRevealGrants,
  secretUpdateBodies,
  secretValues,
  users,
} from '../../db/schema';

/** Secret columns: the wrapped data keys, the encrypted values, the reveal grants, the log. */

export const findWrappedKey = async (db: Db, accountId: string) =>
  (
    await db
      .select({ wrappedKey: accountSecretKeys.wrappedKey })
      .from(accountSecretKeys)
      .where(eq(accountSecretKeys.accountId, accountId))
      .limit(1)
  )[0]?.wrappedKey;

/** Keeps the first key written when two requests create one at once. */
export const insertWrappedKey = (db: Db, accountId: string, wrappedKey: string) =>
  db.insert(accountSecretKeys).values({ accountId, wrappedKey }).onConflictDoNothing();

export const findSecretValue = async (db: Db, itemId: string, columnId: string) =>
  (
    await db
      .select()
      .from(secretValues)
      .where(and(eq(secretValues.itemId, itemId), eq(secretValues.columnId, columnId)))
      .limit(1)
  )[0];

export const putSecretValue = (db: Db, row: typeof secretValues.$inferInsert) =>
  db
    .insert(secretValues)
    .values(row)
    .onConflictDoUpdate({
      target: [secretValues.itemId, secretValues.columnId],
      set: { ciphertext: row.ciphertext, updatedBy: row.updatedBy, updatedAt: new Date(), boardId: row.boardId },
    });

/** A column's stored values (a check box column's markers follow its settings). */
export const listColumnSecretValues = (db: Db, columnId: string, limit?: number) => {
  const q = db
    .select({
      itemId: secretValues.itemId,
      ciphertext: secretValues.ciphertext,
      updatedBy: secretValues.updatedBy,
      updatedAt: secretValues.updatedAt,
    })
    .from(secretValues)
    .where(eq(secretValues.columnId, columnId));
  return limit ? q.limit(limit) : q;
};

export const deleteSecretValue = (db: Db, itemId: string, columnId: string) =>
  db.delete(secretValues).where(and(eq(secretValues.itemId, itemId), eq(secretValues.columnId, columnId)));

export const findGrant = async (db: Db, userId: string, sessionId: string) =>
  (
    await db
      .select({ verifiedAt: secretRevealGrants.verifiedAt })
      .from(secretRevealGrants)
      .where(and(eq(secretRevealGrants.userId, userId), eq(secretRevealGrants.sessionId, sessionId)))
      .limit(1)
  )[0];

export const putGrant = (db: Db, userId: string, sessionId: string, verifiedAt: Date) =>
  db
    .insert(secretRevealGrants)
    .values({ userId, sessionId, verifiedAt })
    .onConflictDoUpdate({ target: [secretRevealGrants.userId, secretRevealGrants.sessionId], set: { verifiedAt } });

/** Audit rows of an action by one person since a moment (reveals in the last hour; the last alert). */
export const countActions = async (db: Db, accountId: string, actorId: string, action: string, since: Date) =>
  Number(
    (
      await db
        .select({ n: count() })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.accountId, accountId),
            eq(auditLog.actorId, actorId),
            eq(auditLog.action, action),
            gte(auditLog.createdAt, since),
          ),
        )
    )[0]?.n ?? 0,
  );

export type SecretLogFilter = { actorId?: string; boardId?: string; action?: string; from?: Date; to?: Date };

const logWhere = (accountId: string, f: SecretLogFilter) =>
  and(
    eq(auditLog.accountId, accountId),
    f.action ? eq(auditLog.action, `secret.${f.action}`) : like(auditLog.action, 'secret.%'),
    f.actorId ? eq(auditLog.actorId, f.actorId) : undefined,
    f.boardId ? sql`${auditLog.payload}->>'board_id' = ${f.boardId}` : undefined,
    f.from ? gte(auditLog.createdAt, f.from) : undefined,
    f.to ? lt(auditLog.createdAt, f.to) : undefined,
  );

export const listSecretLog = (db: Db, accountId: string, f: SecretLogFilter, limit: number, offset: number) =>
  db
    .select({ row: auditLog, actorName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(logWhere(accountId, f))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit)
    .offset(offset);

export const countSecretLog = async (db: Db, accountId: string, f: SecretLogFilter) =>
  Number((await db.select({ n: count() }).from(auditLog).where(logWhere(accountId, f)))[0]?.n ?? 0);

/** Current names of boards and items (the log keeps the ones of the moment as a fallback). */
export const namesOf = async (db: Db, accountId: string, boardIds: string[], itemIds: string[]) => {
  const [b, i] = await Promise.all([
    boardIds.length
      ? db
          .select({ id: boards.id, name: boards.name })
          .from(boards)
          .where(and(eq(boards.accountId, accountId), inArray(boards.id, boardIds)))
      : [],
    itemIds.length
      ? db
          .select({ id: items.id, name: items.name })
          .from(items)
          .where(and(eq(items.accountId, accountId), inArray(items.id, itemIds)))
      : [],
  ]);
  return { boards: new Map(b.map((r) => [r.id, r.name])), items: new Map(i.map((r) => [r.id, r.name])) };
};

/** A secret update's sealed text. */
export const findUpdateBody = async (db: Db, updateId: string) =>
  (await db.select().from(secretUpdateBodies).where(eq(secretUpdateBodies.updateId, updateId)).limit(1))[0];

export const putUpdateBody = (db: Db, row: typeof secretUpdateBodies.$inferInsert) =>
  db
    .insert(secretUpdateBodies)
    .values(row)
    .onConflictDoUpdate({
      target: secretUpdateBodies.updateId,
      set: { ciphertext: row.ciphertext, updatedBy: row.updatedBy, updatedAt: new Date() },
    });
