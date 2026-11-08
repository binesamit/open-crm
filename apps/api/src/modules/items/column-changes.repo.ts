// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { activityLog, cells } from '../../db/schema';

/** The last change of one column of one item. `columnId` null = the item's name (an `item.renamed` event). */
export type ColumnChangeRow = { itemId: string; columnId: string | null; at: Date; by: string | null };

type Raw = { item_id: string; column_id: string | null; at: Date | string; by: string | null };
const toRow = (r: Raw): ColumnChangeRow => ({
  itemId: r.item_id,
  columnId: r.column_id,
  at: r.at instanceof Date ? r.at : new Date(r.at),
  by: r.by,
});

/**
 * r23ui — the last change of each (item, column) of `columnIds`, for a "last updated" column that watches chosen
 * columns (a "last modified time" of specific fields). Two sources, the later wins (Calculator):
 * - `cells.updated_at / updated_by` — kept on every write already (a set value; survives a purged activity log and
 *   covers imports, which write cells without events);
 * - the latest `cell.changed` event of those columns in `activity_log` — the only trace of a CLEARED cell (clearing
 *   deletes the cell row). `withName`: `item.renamed` events too (the name column is not a cell).
 * Only boards with such a column pay for this. `itemIds` absent = every item of `boardIds` (a whole-board load: one
 * range of ix_al_board_created / the columns' indexes instead of thousands of ids).
 */
export const lastColumnChanges = async (
  db: Db,
  accountId: string,
  p: { boardIds: string[]; columnIds: string[]; withName: boolean; itemIds?: string[] },
): Promise<ColumnChangeRow[]> => {
  if (!p.boardIds.length || (!p.columnIds.length && !p.withName)) return [];
  const cols = sql.param(p.columnIds);
  const boards = sql.param(p.boardIds);
  const items = p.itemIds ? sql.param(p.itemIds) : null;
  const cellRows = p.columnIds.length
    ? await db.execute(
        sql`select item_id, column_id, updated_at as at, updated_by as by from ${cells}
            where column_id = any(${cols}::varchar[]) and board_id = any(${boards}::varchar[])
            ${items ? sql`and item_id = any(${items}::varchar[])` : sql``}`,
      )
    : { rows: [] };
  const eventRows = await db.execute(
    sql`select distinct on (item_id, column_id) item_id, column_id, created_at as at, actor_id as by
        from ${activityLog}
        where account_id = ${accountId} and board_id = any(${boards}::varchar[]) and item_id is not null
          and ((type = 'cell.changed' and column_id = any(${cols}::varchar[]))
               ${p.withName ? sql`or type = 'item.renamed'` : sql``})
          ${items ? sql`and item_id = any(${items}::varchar[])` : sql``}
        order by item_id, column_id, created_at desc`,
  );
  return [
    ...(cellRows as unknown as { rows: Raw[] }).rows.map(toRow),
    ...(eventRows as unknown as { rows: Raw[] }).rows.map(toRow),
  ];
};
