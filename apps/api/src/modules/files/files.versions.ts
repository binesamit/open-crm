// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canBoard, newId } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps, Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, type BoardAccess, columnAllowed } from '../boards/boards.access';
import { findColumnById } from '../boards/boards.repo';
import { loadItem } from '../items/items.service';
import {
  type AssetRow,
  cellsHoldingAsset,
  currentOf,
  deleteAssetRow,
  findAsset,
  insertAsset,
  markUploaded,
  maxVersionLocked,
  setAsVersion,
  unusedAssets,
  versionsOf,
} from './files.repo';
import { mayReadAsset, ownUploadedAssets, safeName, syncFileCell } from './files.service';

/**
 * File versions, files columns only: a file in a cell gets new versions — uploaded, or an older one
 * made current again — and the cell keeps showing one file, at its current (newest) version. The first upload is
 * the root (version 1) and the cell keeps pointing at it; each version is an asset with `parent_asset_id` = the
 * root. History is linear: "make current" copies the old version as a new one, nothing is rewritten.
 */
type Deps = Pick<AppDeps, 'db' | 'storage'> & Partial<Pick<AppDeps, 'logger'>>;

export type FileVersionDto = {
  id: string;
  version: number;
  name: string;
  size: number;
  mime: string;
  created_by: { id: string; name: string } | null;
  created_at: string;
  current: boolean;
};

export const versionDto = (a: AssetRow, ownerName: string | null, currentId: string): FileVersionDto => ({
  id: a.id,
  version: a.version,
  name: a.fileName,
  size: a.size,
  mime: a.mime,
  created_by: a.ownerId ? { id: a.ownerId, name: ownerName ?? '' } : null,
  created_at: a.createdAt.toISOString(),
  current: a.id === currentId,
});

/** The root file, or 404 (a version's id is not a file's id here). */
const loadRoot = async (db: Db, a: Actor, rootId: string) => {
  const root = await findAsset(db, a.ctx.accountId, rootId);
  if (!root || root.parentAssetId || root.uploadStatus !== 'uploaded')
    throw new AppError('not_found', 'File not found');
  return root;
};

/**
 * A root file in a files cell the actor may change — the same rights as attaching there (item.update, the column's
 * edit restriction). Not readable through any cell → 404; readable but not editable → 403.
 */
export const loadEditableRoot = async (db: Db, a: Actor, rootId: string) => {
  const root = await loadRoot(db, a, rootId);
  let refusal: AppError | null = null;
  for (const c of await cellsHoldingAsset(db, root.id)) {
    let access: BoardAccess;
    let item: Awaited<ReturnType<typeof loadItem>>['item'];
    try {
      ({ item, access } = await loadItem(db, a, c.itemId));
    } catch {
      continue; // not readable through this item
    }
    const column = await findColumnById(db, c.columnId);
    if (!column || !columnAllowed(access, column.restrictedView)) continue;
    try {
      assertBoard(access, 'item.update');
      if (!columnAllowed(access, column.restrictedEdit))
        throw new AppError('forbidden', `column_restricted:${column.key}`);
      if (a.ctx.role === 'viewer') throw new AppError('forbidden', 'viewer_read_only');
    } catch (err) {
      refusal ??= err instanceof AppError ? err : new AppError('forbidden', 'board_permission');
      continue;
    }
    return { root, item, column, access };
  }
  throw refusal ?? new AppError('not_found', 'File not found');
};

/** Every cell holding the root shows its new current version. */
export const syncCellsOf = async (tx: Db, a: Actor, rootId: string) => {
  for (const c of await cellsHoldingAsset(tx, rootId)) await syncFileCell(tx, a, c.itemId, c.boardId, c.columnId);
};

/** GET /files/{id}/versions — newest first; for anyone who may read the file. */
export const listFileVersions = async (deps: Deps, a: Actor, rootId: string) => {
  const root = await loadRoot(deps.db, a, rootId);
  if (!(await mayReadAsset(deps.db, a, root))) throw new AppError('not_found', 'File not found');
  const rows = await versionsOf(deps.db, a.ctx.accountId, root.id);
  const currentId = rows[0]?.asset.id ?? root.id;
  return { data: rows.map((r) => versionDto(r.asset, r.ownerName, currentId)) };
};

export const versionOf = async (db: Db, a: Actor, root: AssetRow, versionId: string) => {
  const v = await findAsset(db, a.ctx.accountId, versionId);
  if (!v || (v.parentAssetId ?? v.id) !== root.id || v.uploadStatus !== 'uploaded')
    throw new AppError('not_found', 'Version not found');
  return v;
};

