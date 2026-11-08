// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cells, items } from '../../db/schema';

/** Every stored value of one column on live (not archived, not trashed) items — the find-by-value candidates. */
export const columnCellValues = (db: Db, boardId: string, columnId: string) =>
  db
    .select({ itemId: cells.itemId, value: cells.value, text: cells.textValue })
    .from(cells)
    .innerJoin(items, eq(items.id, cells.itemId))
    .where(
      and(eq(cells.columnId, columnId), eq(items.boardId, boardId), isNull(items.deletedAt), isNull(items.archivedAt)),
    );

/** Item names of a board (live items) — find by `name`. */
export const boardItemNames = (db: Db, boardId: string) =>
  db
    .select({ itemId: items.id, text: items.name })
    .from(items)
    .where(and(eq(items.boardId, boardId), isNull(items.deletedAt), isNull(items.archivedAt)));

/** The live (not archived, not trashed) items right under an item — its subitems. */
export const childItems = (db: Db, parentItemId: string) =>
  db
    .select({ id: items.id, boardId: items.boardId })
    .from(items)
    .where(and(eq(items.parentItemId, parentItemId), isNull(items.deletedAt), isNull(items.archivedAt)));
