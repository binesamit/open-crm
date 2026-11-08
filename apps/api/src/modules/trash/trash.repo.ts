// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gt, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { insertUnnest } from '../../db/unnest';
import {
  boards,
  columns,
  folders,
  groups,
  items,
  trashEntries,
  updates,
  users,
  views,
  workspaces,
} from '../../db/schema';

export type TrashEntryRow = typeof trashEntries.$inferSelect;
export type TrashObjectType = TrashEntryRow['objectType'];

/** In trash = not restored, not purged, and not yet "deleted permanently" (purge_after moved to now). */
const inTrash = () =>
  and(isNull(trashEntries.restoredAt), isNull(trashEntries.purgedAt), gt(trashEntries.purgeAfter, sql`now()`));

export const insertTrashEntry = (db: Db, row: typeof trashEntries.$inferInsert) => db.insert(trashEntries).values(row);
/** Many trash entries at once (undo of a bulk insert), through `insertUnnest`. */
export const insertTrashEntries = (db: Db, rows: (typeof trashEntries.$inferInsert)[]) =>
  insertUnnest(
    db,
    'trash_entries',
    [
      ['id', 'varchar'],
      ['account_id', 'varchar'],
      ['object_type', 'trash_object_type'],
      ['object_id', 'varchar'],
      ['object_name', 'varchar'],
      ['board_id', 'varchar'],
      ['deleted_by', 'varchar'],
      ['restore_payload', 'jsonb'],
    ],
    rows.map((r) => [
      r.id,
      r.accountId,
      r.objectType,
      r.objectId,
      r.objectName,
      r.boardId,
      r.deletedBy,
      JSON.stringify(r.restorePayload ?? {}),
    ]),
  );

export const findTrashEntry = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(trashEntries)
      .where(and(eq(trashEntries.accountId, accountId), eq(trashEntries.id, id), inTrash()))
      .limit(1)
  )[0];

/** The live trash entry of an object (to offer "restore the board first"). */
export const trashEntryOf = async (db: Db, type: TrashObjectType, objectId: string) =>
  (
    await db
      .select({ id: trashEntries.id })
      .from(trashEntries)
      .where(and(eq(trashEntries.objectType, type), eq(trashEntries.objectId, objectId), inTrash()))
      .limit(1)
  )[0];

/** Newest first; `deletedBy` limits the list to one user's deletions (non-admins, 07 §5.2). */
export const listTrashEntries = (db: Db, accountId: string, deletedBy: string | null) =>
  db
    .select({ entry: trashEntries, deletedByName: users.name, boardName: boards.name })
    .from(trashEntries)
    .leftJoin(users, eq(users.id, trashEntries.deletedBy))
    .leftJoin(boards, eq(boards.id, trashEntries.boardId))
    .where(
      and(
        eq(trashEntries.accountId, accountId),
        inTrash(),
        deletedBy ? eq(trashEntries.deletedBy, deletedBy) : undefined,
      ),
    )
    .orderBy(desc(trashEntries.deletedAt))
    .limit(500);

export const setRestorePayload = (db: Db, id: string, payload: TrashEntryRow['restorePayload']) =>
  db.update(trashEntries).set({ restorePayload: payload }).where(eq(trashEntries.id, id));

export const markRestored = (db: Db, id: string) =>
  db.update(trashEntries).set({ restoredAt: new Date() }).where(eq(trashEntries.id, id));

/** "Delete permanently": the entry leaves the trash now; the worker's purge removes the rows on its next run. */
export const expireTrashEntries = (db: Db, accountId: string, ids: string[] | 'all', deletedBy: string | null) =>
  db
    .update(trashEntries)
    .set({ purgeAfter: new Date() })
    .where(
      and(
        eq(trashEntries.accountId, accountId),
        inTrash(),
        ids === 'all' ? undefined : inArray(trashEntries.id, ids),
        deletedBy ? eq(trashEntries.deletedBy, deletedBy) : undefined,
      ),
    )
    .returning({ id: trashEntries.id });

