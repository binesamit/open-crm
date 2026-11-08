// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { newId } from '@bines/shared';
import type { Db } from '../../db/client';
import { boards, columns, dashboards, docs, items, notifications, users } from '../../db/schema';

export type NotificationInsert = typeof notifications.$inferInsert;

export const insertNotifications = async (db: Db, rows: NotificationInsert[]) => {
  if (rows.length) await db.insert(notifications).values(rows);
};

const parentBoards = alias(boards, 'parent_boards');

/** Rows written only for the email (bell off in the settings) stay out of the bell and its count. */
const inBell = sql`coalesce(${notifications.payload}->>'bell', 'true') <> 'false'`;

/** A page of my notifications, newest first, with the names the bell shows (joined, so renames show). */
export const listNotifications = (
  db: Db,
  accountId: string,
  userId: string,
  opts: { before?: string; limit: number; unread?: boolean },
) =>
  db
    .select({
      n: notifications,
      // A user who never set a name (magic-link sign-up) shows as their email.
      actorName: sql<string | null>`coalesce(nullif(${users.name}, ''), ${users.email})`,
      itemName: items.name,
      boardId: sql<string | null>`coalesce(${parentBoards.id}, ${boards.id})`,
      boardName: sql<string | null>`coalesce(${parentBoards.name}, ${boards.name})`,
      docName: docs.name,
      dashboardName: dashboards.name,
    })
    .from(notifications)
    .leftJoin(docs, and(eq(docs.id, notifications.docId), isNull(docs.deletedAt)))
    .leftJoin(dashboards, and(eq(dashboards.id, notifications.dashboardId), isNull(dashboards.deletedAt)))
    .leftJoin(users, eq(users.id, notifications.actorId))
    .leftJoin(items, and(eq(items.id, notifications.itemId), isNull(items.deletedAt)))
    .leftJoin(boards, eq(boards.id, notifications.boardId))
    .leftJoin(parentBoards, eq(parentBoards.id, boards.parentBoardId))
    .where(
      and(
        eq(notifications.accountId, accountId),
        eq(notifications.userId, userId),
        opts.before ? lt(notifications.id, opts.before) : undefined,
        opts.unread ? isNull(notifications.readAt) : undefined,
        inBell,
      ),
    )
    .orderBy(desc(notifications.id))
    .limit(opts.limit);

export const unreadCount = async (db: Db, accountId: string, userId: string) =>
  (
    await db
      .select({ n: count() })
      .from(notifications)
      .where(
        and(
          eq(notifications.accountId, accountId),
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          inBell,
        ),
      )
  )[0]!.n;

/** Marks some (or all, `ids` null) of my unread notifications read. */
export const markRead = (db: Db, accountId: string, userId: string, ids: string[] | null) =>
  db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.accountId, accountId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        ids ? inArray(notifications.id, ids) : undefined,
      ),
    );

/**
 * Tells my other tabs that read state changed (`/me/events`, on commit). Not an activity_log row: reading is
 * personal state, not a change to the account's data.
 */
export const announceRead = (db: Db, accountId: string, userId: string) =>
  db.execute(
    sql`select pg_notify('bines_events', ${JSON.stringify({
      id: newId(),
      account_id: accountId,
      type: 'notification.read',
      user_id: userId,
    })})`,
  );

/** Reading updates in the Inbox reads their notifications too (some, or all of them up to `before`). */
export const markUpdatesRead = (db: Db, accountId: string, userId: string, updateIds: string[] | null, before?: Date) =>
  db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.accountId, accountId),
        eq(notifications.userId, userId),
        isNull(notifications.readAt),
        updateIds ? inArray(notifications.updateId, updateIds) : sql`${notifications.updateId} is not null`,
        before ? sql`${notifications.createdAt} <= ${before}` : undefined,
      ),
    );

export const columnTitle = async (db: Db, columnId: string) =>
  (await db.select({ title: columns.title }).from(columns).where(eq(columns.id, columnId)).limit(1))[0]?.title ?? null;
