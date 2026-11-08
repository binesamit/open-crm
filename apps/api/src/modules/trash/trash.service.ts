// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canBoard, newId, rankBetween, type TrashObjectType } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { loadBoardAccess } from '../boards/boards.access';
import { listGroups, updateBoardRow, updateColumnRow, updateGroupRow, updateWorkspaceRow } from '../boards/boards.repo';
import { lastItemPosition, updateItemRow } from '../items/items.repo';
import { repairTwoWayOnRestore } from '../items/relations.service';
import { updateViewRow } from '../views/views.repo';
import { anyDoc, returnDocsToFolder, updateDocRow } from '../docs/docs.repo';
import { writeDocCell } from '../docs/docs.service';
import { anyDashboard, returnDashboardsToFolder, updateDashboardRow } from '../dashboards/dashboards.repo';
import { findAsset, insertCellFiles, versionCounts } from '../files/files.repo';
import { ensureFileCell, syncFileCell, type TrashedCellFile } from '../files/files.service';
import {
  anyBoard,
  anyFolder,
  anyWorkspace,
  deletedColumn,
  deletedGroup,
  deletedItem,
  deletedUpdate,
  deletedView,
  expireTrashEntries,
  findTrashEntry,
  insertTrashEntries,
  insertTrashEntry,
  itemNamesByIds,
  listTrashEntries,
  markRestored,
  restoreFoldersRows,
  returnBoardsToFolder,
  setItemsDeleted,
  setUpdateDeleted,
  type TrashEntryRow,
  trashEntryOf,
} from './trash.repo';

/** What a restore needs beyond `deleted_at` (07 §5.1). */
export type RestorePayload = {
  /** item: the item + subitems deleted with it; group: its items deleted with it. */
  item_ids?: string[];
  /** folder / workspace: nested folders deleted with it. */
  folder_ids?: string[];
  /** folder: boards moved to the workspace root, and the folder each one was in. */
  boards?: { id: string; folder_id: string }[];
  /** folder: docs moved to the workspace root (M8), like its boards. */
  docs?: { id: string; folder_id: string }[];
  /** folder: dashboards moved to the workspace root (M8 ד4). */
  dashboards?: { id: string; folder_id: string }[];
  /** folder: boards that went to trash with it — their own entries, restored with the folder. */
  board_entries?: string[];
  /** file: the cells it was removed from. */
  cells?: TrashedCellFile[];
};

/**
 * Called by every delete-to-trash service inside its transaction (07 §5.1). Returns the entry id, which the
 * delete event carries in `meta.trash_entry_id` so undo can restore through the same path.
 */
export const trashObject = async (
  tx: Db,
  a: Actor,
  o: { type: TrashObjectType; id: string; name: string; boardId?: string | null; payload?: RestorePayload },
) => {
  const id = newId();
  await insertTrashEntry(tx, {
    id,
    accountId: a.ctx.accountId,
    objectType: o.type,
    objectId: o.id,
    objectName: (o.name || '—').slice(0, 255),
    boardId: o.boardId ?? null,
    deletedBy: a.user.id,
    restorePayload: o.payload ?? {},
  });
  return id;
};

/** `trashObject` for many objects at once (a bulk undo trashing thousands of new items): entry ids in order. */
export const trashObjects = async (
  tx: Db,
  a: Actor,
  list: { type: TrashObjectType; id: string; name: string; boardId?: string | null; payload?: RestorePayload }[],
) => {
  const ids = list.map(() => newId());
  await insertTrashEntries(
    tx,
    list.map((o, i) => ({
      id: ids[i]!,
      accountId: a.ctx.accountId,
      objectType: o.type,
      objectId: o.id,
      objectName: (o.name || '—').slice(0, 255),
      boardId: o.boardId ?? null,
      deletedBy: a.user.id,
      restorePayload: o.payload ?? {},
    })),
  );
  return ids;
};

/** Admins see and manage everything in trash; everyone else only what they deleted (07 §5.2). */
const ownerFilter = (a: Actor) => (a.ctx.role === 'admin' ? null : a.user.id);

/** Guests have only their own profile (product fix list): no trash — nothing to list, restore or purge. */
const assertNotGuest = (a: Actor) => {
  if (a.ctx.role === 'guest') throw new AppError('forbidden', 'guest_restricted');
};

export const listTrash = async (db: Db, a: Actor) => {
  assertNotGuest(a);
  return listTrashRows(db, a);
};

