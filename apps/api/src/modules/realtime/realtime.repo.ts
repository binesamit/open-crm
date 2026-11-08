// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { activityLog, itemLinks, items, notifications } from '../../db/schema';

/** An item for the visibility check — deleted ones too, so a restricted viewer still hears that it went away. */
export const itemAnyState = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(items)
      .where(and(eq(items.accountId, accountId), eq(items.id, id)))
      .limit(1)
  )[0];

/**
 * Board events from id `sinceId` on (Last-Event-ID replay), oldest first. By id, not `created_at`: `created_at`
 * is the transaction's start (`now()`), so the rows of a long bulk write that committed after the client dropped
 * all dated before the replay window and were never replayed (audit 2026-10-10, realtime #6). Ids are minted at
 * insert time, so a row written late in a long transaction is found; the slack below covers the rest.
 */
export const boardEventsAfter = (db: Db, accountId: string, boardIds: string[], sinceId: string, limit: number) =>
  db
    .select()
    .from(activityLog)
    .where(
      and(eq(activityLog.accountId, accountId), inArray(activityLog.boardId, boardIds), gte(activityLog.id, sinceId)),
    )
    .orderBy(asc(activityLog.id))
    .limit(limit);

/** A user's notifications from id `sinceId` on (replay on the personal channel), oldest first. */
export const notificationsAfter = (db: Db, accountId: string, userId: string, sinceId: string, limit: number) =>
  db
    .select()
    .from(notifications)
    .where(
      and(eq(notifications.accountId, accountId), eq(notifications.userId, userId), gte(notifications.id, sinceId)),
    )
    .orderBy(asc(notifications.id))
    .limit(limit);

/**
 * Fix: — items on `boardIds` that link to `itemId` through a relation column (their mirrors and relation
 * cells read it), live ones only, at most `limit`.
 */
export const itemsLinkingTo = (db: Db, accountId: string, itemId: string, boardIds: string[], limit: number) =>
  db
    .selectDistinct({ item: items })
    .from(itemLinks)
    .innerJoin(items, eq(items.id, itemLinks.fromItemId))
    .where(
      and(
        eq(itemLinks.accountId, accountId),
        eq(itemLinks.toItemId, itemId),
        inArray(items.boardId, boardIds),
        isNull(items.deletedAt),
      ),
    )
    .limit(limit)
    .then((rows) => rows.map((r) => r.item));

/**
 * r16seen — whether this update is in the user's Inbox (the same rule as `inboxRows`: by someone else, on an item
 * they follow unmuted, or mentioning them), so their open Inbox hears its `update.seen`.
 */
export const inInbox = async (db: Db, accountId: string, userId: string, updateId: string) => {
  const r = await db.execute(sql`
    select 1 from updates u
    where u.account_id = ${accountId} and u.id = ${updateId} and u.deleted_at is null
      and u.created_by is distinct from ${userId}
      and (exists (select 1 from update_mentions m where m.update_id = u.id and m.user_id = ${userId})
        or exists (select 1 from item_followers f where f.item_id = u.item_id and f.user_id = ${userId} and not f.muted))
    limit 1`);
  return (r as unknown as { rows: unknown[] }).rows.length > 0;
};
