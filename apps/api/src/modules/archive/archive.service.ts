// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, rankBetween } from '@bines/shared';
import type { Db } from '../../db/client';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, loadBoardAccess, readableBoardIds } from '../boards/boards.access';
import { listColumns, listGroups } from '../boards/boards.repo';
import { type ItemRow, itemCells, lastItemPosition, updateItemRow } from '../items/items.repo';
import { type Actor, assertAssigned, loadItem } from '../items/items.service';
import { boardVisibility, filterVisible } from '../items/visibility';
import { liveSubtreeIds, liveSubtreesOf } from '../trash/trash.repo';
import { assertDeleteCode } from '../boards/delete-guard';
import {
  activeItemsOfGroup,
  archivedGroup,
  archivedItem,
  archivedSubtreesAt,
  itemsOfGroupArchivedAt,
  listArchivedBoards,
  listArchivedGroups,
  listArchivedItems,
  setBoardArchived,
  setGroupArchived,
  setItemArchived,
} from './archive.repo';

/**
 * Archive (07 §5.1): kept indefinitely, out of the board, lists and queries; back from the archive page or by
 * undo. Same rights as deleting: items `item.delete` (edit_assigned: own items), groups `group.delete`, boards
 * `board.delete` (owner / admin).
 */
export type ArchiveType = 'item' | 'group' | 'board';
const meta = (undoOf?: string) => (undoOf ? { undo_of: undoOf } : undefined);

// ---- items ----
export const archiveItemTx = async (tx: Db, a: Actor, item: ItemRow, batchId: string | null) => {
  // The live subtree goes with the item (D14; audit 2026-10-10 C2): its subitems used to stay in My Work, search
  // and the relation pickers. They come back with it (`archivedSubtreesAt`).
  const ids = await liveSubtreeIds(tx, item.id);
  await setItemArchived(tx, ids, a.user.id);
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'item.archived',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: item.boardId,
    itemId: item.id,
    batchId,
    before: { name: item.name, group_id: item.groupId },
    meta: { item_ids: ids },
  });
};

export const archiveItem = async (db: Db, a: Actor, itemId: string) => {
  const { item, access } = await loadItem(db, a, itemId);
  if (item.archivedAt) throw new AppError('conflict', 'already_archived');
  assertBoard(access, 'item.delete');
  assertAssigned(access, a.user, item, await itemCells(db, item.id), await listColumns(db, item.boardId));
  await assertDeleteCode(db, a, access.board);
  return db.transaction((tx) => archiveItemTx(tx, a, item, null));
};

/** Back to its group — or the board's first group when its group is gone (as a trash restore). */
export const unarchiveItemTx = async (tx: Db, a: Actor, item: ItemRow, undoOf?: string) => {
  if (item.depth === 0) {
    const groups = await listGroups(tx, item.boardId);
    if (!groups.some((g) => g.id === item.groupId)) {
      const first = groups[0];
      if (!first) throw new AppError('not_found', 'Group not found');
      await updateItemRow(tx, item.id, {
        groupId: first.id,
        position: rankBetween(await lastItemPosition(tx, first.id), null),
      });
    }
  }
  // The subitems archived with it come back too (the same archive moment).
  const ids = item.archivedAt ? await archivedSubtreesAt(tx, [item.id], item.archivedAt) : [item.id];
  await setItemArchived(tx, ids.length ? ids : [item.id], null);
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'item.unarchived',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: item.boardId,
    itemId: item.id,
    after: { name: item.name },
    meta: meta(undoOf),
  });
};

// ---- groups ----
export const archiveGroup = async (db: Db, a: Actor, boardId: string, groupId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'group.delete');
  const groups = await listGroups(db, boardId);
  const group = groups.find((g) => g.id === groupId);
  if (!group) throw new AppError('not_found', 'Group not found');
  if (groups.length <= 1) throw new AppError('last_group', 'A board keeps at least one group');
  await assertDeleteCode(db, a, access.board);
  return db.transaction(async (tx) => {
    // The group's items with their live subtrees (D14; audit 2026-10-10 C2).
    const roots = await activeItemsOfGroup(tx, groupId);
    const itemIds = [...new Set([...(await liveSubtreesOf(tx, roots)).values()].flat())];
    await setItemArchived(tx, itemIds, a.user.id);
    await setGroupArchived(tx, groupId, a.user.id);
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'group.archived',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: { id: group.id, title: group.title, color: group.color },
      meta: { item_ids: itemIds },
    });
  });
};

/** The group comes back with the items that were archived with it (`item_ids` of its last archive event). */
export const unarchiveGroupTx = async (
  tx: Db,
  a: Actor,
  group: { id: string; boardId: string; title: string },
  itemIds: string[],
  undoOf?: string,
) => {
  await setGroupArchived(tx, group.id, null);
  await setItemArchived(tx, itemIds, null);
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'group.unarchived',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: group.boardId,
    after: { id: group.id, title: group.title },
    meta: meta(undoOf),
  });
};

