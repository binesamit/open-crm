// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { itemKeys, items } from '../../db/schema';

export type ItemKeyRow = typeof itemKeys.$inferSelect;

/** The board's item-number sequence (one per board — 03 §2.19). */
export const itemKeyOfBoard = async (db: Db, boardId: string): Promise<ItemKeyRow | undefined> =>
  (await db.select().from(itemKeys).where(eq(itemKeys.boardId, boardId)).limit(1))[0];

/** A non-empty prefix used by another board of the account. */
export const prefixUsedElsewhere = async (db: Db, accountId: string, prefix: string, boardId: string) =>
  prefix !== '' &&
  (
    await db
      .select({ id: itemKeys.id })
      .from(itemKeys)
      .where(and(eq(itemKeys.accountId, accountId), eq(itemKeys.prefix, prefix), ne(itemKeys.boardId, boardId)))
      .limit(1)
  ).length > 0;

export const insertItemKeyRow = (db: Db, row: typeof itemKeys.$inferInsert) => db.insert(itemKeys).values(row);

export const updateItemKeyRow = (
  db: Db,
  id: string,
  patch: Partial<Pick<ItemKeyRow, 'columnId' | 'prefix' | 'padding' | 'nextSeq'>>,
) =>
  db
    .update(itemKeys)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(itemKeys.id, id));

/** The highest number an item of the board has (trashed and archived items keep theirs), or null. */
export const maxKeySeq = async (db: Db, boardId: string): Promise<number | null> => {
  const row = (
    await db
      .select({ max: sql<number | null>`max(${items.keySeq})` })
      .from(items)
      .where(eq(items.boardId, boardId))
  )[0];
  return row?.max == null ? null : Number(row.max);
};

/**
 * Numbers the board's items that have no number yet, in creation order, from `first` on (one statement, any board
 * size). Returns how many were numbered.
 */
export const numberUnkeyedItems = async (db: Db, boardId: string, first: number): Promise<number> => {
  const rows = await db.execute(sql`
    update ${items} set key_seq = n.seq
    from (
      select id, (row_number() over (order by created_at, id))::int + ${first - 1} as seq
      from ${items}
      where board_id = ${boardId} and key_seq is null
    ) n
    where ${items.id} = n.id
    returning ${items.id}`);
  return (rows as unknown as { rows: unknown[] }).rows.length;
};