const listTrashRows = async (db: Db, a: Actor) => {
  const rows = await listTrashEntries(db, a.ctx.accountId, ownerFilter(a));
  // A file shows the item it was removed from.
  const fileItem = (e: TrashEntryRow) =>
    e.objectType === 'file' ? ((e.restorePayload as RestorePayload).cells?.[0]?.item_id ?? null) : null;
  const itemIds = [...new Set(rows.map((r) => fileItem(r.entry)).filter((id): id is string => !!id))];
  const itemNames = new Map((await itemNamesByIds(db, itemIds)).map((i) => [i.id, i.name]));
  const counts = await versionCounts(
    db,
    rows.filter((r) => r.entry.objectType === 'file').map((r) => r.entry.objectId),
  );
  return rows.map(({ entry: e, deletedByName, boardName }) => {
    const itemId = fileItem(e);
    return {
      id: e.id,
      object_type: e.objectType as TrashObjectType,
      object_id: e.objectId,
      name: e.objectName,
      board_id: e.objectType === 'board' ? null : e.boardId,
      board_name: e.objectType === 'board' ? null : boardName,
      ...(e.objectType === 'file'
        ? {
            item_id: itemId,
            item_name: (itemId && itemNames.get(itemId)) ?? null,
            version_count: counts.get(e.objectId) ?? 1,
          }
        : {}),
      deleted_by: e.deletedBy ? { id: e.deletedBy, name: deletedByName ?? '' } : null,
      deleted_at: e.deletedAt.toISOString(),
      purge_after: e.purgeAfter.toISOString(),
    };
  });
};

const loadEntry = async (db: Db, a: Actor, entryId: string) => {
  assertNotGuest(a);
  const entry = await findTrashEntry(db, a.ctx.accountId, entryId);
  if (!entry || (a.ctx.role !== 'admin' && entry.deletedBy !== a.user.id)) {
    throw new AppError('not_found', 'Not in trash');
  }
  // Deleting it once is not enough: the board it goes back to must still be theirs to edit (lost access → 404).
  if (a.ctx.role !== 'admin' && entry.objectType !== 'board' && entry.objectType !== 'workspace' && entry.boardId) {
    const board = await anyBoard(db, entry.boardId);
    if (board && !board.deletedAt) {
      const access = await loadBoardAccess(db, a.ctx, a.user, entry.boardId).catch(() => null);
      if (!access) throw new AppError('not_found', 'Not in trash');
      // A column or a group is the board's structure: bringing it back takes the right to add one.
      // A file goes back into a cell: the right to edit items.
      const action =
        entry.objectType === 'column'
          ? 'column.create'
          : entry.objectType === 'group'
            ? 'group.create'
            : entry.objectType === 'file'
              ? 'item.update'
              : 'item.delete';
      if (!canBoard(access.perm, action).ok) throw new AppError('forbidden', 'board_permission');
    }
  }
  return entry;
};

/** The parent is in trash too: the UI offers to restore it first (07 §5.2). */
const parentInTrash = async (db: Db, type: TrashObjectType, id: string) => {
  const parent = await trashEntryOf(db, type, id);
  return new AppError('parent_in_trash', `The ${type} is in trash`, {
    parent_type: type,
    parent_entry_id: parent?.id ?? null,
  });
};

const assertBoardLive = async (db: Db, boardId: string | null) => {
  const board = boardId ? await anyBoard(db, boardId) : undefined;
  if (!board) throw new AppError('not_found', 'Board not found');
  if (board.deletedAt) throw await parentInTrash(db, 'board', board.id);
  return board;
};

/**
 * Puts one trash entry back where it was (inside the caller's transaction) and records `<type>.restored`.
 * `undoOf` marks the restore as the compensating event of a delete (07 §5.3).
 */
