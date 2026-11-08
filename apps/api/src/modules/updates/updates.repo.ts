// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  activityLog,
  assets,
  columns,
  items,
  updateLikes,
  updateMentions,
  updates,
  updateViews,
  users,
} from '../../db/schema';

export type UpdateRow = typeof updates.$inferSelect;

export const listItemUpdates = (db: Db, itemId: string) =>
  db
    .select({ update: updates, authorName: users.name, authorEmail: users.email })
    .from(updates)
    .leftJoin(users, eq(users.id, updates.createdBy))
    .where(and(eq(updates.itemId, itemId), isNull(updates.deletedAt)))
    .orderBy(desc(updates.createdAt));

/**
 * Top-level updates (not replies) per live item of a board, for the update-count pill on rows (N4).
 * `visible` = the board's item visibility (`visibilitySql`, items aliased `i`), or null for everything.
 */
export const updateCountsOf = async (db: Db, accountId: string, boardId: string, visible: SQL | null) => {
  const r = await db.execute(sql`
    select u.item_id as id, count(*)::int as n
    from updates u join items i on i.id = u.item_id
    where u.account_id = ${accountId} and u.board_id = ${boardId} and u.parent_update_id is null
      and u.deleted_at is null and i.deleted_at is null and i.archived_at is null
      ${visible ? sql`and ${visible}` : sql``}
    group by u.item_id`);
  return (r as unknown as { rows: { id: string; n: number }[] }).rows;
};

export const findUpdate = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(updates)
      .where(and(eq(updates.accountId, accountId), eq(updates.id, id), isNull(updates.deletedAt)))
      .limit(1)
  )[0];

export const insertUpdate = (db: Db, row: typeof updates.$inferInsert) => db.insert(updates).values(row);

export const editUpdate = (db: Db, id: string, html: string, text: string, json: Record<string, unknown> | null) =>
  db
    .update(updates)
    .set({ bodyHtml: html, bodyText: text, bodyJson: json, editedAt: new Date() })
    .where(eq(updates.id, id));

/** A check box ticked in an update: its body changes, but it is not marked edited. */
export const setUpdateBody = (db: Db, id: string, html: string, json: Record<string, unknown>) =>
  db.update(updates).set({ bodyHtml: html, bodyJson: json }).where(eq(updates.id, id));

export const softDeleteUpdate = (db: Db, id: string) =>
  db.update(updates).set({ deletedAt: new Date() }).where(eq(updates.id, id));

export const replaceMentions = async (
  db: Db,
  accountId: string,
  updateId: string,
  userIds: string[],
  newId: () => string,
) => {
  await db.delete(updateMentions).where(eq(updateMentions.updateId, updateId));
  if (userIds.length) {
    await db.insert(updateMentions).values(userIds.map((userId) => ({ id: newId(), updateId, accountId, userId })));
  }
};

export const mentionsOf = (db: Db, updateIds: string[]) =>
  updateIds.length
    ? db
        .select({ updateId: updateMentions.updateId, userId: updateMentions.userId })
        .from(updateMentions)
        .where(inArray(updateMentions.updateId, updateIds))
    : Promise.resolve([] as { updateId: string; userId: string | null }[]);

export const likesOf = (db: Db, updateIds: string[]) =>
  updateIds.length
    ? db
        .select({ updateId: updateLikes.updateId, userId: updateLikes.userId, reaction: updateLikes.reaction })
        .from(updateLikes)
        .where(inArray(updateLikes.updateId, updateIds))
        .orderBy(asc(updateLikes.createdAt))
    : Promise.resolve([] as { updateId: string; userId: string; reaction: string }[]);

export const react = (db: Db, accountId: string, updateId: string, userId: string, reaction: string) =>
  db.insert(updateLikes).values({ updateId, userId, accountId, reaction }).onConflictDoNothing();

export const unreact = (db: Db, updateId: string, userId: string, reaction: string) =>
  db
    .delete(updateLikes)
    .where(and(eq(updateLikes.updateId, updateId), eq(updateLikes.userId, userId), eq(updateLikes.reaction, reaction)));

