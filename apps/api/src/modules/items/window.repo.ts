// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cells } from '../../db/schema';

/**
 * Reads for windowed boards (perf review §7.1): raw rows without Drizzle's per-field mapping — an outline of a
 * 30k-item board reads one or a few cells per item, never the whole board.
 */
const rowsOf = <T>(r: unknown) => (r as { rows: T[] }).rows;

/** Live (not deleted, not archived) items of a board. */
export const countBoardItems = async (db: Db, boardId: string) =>
  Number(
    rowsOf<{ n: number }>(
      await db.execute(
        sql`select count(*)::int as n from items where board_id = ${boardId} and deleted_at is null and archived_at is null`,
      ),
    )[0]?.n ?? 0,
  );

export type LightCell = { item_id: string; column_id: string; value: unknown; text_value: string | null };

/** The cells of these columns (internal ids) on a board — what the outline's grouping and summaries read. */
export const boardCellsOfColumns = async (db: Db, boardId: string, columnIds: string[]): Promise<LightCell[]> =>
  columnIds.length
    ? rowsOf<LightCell>(
        await db.execute(
          sql`select item_id, column_id, value, text_value from ${cells}
            where ${cells.boardId} = ${boardId} and ${cells.columnId} = any(${sql.param(columnIds)}::varchar[])`,
        ),
      )
    : [];

export type LightItem = {
  id: string;
  name: string;
  created_at: Date | string;
  created_by: string | null;
  updated_at: Date | string;
};

/** Name, creator and times of a board's live items (a grouping by one of those fields). */
export const boardItemBasics = async (db: Db, boardId: string): Promise<LightItem[]> =>
  rowsOf<LightItem>(
    await db.execute(
      sql`select id, name, created_at, created_by, updated_at from items
        where board_id = ${boardId} and deleted_at is null and archived_at is null`,
    ),
  );