export const restoreEntryTx = async (tx: Db, a: Actor, entry: TrashEntryRow, undoOf?: string) => {
  const payload = entry.restorePayload as RestorePayload;
  let boardId = entry.boardId;
  let itemId: string | null = null;

  switch (entry.objectType) {
    case 'item': {
      const item = await deletedItem(tx, entry.objectId);
      if (!item) throw new AppError('not_found', 'Item not found');
      await assertBoardLive(tx, item.boardId);
      if (item.parentItemId) {
        const parent = await deletedItem(tx, item.parentItemId);
        if (parent?.deletedAt) throw await parentInTrash(tx, 'item', parent.id);
      }
      const ids = payload.item_ids?.length ? payload.item_ids : [item.id];
      const group = item.groupId ? await deletedGroup(tx, item.groupId) : undefined;
      // A top-level item whose group is gone moves; subitems hang on their parent and have no group.
      if (item.depth === 0 && (!group || group.deletedAt)) {
        // Its group is gone: the item lands at the bottom of the board's first group.
        const first = (await listGroups(tx, item.boardId))[0];
        if (!first) throw new AppError('not_found', 'Group not found');
        await updateItemRow(tx, item.id, {
          groupId: first.id,
          position: rankBetween(await lastItemPosition(tx, first.id), null),
        });
        // Its subitems keep `group_id` NULL (`ck_items_tree`); giving them the group failed the whole restore
        // (audit 2026-10-10, C3).
      }
      await setItemsDeleted(tx, ids, null);
      itemId = item.id;
      boardId = item.boardId;
      break;
    }
    case 'group': {
      const group = await deletedGroup(tx, entry.objectId);
      if (!group) throw new AppError('not_found', 'Group not found');
      await assertBoardLive(tx, group.boardId);
      await updateGroupRow(tx, group.id, { deletedAt: null });
      await setItemsDeleted(tx, payload.item_ids ?? [], null);
      break;
    }
    case 'column': {
      const column = await deletedColumn(tx, entry.objectId);
      if (!column) throw new AppError('not_found', 'Column not found');
      await assertBoardLive(tx, column.boardId);
      await updateColumnRow(tx, column.id, { deletedAt: null });
      // A two-way column pairs again with its partner when it can, else it comes back one-way (03 §2.16).
      await repairTwoWayOnRestore(
        tx,
        { accountId: a.ctx.accountId, actorId: a.user.id, requestId: a.requestId },
        { ...column, deletedAt: null },
      );
      break;
    }
    case 'view': {
      const view = await deletedView(tx, entry.objectId);
      if (!view) throw new AppError('not_found', 'View not found');
      await assertBoardLive(tx, view.boardId);
      await updateViewRow(tx, view.id, { deletedAt: null });
      break;
    }
    case 'update': {
      const update = await deletedUpdate(tx, entry.objectId);
      if (!update) throw new AppError('not_found', 'Update not found');
      await assertBoardLive(tx, update.boardId);
      const item = await deletedItem(tx, update.itemId);
      if (item?.deletedAt) throw await parentInTrash(tx, 'item', item.id);
      await setUpdateDeleted(tx, update.id, null);
      itemId = update.itemId;
      break;
    }
    case 'board': {
      const board = await anyBoard(tx, entry.objectId);
      if (!board) throw new AppError('not_found', 'Board not found');
      const folder = board.folderId ? await anyFolder(tx, board.folderId) : undefined;
      await updateBoardRow(tx, board.id, { deletedAt: null, ...(folder?.deletedAt ? { folderId: null } : {}) });
      boardId = board.id;
      break;
    }
    case 'folder': {
      const folder = await anyFolder(tx, entry.objectId);
      if (!folder) throw new AppError('not_found', 'Folder not found');
      const ws = await anyWorkspace(tx, folder.workspaceId);
      if (!ws || ws.deletedAt) throw await parentInTrash(tx, 'workspace', folder.workspaceId);
      const parent = folder.parentFolderId ? await anyFolder(tx, folder.parentFolderId) : undefined;
      if (parent?.deletedAt) throw await parentInTrash(tx, 'folder', parent.id);
      await restoreFoldersRows(tx, payload.folder_ids?.length ? payload.folder_ids : [folder.id]);
      for (const b of payload.boards ?? []) await returnBoardsToFolder(tx, [b.id], b.folder_id);
      for (const d of payload.docs ?? []) await returnDocsToFolder(tx, [d.id], d.folder_id);
      for (const d of payload.dashboards ?? []) await returnDashboardsToFolder(tx, [d.id], d.folder_id);
      // Boards trashed with the folder come back into it (unless one was restored or purged on its own meanwhile).
      for (const boardEntry of payload.board_entries ?? []) {
        const e = await findTrashEntry(tx, a.ctx.accountId, boardEntry);
        if (e) await restoreEntryTx(tx, a, e);
      }
      break;
    }
    case 'doc': {
      // Back where it was; its folder gone too → the workspace root (the workspace itself must be live).
      const doc = await anyDoc(tx, entry.objectId);
      if (!doc) throw new AppError('not_found', 'Doc not found');
      const ws = await anyWorkspace(tx, doc.workspaceId);
      if (!ws || ws.deletedAt) throw await parentInTrash(tx, 'workspace', doc.workspaceId);
      const folder = doc.folderId ? await anyFolder(tx, doc.folderId) : undefined;
      await updateDocRow(tx, doc.id, { deletedAt: null, ...(folder?.deletedAt ? { folderId: null } : {}) });
      // One of a file cell's docs (Fix: ): back in its cell.
      if (doc.host === 'cell') await writeDocCell(tx, a, doc, doc.name);
      break;
    }
    case 'dashboard': {
      const dash = await anyDashboard(tx, entry.objectId);
      if (!dash) throw new AppError('not_found', 'Dashboard not found');
      const ws = await anyWorkspace(tx, dash.workspaceId);
      if (!ws || ws.deletedAt) throw await parentInTrash(tx, 'workspace', dash.workspaceId);
      const folder = dash.folderId ? await anyFolder(tx, dash.folderId) : undefined;
      await updateDashboardRow(tx, dash.id, { deletedAt: null, ...(folder?.deletedAt ? { folderId: null } : {}) });
      break;
    }
    case 'file': {
      // A file removed from a files cell: back into its cell(s), with all its versions.
      const root = await findAsset(tx, a.ctx.accountId, entry.objectId);
      if (!root) throw new AppError('not_found', 'File not found');
      const cells = (payload.cells ?? []) as TrashedCellFile[];
      if (!cells.length) throw new AppError('not_found', 'Cell not found');
      for (const c of cells) {
        const item = await deletedItem(tx, c.item_id);
        if (!item) throw new AppError('not_found', 'Item not found');
        await assertBoardLive(tx, item.boardId);
        if (item.deletedAt) throw await parentInTrash(tx, 'item', item.id);
        const column = await deletedColumn(tx, c.column_id);
        // The item moved to another board since: that column is not its any more.
        if (!column || column.boardId !== item.boardId) throw new AppError('not_found', 'Column not found');
        if (column.deletedAt) throw await parentInTrash(tx, 'column', column.id);
        await ensureFileCell(tx, a, item.id, item.boardId, column.id);
        await insertCellFiles(tx, [
          {
            id: newId(),
            accountId: a.ctx.accountId,
            itemId: item.id,
            columnId: column.id,
            assetId: root.id,
            position: c.position,
            createdBy: c.created_by,
            createdAt: new Date(c.created_at),
          },
        ]);
        await syncFileCell(tx, a, item.id, item.boardId, column.id);
        itemId ??= item.id;
        boardId = item.boardId;
      }
      break;
    }
    case 'workspace': {
      const ws = await anyWorkspace(tx, entry.objectId);
      if (!ws) throw new AppError('not_found', 'Workspace not found');
      await updateWorkspaceRow(tx, ws.id, { deletedAt: null });
      await restoreFoldersRows(tx, payload.folder_ids ?? []);
      break;
    }
    default:
      throw new AppError('not_undoable', `Cannot restore a ${entry.objectType}`);
  }

  await markRestored(tx, entry.id);
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: `${entry.objectType}.restored`,
    actorId: a.user.id,
    requestId: a.requestId,
    boardId,
    itemId,
    after: { id: entry.objectId, name: entry.objectName },
    meta: { trash_entry_id: entry.id, ...(undoOf ? { undo_of: undoOf } : {}) },
  });
};

export const restoreFromTrash = async (db: Db, a: Actor, entryId: string) => {
  const entry = await loadEntry(db, a, entryId);
  await db.transaction((tx) => restoreEntryTx(tx, a, entry));
  return {
    ok: true as const,
    object_type: entry.objectType as TrashObjectType,
    object_id: entry.objectId,
    board_id: entry.objectType === 'board' ? entry.objectId : entry.boardId,
  };
};

/** "מחק לצמיתות": leaves the trash now; rows are removed by the worker's `trash.purge`. */
export const deleteFromTrash = async (db: Db, a: Actor, entryId: string) => {
  const entry = await loadEntry(db, a, entryId);
  await expireTrashEntries(db, a.ctx.accountId, [entry.id], ownerFilter(a));
};

/** "רוקן אשפה" — admins only (07 §5.2). */
export const emptyTrash = async (db: Db, a: Actor) => {
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  return (await expireTrashEntries(db, a.ctx.accountId, 'all', null)).length;
};
