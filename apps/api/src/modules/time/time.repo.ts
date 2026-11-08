// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Db } from '../../db/client';
import { columns, items, timeEntries, users } from '../../db/schema';

export type TimeEntryRow = typeof timeEntries.$inferSelect;

const editor = alias(users, 'editor');

/** Entries with the names of their user and editor (log rows). */
const withNames = (db: Db) =>
  db
    .select({
      entry: timeEntries,
      userName: users.name,
      userEmail: users.email,
      editorName: editor.name,
      editorEmail: editor.email,
    })
    .from(timeEntries)
    .leftJoin(users, eq(users.id, timeEntries.userId))
    .leftJoin(editor, eq(editor.id, timeEntries.editedBy));
export type NamedEntry = Awaited<ReturnType<ReturnType<typeof withNames>['execute']>>[number];

export const listItemEntries = (db: Db, itemId: string) =>
  withNames(db)
    .where(and(eq(timeEntries.itemId, itemId), isNull(timeEntries.deletedAt)))
    .orderBy(desc(timeEntries.startedAt));

export const findNamedEntry = async (db: Db, accountId: string, id: string) =>
  (
    await withNames(db)
      .where(and(eq(timeEntries.accountId, accountId), eq(timeEntries.id, id), isNull(timeEntries.deletedAt)))
      .limit(1)
  )[0];

/** A user's running entries in an account, optionally on one item (at most one per cell, by index). */
export const runningEntriesOf = (db: Db, accountId: string, userId: string, itemId?: string) =>
  withNames(db)
    .where(
      and(
        eq(timeEntries.accountId, accountId),
        eq(timeEntries.userId, userId),
        isNull(timeEntries.endedAt),
        isNull(timeEntries.deletedAt),
        itemId ? eq(timeEntries.itemId, itemId) : undefined,
      ),
    )
    .orderBy(desc(timeEntries.startedAt));

export const itemOfEntry = async (db: Db, itemId: string) =>
  (
    await db.select({ id: items.id, name: items.name, boardId: items.boardId }).from(items).where(eq(items.id, itemId))
  )[0];

/** Live entries of one item's column — what its cell cache is computed from. */
export const cellEntries = (db: Db, itemId: string, columnId: string) =>
  db
    .select()
    .from(timeEntries)
    .where(and(eq(timeEntries.itemId, itemId), eq(timeEntries.columnId, columnId), isNull(timeEntries.deletedAt)))
    .orderBy(desc(timeEntries.startedAt));

export const insertEntry = (db: Db, row: typeof timeEntries.$inferInsert) => db.insert(timeEntries).values(row);

export const updateEntry = (db: Db, id: string, patch: Partial<typeof timeEntries.$inferInsert>) =>
  db.update(timeEntries).set(patch).where(eq(timeEntries.id, id));

/**
 * Entries for a board time report (03 §3.3): live entries on live items of these boards, with the item and
 * user names and the local day (`tz`) they started on; optional day range and user.
 */
export const reportEntries = (
  db: Db,
  p: { accountId: string; boardIds: string[]; tz: string; from?: string; to?: string; userId?: string },
) => {
  const day = sql<string>`to_char(${timeEntries.startedAt} at time zone ${p.tz}, 'YYYY-MM-DD')`;
  return db
    .select({
      entry: timeEntries,
      item: items,
      userName: users.name,
      userEmail: users.email,
      day,
      // S-29: the time column's view restriction — the report drops entries of a column the reader may not see.
      columnRestrictedView: columns.restrictedView,
    })
    .from(timeEntries)
    .innerJoin(items, eq(items.id, timeEntries.itemId))
    .innerJoin(columns, eq(columns.id, timeEntries.columnId))
    .leftJoin(users, eq(users.id, timeEntries.userId))
    .where(
      and(
        eq(timeEntries.accountId, p.accountId),
        inArray(timeEntries.boardId, p.boardIds),
        isNull(timeEntries.deletedAt),
        isNull(items.deletedAt),
        p.from ? sql`${day} >= ${p.from}` : undefined,
        p.to ? sql`${day} <= ${p.to}` : undefined,
        p.userId ? eq(timeEntries.userId, p.userId) : undefined,
      ),
    )
    .orderBy(asc(timeEntries.startedAt));
};
