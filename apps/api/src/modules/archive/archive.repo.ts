// SPDX-License-Identifier: AGPL-3.0-only
import { and, between, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { boards, groups, items, users } from '../../db/schema';

/** Archive (07 §5.1): rows keep everything, only `archived_at/_by` change; lists and queries skip them. */
export const setItemArchived = (db: Db, ids: string[], by: string | null) =>
  ids.length
    ? db
        .update(items)
        .set({ archivedAt: by ? new Date() : null, archivedBy: by, updatedAt: new Date() })
        .where(and(inArray(items.id, ids), isNull(items.deletedAt)))
    : Promise.resolve();

/**
 * `rootIds` and their descendants archived in the same moment (one `setItemArchived` call stamps one time; a
 * couple of seconds of slack as `itemsOfGroupArchivedAt`): what comes back when an item or a group is restored
 * (audit 2026-10-10 C2 — subitems go to the archive with their parent, D14).
 */
export const archivedSubtreesAt = async (db: Db, rootIds: string[], at: Date): Promise<string[]> => {
  if (!rootIds.length) return [];
  const lo = new Date(at.getTime() - 2000);
  const hi = new Date(at.getTime() + 2000);
  const res = await db.execute<{ id: string }>(sql`
    with recursive t(id) as (
      select r from unnest(${sql.param(rootIds)}::varchar[]) as r
      union all
      select i.id from ${items} i join t on i.parent_item_id = t.id
      where i.deleted_at is null and i.archived_at between ${lo} and ${hi}
    )
    select id from t`);
  return (res as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);
};

/** Live, not yet archived top-level items of a group — they are archived with it. */
export const activeItemsOfGroup = async (db: Db, groupId: string) =>
  (
    await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.groupId, groupId), isNull(items.deletedAt), isNull(items.archivedAt)))
  ).map((r) => r.id);

/** Items archived together with their group (same transaction → within a couple of seconds of it). */
export const itemsOfGroupArchivedAt = async (db: Db, groupId: string, at: Date) =>
  (
    await db
      .select({ id: items.id })
      .from(items)
      .where(
        and(
          eq(items.groupId, groupId),
          isNull(items.deletedAt),
          between(items.archivedAt, new Date(at.getTime() - 2000), new Date(at.getTime() + 2000)),
        ),
      )
  ).map((r) => r.id);

export const setGroupArchived = (db: Db, id: string, by: string | null) =>
  db
    .update(groups)
    .set({ archivedAt: by ? new Date() : null, archivedBy: by, updatedAt: new Date() })
    .where(eq(groups.id, id));

export const setBoardArchived = (db: Db, id: string, by: string | null) =>
  db
    .update(boards)
    .set({ archivedAt: by ? new Date() : null, archivedBy: by, updatedAt: new Date() })
    .where(eq(boards.id, id));

export const archivedItem = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(items)
      .where(and(eq(items.accountId, accountId), eq(items.id, id), isNull(items.deletedAt)))
      .limit(1)
  )[0];

export const archivedGroup = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(groups)
      .where(and(eq(groups.accountId, accountId), eq(groups.id, id), isNull(groups.deletedAt)))
      .limit(1)
  )[0];

/** Everything archived in the account, newest first (the service keeps what the actor may read). */
export const listArchivedItems = (db: Db, accountId: string) =>
  db
    .select({ item: items, byName: users.name, boardName: boards.name, parentBoardId: boards.parentBoardId })
    .from(items)
    .innerJoin(boards, eq(boards.id, items.boardId))
    .leftJoin(users, eq(users.id, items.archivedBy))
    .where(
      and(
        eq(items.accountId, accountId),
        isNotNull(items.archivedAt),
        isNull(items.deletedAt),
        isNull(boards.deletedAt),
      ),
    )
    .orderBy(desc(items.archivedAt))
    .limit(500);

export const listArchivedGroups = (db: Db, accountId: string) =>
  db
    .select({ group: groups, byName: users.name, boardName: boards.name })
    .from(groups)
    .innerJoin(boards, eq(boards.id, groups.boardId))
    .leftJoin(users, eq(users.id, groups.archivedBy))
    .where(
      and(
        eq(groups.accountId, accountId),
        isNotNull(groups.archivedAt),
        isNull(groups.deletedAt),
        isNull(boards.deletedAt),
      ),
    )
    .orderBy(desc(groups.archivedAt))
    .limit(500);

export const listArchivedBoards = (db: Db, accountId: string) =>
  db
    .select({ board: boards, byName: users.name })
    .from(boards)
    .leftJoin(users, eq(users.id, boards.archivedBy))
    .where(and(eq(boards.accountId, accountId), isNotNull(boards.archivedAt), isNull(boards.deletedAt)))
    .orderBy(desc(boards.archivedAt))
    .limit(500);