/** Item names by id, deleted ones too (a file in the trash names the item it came from). */
export const itemNamesByIds = (db: Db, ids: string[]) =>
  ids.length
    ? db.select({ id: items.id, name: items.name }).from(items).where(inArray(items.id, ids))
    : Promise.resolve([] as { id: string; name: string }[]);

// ---- rows in trash (deleted_at set) ----
export const deletedItem = async (db: Db, id: string) =>
  (await db.select().from(items).where(eq(items.id, id)).limit(1))[0];
export const deletedGroup = async (db: Db, id: string) =>
  (await db.select().from(groups).where(eq(groups.id, id)).limit(1))[0];
export const deletedColumn = async (db: Db, id: string) =>
  (await db.select().from(columns).where(eq(columns.id, id)).limit(1))[0];
export const deletedView = async (db: Db, id: string) =>
  (await db.select().from(views).where(eq(views.id, id)).limit(1))[0];
export const deletedUpdate = async (db: Db, id: string) =>
  (await db.select().from(updates).where(eq(updates.id, id)).limit(1))[0];
export const anyBoard = async (db: Db, id: string) =>
  (await db.select().from(boards).where(eq(boards.id, id)).limit(1))[0];
export const anyFolder = async (db: Db, id: string) =>
  (await db.select().from(folders).where(eq(folders.id, id)).limit(1))[0];
export const anyWorkspace = async (db: Db, id: string) =>
  (await db.select().from(workspaces).where(eq(workspaces.id, id)).limit(1))[0];

/** An item and all its descendants (subitems), live ones only — they go to trash together. */
export const liveSubtreeIds = async (db: Db, itemId: string): Promise<string[]> => {
  const res = await db.execute<{ id: string }>(sql`
    with recursive t(id) as (
      select ${itemId}::varchar
      union all
      select i.id from ${items} i join t on i.parent_item_id = t.id where i.deleted_at is null
    )
    select id from t`);
  return (res as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
};

/** `liveSubtreeIds` of many items in one query: root id → the root and its live descendants. */
export const liveSubtreesOf = async (db: Db, rootIds: string[]): Promise<Map<string, string[]>> => {
  const out = new Map<string, string[]>(rootIds.map((id) => [id, []]));
  if (!rootIds.length) return out;
  const res = await db.execute<{ root: string; id: string }>(sql`
    with recursive t(root, id) as (
      select r, r from unnest(${sql.param(rootIds)}::varchar[]) as r
      union all
      select t.root, i.id from ${items} i join t on i.parent_item_id = t.id where i.deleted_at is null
    )
    select root, id from t`);
  for (const r of (res as unknown as { rows: { root: string; id: string }[] }).rows) out.get(r.root)?.push(r.id);
  return out;
};

export const setItemsDeleted = (db: Db, ids: string[], at: Date | null) =>
  ids.length
    ? db
        .update(items)
        .set({ deletedAt: at, updatedAt: new Date() })
        .where(sql`${items.id} = any(${sql.param(ids)}::varchar[])`)
    : Promise.resolve();

export const setUpdateDeleted = (db: Db, id: string, at: Date | null) =>
  db.update(updates).set({ deletedAt: at }).where(eq(updates.id, id));

export const restoreFoldersRows = (db: Db, ids: string[]) =>
  ids.length
    ? db
        .update(folders)
        .set({ deletedAt: null, updatedAt: new Date() })
        .where(and(inArray(folders.id, ids), isNotNull(folders.deletedAt)))
    : Promise.resolve();

/** Boards that were moved to the workspace root when their folder was deleted go back into it. */
export const returnBoardsToFolder = (db: Db, boardIds: string[], folderId: string) =>
  boardIds.length
    ? db
        .update(boards)
        .set({ folderId, updatedAt: new Date() })
        .where(and(inArray(boards.id, boardIds), isNull(boards.folderId)))
    : Promise.resolve();