/** Columns of these boards whose view is restricted (05 §6.1), deleted ones included — their history stays hidden. */
export const viewRestrictedColumns = (db: Db, boardIds: string[]) =>
  db
    .select({ id: columns.id, restrictedView: columns.restrictedView })
    .from(columns)
    .where(and(inArray(columns.boardId, boardIds), isNotNull(columns.restrictedView)));

const activityFields = {
  id: activityLog.id,
  type: activityLog.type,
  actorId: activityLog.actorId,
  actorName: users.name,
  columnId: activityLog.columnId,
  columnKey: columns.key,
  payload: activityLog.payload,
  createdAt: activityLog.createdAt,
  itemId: activityLog.itemId,
  itemName: items.name,
  batchId: activityLog.batchId,
  undoneAt: activityLog.undoneAt,
};
export type ActivityLogRow = Awaited<ReturnType<typeof listItemActivity>>[number];

/** Item activity (07 §12): newest first, with actor and column key for display. */
export const listItemActivity = (db: Db, accountId: string, itemId: string, limit = 100) =>
  db
    .select(activityFields)
    .from(activityLog)
    .leftJoin(users, eq(users.id, activityLog.actorId))
    .leftJoin(columns, eq(columns.id, activityLog.columnId))
    .leftJoin(items, eq(items.id, activityLog.itemId))
    .where(and(eq(activityLog.accountId, accountId), eq(activityLog.itemId, itemId)))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
    .limit(limit);

/** Filters of the board log (all optional, combined with AND); `actorId: null` = no person (system / automation). */
export type BoardActivityFilter = {
  before?: string;
  actorId?: string | null;
  columnKey?: string;
  types?: string[];
  from?: Date;
  to?: Date;
  q?: string;
};

/** `%q%` for ILIKE, with the wildcards of `q` taken literally. */
const likeOf = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** A board's activity (and its sub-board's), newest first; `before` = an event id to page past. */
export const listBoardActivity = (
  db: Db,
  accountId: string,
  boardIds: string[],
  limit: number,
  f: BoardActivityFilter = {},
) =>
  db
    .select(activityFields)
    .from(activityLog)
    .leftJoin(users, eq(users.id, activityLog.actorId))
    .leftJoin(columns, eq(columns.id, activityLog.columnId))
    .leftJoin(items, eq(items.id, activityLog.itemId))
    .where(
      and(
        eq(activityLog.accountId, accountId),
        inArray(activityLog.boardId, boardIds),
        f.before ? lt(activityLog.id, f.before) : undefined,
        f.actorId === null ? isNull(activityLog.actorId) : f.actorId ? eq(activityLog.actorId, f.actorId) : undefined,
        f.columnKey ? eq(columns.key, f.columnKey) : undefined,
        f.types?.length ? inArray(activityLog.type, f.types) : undefined,
        f.from ? gte(activityLog.createdAt, f.from) : undefined,
        f.to ? lt(activityLog.createdAt, f.to) : undefined,
        f.q
          ? sql`(${items.name} ilike ${likeOf(f.q)} or ${users.name} ilike ${likeOf(f.q)} or ${columns.title} ilike ${likeOf(f.q)} or ${activityLog.payload}::text ilike ${likeOf(f.q)})`
          : undefined,
      ),
    )
    .orderBy(desc(activityLog.id))
    .limit(limit);

/** Copies an item's live updates and replies to another item (duplicate with updates, 07 §4.2). */
export const copyUpdates = async (
  db: Db,
  fromItemId: string,
  toItemId: string,
  toBoardId: string,
  newId: () => string,
) => {
  // Secret updates stay behind: their text is sealed to the original update, never copied.
  const rows = await db
    .select()
    .from(updates)
    .where(and(eq(updates.itemId, fromItemId), isNull(updates.deletedAt), eq(updates.isSecret, false)))
    .orderBy(asc(updates.createdAt));
  const ids = new Map(rows.map((r) => [r.id, newId()]));
  for (const r of rows) {
    await db.insert(updates).values({
      ...r,
      id: ids.get(r.id)!,
      itemId: toItemId,
      boardId: toBoardId,
      parentUpdateId: r.parentUpdateId ? (ids.get(r.parentUpdateId) ?? null) : null,
      emailMessageId: null,
    });
  }
};