/** POST /files/{id}/versions — an own finished upload becomes the file's next (current) version. */
export const addFileVersion = async (deps: Deps, a: Actor, rootId: string, fileId: string) => {
  const { db } = deps;
  const { root, item, column } = await loadEditableRoot(db, a, rootId);
  const [file] = await ownUploadedAssets(db, a, [fileId]);
  // Only a fresh upload: not the file itself, nothing attached anywhere, not a file with versions of its own.
  if (file!.id === root.id || !(await unusedAssets(db, a.ctx.accountId, [file!.id])).some((u) => u.id === file!.id))
    throw new AppError('conflict', 'file_in_use');
  const version = await db.transaction(async (tx) => {
    const v = (await maxVersionLocked(tx, root.id)) + 1;
    await setAsVersion(tx, file!.id, root.id, v);
    await syncCellsOf(tx, a, root.id);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'file.version_added',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      after: { file_id: root.id, version_id: file!.id, version: v, name: file!.fileName },
      meta: { column_key: column.key, column_type: column.type },
    });
    return v;
  });
  return versionDto({ ...file!, parentAssetId: root.id, version }, a.user.name, file!.id);
};

/**
 * POST /files/{id}/versions/{versionId}/make-current — an older version becomes current again as a new version:
 * a server-side copy of its bytes (the storage limit counts it like an upload). Already current: nothing changes.
 */
export const makeVersionCurrent = async (deps: Deps, a: Actor, rootId: string, versionId: string) => {
  const { db } = deps;
  const { root, item, column } = await loadEditableRoot(db, a, rootId);
  const src = await versionOf(db, a, root, versionId);
  const current = await currentOf(db, root);
  if (current.id === src.id) return versionDto(src, null, src.id);
  const id = newId();
  const key = `${a.ctx.accountId}/${id}/${safeName(src.fileName)}`;
  await insertAsset(db, {
    id,
    accountId: a.ctx.accountId,
    ownerId: a.user.id,
    kind: 'file',
    storageKey: key,
    fileName: src.fileName,
    mime: src.mime,
    size: src.size,
    width: src.width,
    height: src.height,
    sha256: src.sha256,
    uploadStatus: 'pending',
  });
  try {
    await deps.storage.copy(src.storageKey!, key);
  } catch (err) {
    await deleteAssetRow(db, a.ctx.accountId, id);
    throw err;
  }
  const row = await db.transaction(async (tx) => {
    const v = (await maxVersionLocked(tx, root.id)) + 1;
    await setAsVersion(tx, id, root.id, v);
    await markUploaded(tx, id, src.size, src.mime);
    await syncCellsOf(tx, a, root.id);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'file.version_restored',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      before: { version_id: current.id, version: current.version },
      after: { file_id: root.id, version_id: id, version: v, from_version: src.version, name: src.fileName },
      meta: { column_key: column.key, column_type: column.type },
    });
    return (await findAsset(tx, a.ctx.accountId, id))!;
  });
  return versionDto(row, a.user.name, row.id);
};

/**
 * DELETE /files/{id}/versions/{versionId} — at once, row and stored bytes: only a version that is not current, by
 * the person who uploaded it or a board owner / admin. Version 1 anchors the file in its cells: it stays while
 * there are newer versions (`first_version_kept`).
 */
export const deleteFileVersion = async (deps: Deps, a: Actor, rootId: string, versionId: string) => {
  const { db } = deps;
  const { root, item, column, access } = await loadEditableRoot(db, a, rootId);
  const v = await versionOf(db, a, root, versionId);
  const current = await currentOf(db, root);
  if (v.id === current.id) throw new AppError('conflict', 'version_is_current');
  if (v.id === root.id) throw new AppError('conflict', 'first_version_kept');
  if (v.ownerId !== a.user.id && !canBoard(access.perm, 'board.update').ok)
    throw new AppError('forbidden', 'version_owner_or_board_admin');
  await db.transaction(async (tx) => {
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'file.version_deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      before: { file_id: root.id, version_id: v.id, version: v.version, name: v.fileName },
      meta: { column_key: column.key, column_type: column.type },
    });
    await deleteAssetRow(tx, a.ctx.accountId, v.id);
  });
  try {
    if (v.storageKey) await deps.storage.remove(v.storageKey);
  } catch (err) {
    deps.logger?.warn({ err: String(err), asset_id: v.id }, 'file version storage delete failed');
  }
};
