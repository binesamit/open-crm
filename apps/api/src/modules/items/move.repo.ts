// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { cellFiles, cells, itemLinks, items, timeEntries, updates } from '../../db/schema';

/**
 * Data of an item that hangs off its board's columns — what a move between boards rewrites and what its undo
 * puts back (07 §3.4, §3.7). Stored in the event as JSON, so dates travel as strings.
 */
export type ItemSnapshot = {
  item: {
    board_id: string;
    group_id: string | null;
    parent_item_id: string | null;
    root_item_id: string | null;
    depth: number;
    position: string;
    /** The item's number on its board (item_id column); absent in older events. */
    key_seq?: number | null;
  };
  cells: (typeof cells.$inferSelect)[];
  links: (typeof itemLinks.$inferSelect)[];
  files: (typeof cellFiles.$inferSelect)[];
  time: { id: string; board_id: string; column_id: string }[];
};

export const snapshotItem = async (db: Db, itemId: string): Promise<ItemSnapshot> => {
  const [row] = await db.select().from(items).where(eq(items.id, itemId)).limit(1);
  const [cellRows, linkRows, fileRows, timeRows] = await Promise.all([
    db.select().from(cells).where(eq(cells.itemId, itemId)),
    db.select().from(itemLinks).where(eq(itemLinks.fromItemId, itemId)),
    db.select().from(cellFiles).where(eq(cellFiles.itemId, itemId)),
    db
      .select({ id: timeEntries.id, board_id: timeEntries.boardId, column_id: timeEntries.columnId })
      .from(timeEntries)
      .where(eq(timeEntries.itemId, itemId)),
  ]);
  return {
    item: {
      board_id: row!.boardId,
      group_id: row!.groupId,
      parent_item_id: row!.parentItemId,
      root_item_id: row!.rootItemId,
      depth: row!.depth,
      position: row!.position,
      key_seq: row!.keySeq,
    },
    cells: cellRows,
    links: linkRows,
    files: fileRows,
    time: timeRows,
  };
};

export const placeItem = (db: Db, itemId: string, p: ItemSnapshot['item']) =>
  db
    .update(items)
    .set({
      boardId: p.board_id,
      groupId: p.group_id,
      parentItemId: p.parent_item_id,
      rootItemId: p.root_item_id,
      depth: p.depth,
      position: p.position,
      // An item number belongs to its board: given when the caller says (a move between boards, its undo).
      ...(p.key_seq !== undefined ? { keySeq: p.key_seq } : {}),
      updatedAt: new Date(),
    })
    .where(eq(items.id, itemId));

/** A cell to another column (and board): a new row, its files repointed, the old row gone. */
export const moveCell = async (db: Db, cell: ItemSnapshot['cells'][number], toColumnId: string, toBoardId: string) => {
  await db.insert(cells).values({ ...cell, columnId: toColumnId, boardId: toBoardId, updatedAt: new Date() });
  await db
    .update(cellFiles)
    .set({ columnId: toColumnId })
    .where(and(eq(cellFiles.itemId, cell.itemId), eq(cellFiles.columnId, cell.columnId)));
  await db.delete(cells).where(and(eq(cells.itemId, cell.itemId), eq(cells.columnId, cell.columnId)));
};

export const dropCell = (db: Db, itemId: string, columnId: string) =>
  db.delete(cells).where(and(eq(cells.itemId, itemId), eq(cells.columnId, columnId)));

export const moveLinks = (db: Db, itemId: string, fromColumnId: string, toColumnId: string | null) =>
  toColumnId
    ? db
        .update(itemLinks)
        .set({ columnId: toColumnId })
        .where(and(eq(itemLinks.fromItemId, itemId), eq(itemLinks.columnId, fromColumnId)))
    : db.delete(itemLinks).where(and(eq(itemLinks.fromItemId, itemId), eq(itemLinks.columnId, fromColumnId)));

export const moveTimeEntries = (db: Db, itemId: string, fromColumnId: string, toColumnId: string, toBoardId: string) =>
  db
    .update(timeEntries)
    .set({ columnId: toColumnId, boardId: toBoardId })
    .where(and(eq(timeEntries.itemId, itemId), eq(timeEntries.columnId, fromColumnId)));

export const moveUpdates = (db: Db, itemId: string, toBoardId: string) =>
  db.update(updates).set({ boardId: toBoardId }).where(eq(updates.itemId, itemId));

/** Undo: the item's cells, links, files and time entries exactly as in the snapshot. */
export const restoreSnapshot = async (db: Db, itemId: string, s: ItemSnapshot) => {
  await placeItem(db, itemId, s.item);
  await db.delete(cells).where(eq(cells.itemId, itemId)); // cascades cell_files
  await db.delete(itemLinks).where(eq(itemLinks.fromItemId, itemId));
  const date = (v: unknown) => (v ? new Date(v as string) : null);
  if (s.cells.length) {
    await db.insert(cells).values(
      s.cells.map((c) => ({
        ...c,
        dateValue: date(c.dateValue),
        dateEndValue: date(c.dateEndValue),
        updatedAt: date(c.updatedAt) ?? new Date(),
      })),
    );
  }
  if (s.links.length) {
    await db.insert(itemLinks).values(s.links.map((l) => ({ ...l, createdAt: date(l.createdAt) ?? new Date() })));
  }
  if (s.files.length) {
    await db.insert(cellFiles).values(s.files.map((f) => ({ ...f, createdAt: date(f.createdAt) ?? new Date() })));
  }
  for (const te of s.time) {
    await db.update(timeEntries).set({ boardId: te.board_id, columnId: te.column_id }).where(eq(timeEntries.id, te.id));
  }
  await moveUpdates(db, itemId, s.item.board_id);
};

/** Live descendants of an item, top-down (so parents move before their children). */
export const descendantsOf = async (db: Db, itemId: string) => {
  const out: (typeof items.$inferSelect)[] = [];
  let level = [itemId];
  while (level.length) {
    const rows = await db.select().from(items).where(inArray(items.parentItemId, level));
    const live = rows.filter((r) => !r.deletedAt);
    out.push(...live);
    level = live.map((r) => r.id);
  }
  return out;
};