/** Who wrote updates on these items (a guest's people list, D22.7). */
export const updateAuthorsOf = async (db: Db, itemIds: string[]) =>
  itemIds.length
    ? (
        await db
          .selectDistinct({ userId: updates.createdBy })
          .from(updates)
          .where(and(inArray(updates.itemId, itemIds), isNull(updates.deletedAt)))
      ).flatMap((r) => (r.userId ? [r.userId] : []))
    : [];

/** Live updates / replies of the account among `ids` (what a "seen" batch may name). */
export const updatesByIds = (db: Db, accountId: string, ids: string[]) =>
  ids.length
    ? db
        .select({ id: updates.id, itemId: updates.itemId, createdBy: updates.createdBy })
        .from(updates)
        .where(and(eq(updates.accountId, accountId), inArray(updates.id, ids), isNull(updates.deletedAt)))
    : Promise.resolve([] as { id: string; itemId: string; createdBy: string | null }[]);

/**
 * Records that `userId` saw these updates on `device` (idempotent: one row per update, user and device; seeing it
 * again moves `last_seen_at`, at most once a minute so a scrolling thread does not rewrite rows).
 */
export const upsertUpdateViews = async (
  db: Db,
  rows: { accountId: string; updateId: string; userId: string; device: string; userAgent: string }[],
): Promise<string[]> => {
  if (!rows.length) return [];
  // r16seen: `xmax = 0` marks a row this statement inserted (a first view, or a new device) — those go live.
  const out = await db
    .insert(updateViews)
    .values(rows)
    .onConflictDoUpdate({
      target: [updateViews.updateId, updateViews.userId, updateViews.device],
      set: { lastSeenAt: sql`now()`, userAgent: sql`excluded.user_agent` },
      setWhere: sql`${updateViews.lastSeenAt} < now() - interval '1 minute'`,
    })
    .returning({ updateId: updateViews.updateId, inserted: sql<boolean>`(xmax = 0)` });
  return [...new Set(out.filter((r) => r.inserted).map((r) => r.updateId))];
};

/** The update's item and board, for the live `update.seen` event (null when it is gone). */
export const updatePlace = async (db: Db, accountId: string, updateId: string) =>
  (
    await db
      .select({ itemId: items.id, boardId: items.boardId, createdBy: updates.createdBy })
      .from(updates)
      .innerJoin(items, eq(items.id, updates.itemId))
      .where(and(eq(updates.accountId, accountId), eq(updates.id, updateId), isNull(updates.deletedAt)))
      .limit(1)
  )[0] ?? null;

/** Every view of these updates with the viewer's name and photo, newest first (the author's are never stored). */
export const viewsOf = (db: Db, accountId: string, updateIds: string[]) =>
  updateIds.length
    ? db
        .select({
          updateId: updateViews.updateId,
          userId: updateViews.userId,
          device: updateViews.device,
          userAgent: updateViews.userAgent,
          lastSeenAt: updateViews.lastSeenAt,
          name: users.name,
          email: users.email,
          image: users.image,
          avatarKey: assets.storageKey,
          avatarName: assets.fileName,
          avatarMime: assets.mime,
        })
        .from(updateViews)
        .innerJoin(users, eq(users.id, updateViews.userId))
        .leftJoin(assets, eq(assets.id, users.avatarAssetId))
        .where(and(eq(updateViews.accountId, accountId), inArray(updateViews.updateId, updateIds)))
        .orderBy(desc(updateViews.lastSeenAt))
    : Promise.resolve([]);
export type UpdateViewRow = Awaited<ReturnType<typeof viewsOf>>[number];
