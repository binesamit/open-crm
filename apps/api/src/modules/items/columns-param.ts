// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';

/**
 * Field selection on item reads (`?columns=` on `GET /boards/:id/items`, `columns` of the MCP `query_items` tool):
 * only these columns in `cells`. Same rules everywhere — at most ITEM_COLUMNS_MAX ids of at most
 * ITEM_COLUMN_ID_MAX characters; ids the board does not have (or the caller may not see) are simply left out.
 * The selection runs on cells that are already permission-filtered — it never shows more than the caller may read.
 */
export const ITEM_COLUMNS_MAX = 50;
export const ITEM_COLUMN_ID_MAX = 64;

/** `a,b , c` → `['a','b','c']` (deduplicated); undefined when no selection was asked. Throws 400 past the caps. */
export const parseColumnsParam = (raw: string | undefined): string[] | undefined => {
  if (raw === undefined) return undefined;
  const list = [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (list.length > ITEM_COLUMNS_MAX)
    throw new AppError('validation_failed', `columns: at most ${ITEM_COLUMNS_MAX} column ids`);
  const long = list.find((s) => s.length > ITEM_COLUMN_ID_MAX);
  if (long !== undefined)
    throw new AppError('validation_failed', `columns: a column id is at most ${ITEM_COLUMN_ID_MAX} characters`);
  return list;
};

/** Only the selected cells (no selection → all of them). */
export const selectCells = <C>(cells: Record<string, C>, columns: readonly string[] | undefined): Record<string, C> => {
  if (!columns) return cells;
  const wanted = new Set(columns);
  return Object.fromEntries(Object.entries(cells).filter(([k]) => wanted.has(k)));
};