// ---- boards ----
export const archiveBoard = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  assertBoard(access, 'board.delete');
  if (access.board.archivedAt) throw new AppError('conflict', 'already_archived');
  return db.transaction(async (tx) => {
    await setBoardArchived(tx, boardId, a.user.id);
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.archived',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: { name: access.board.name },
    });
  });
};

export const unarchiveBoardTx = async (tx: Db, a: Actor, board: { id: string; name: string }, undoOf?: string) => {
  await setBoardArchived(tx, board.id, null);
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'board.unarchived',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: board.id,
    after: { name: board.name },
    meta: meta(undoOf),
  });
};

// ---- the archive page ----
/** Archived items, groups and boards on boards the actor can read, newest first. */
export const listArchive = async (db: Db, a: Actor) => {
  if (a.ctx.role === 'guest') return [];
  const [itemRows, groupRows, boardRows] = await Promise.all([
    listArchivedItems(db, a.ctx.accountId),
    listArchivedGroups(db, a.ctx.accountId),
    listArchivedBoards(db, a.ctx.accountId),
  ]);
  const readable = await readableBoardIds(db, a.ctx, a.user, [
    ...itemRows.map((r) => r.item.boardId),
    ...groupRows.map((r) => r.group.boardId),
    ...boardRows.map((r) => r.board.id),
  ]);
  const by = (id: string | null, name: string | null) => (id ? { id, name: name ?? '' } : null);
  // Archived items follow the board's item visibility too (05 §6).
  const visibleItemIds = new Set<string>();
  for (const boardId of new Set(itemRows.map((r) => r.item.boardId).filter((b) => readable.has(b)))) {
    const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
    const rows = itemRows.filter((r) => r.item.boardId === boardId).map((r) => r.item);
    for (const i of await filterVisible(db, await boardVisibility(db, a, access), rows)) visibleItemIds.add(i.id);
  }
  return [
    ...itemRows
      .filter((r) => visibleItemIds.has(r.item.id))
      .map((r) => ({
        type: 'item' as const,
        id: r.item.id,
        name: r.item.name,
        board_id: r.parentBoardId ?? r.item.boardId,
        board_name: r.boardName,
        archived_at: r.item.archivedAt!.toISOString(),
        archived_by: by(r.item.archivedBy, r.byName),
      })),
    ...groupRows
      .filter((r) => readable.has(r.group.boardId))
      .map((r) => ({
        type: 'group' as const,
        id: r.group.id,
        name: r.group.title,
        board_id: r.group.boardId,
        board_name: r.boardName,
        archived_at: r.group.archivedAt!.toISOString(),
        archived_by: by(r.group.archivedBy, r.byName),
      })),
    ...boardRows
      .filter((r) => readable.has(r.board.id) && !r.board.parentBoardId)
      .map((r) => ({
        type: 'board' as const,
        id: r.board.id,
        name: r.board.name,
        board_id: r.board.id,
        board_name: null,
        archived_at: r.board.archivedAt!.toISOString(),
        archived_by: by(r.board.archivedBy, r.byName),
      })),
  ].sort((x, y) => (x.archived_at < y.archived_at ? 1 : -1));
};

/** "שחזר" on the archive page. */
export const restoreArchived = async (db: Db, a: Actor, type: ArchiveType, id: string) => {
  if (type === 'item') {
    const item = await archivedItem(db, a.ctx.accountId, id);
    if (!item?.archivedAt) throw new AppError('not_found', 'Not in the archive');
    const access = await loadBoardAccess(db, a.ctx, a.user, item.boardId);
    assertBoard(access, 'item.delete');
    await db.transaction((tx) => unarchiveItemTx(tx, a, item));
    return { ok: true as const, board_id: access.board.parentBoardId ?? access.board.id };
  }
  if (type === 'group') {
    const group = await archivedGroup(db, a.ctx.accountId, id);
    if (!group?.archivedAt) throw new AppError('not_found', 'Not in the archive');
    const access = await loadBoardAccess(db, a.ctx, a.user, group.boardId);
    assertBoard(access, 'group.delete');
    // Items archived together with the group carry the same archive moment — and so do their subitems.
    const roots = await itemsOfGroupArchivedAt(db, group.id, group.archivedAt);
    const itemIds = await archivedSubtreesAt(db, roots, group.archivedAt);
    await db.transaction((tx) => unarchiveGroupTx(tx, a, group, itemIds));
    return { ok: true as const, board_id: group.boardId };
  }
  const access = await loadBoardAccess(db, a.ctx, a.user, id);
  if (!access.board.archivedAt) throw new AppError('not_found', 'Not in the archive');
  assertBoard(access, 'board.delete');
  await db.transaction((tx) => unarchiveBoardTx(tx, a, access.board));
  return { ok: true as const, board_id: id };
};
