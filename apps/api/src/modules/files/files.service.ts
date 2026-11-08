// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import { AppError, type CellLink, columnTypes, fileLinkText, mediaServeType, newId } from '@bines/shared';
import type { Db } from '../../db/client';
import { enqueueJob } from '../../lib/jobs';
import type { AppDeps, Actor } from '../../types';
import { outboundDownload } from '../../lib/outbound';
import { isInlineSafeMime } from '../../lib/storage';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, columnAllowed } from '../boards/boards.access';
import { findColumnById, findColumnByKey } from '../boards/boards.repo';
import { deleteCell, upsertCell } from '../items/items.repo';
import { loadItem } from '../items/items.service';
import { loadDocAccess } from '../docs/docs.access';
import { docsHoldingAsset, listCellDocs } from '../docs/docs.repo';
import { findTrashEntry, insertTrashEntry, setRestorePayload, trashEntryOf } from '../trash/trash.repo';
import { markAiOutputsRejected } from '../ai2/outputs';
import type { cellFiles } from '../../db/schema';
import {
  type AssetRow,
  assetsByIds,
  cellFileAssets,
  currentOf,
  fileCellRow,
  deleteAssetRow,
  deleteCellFile,
  findAsset,
  insertAsset,
  insertCellFiles,
  cellsHoldingAsset,
  itemsWithUpdateAsset,
  updatesWithAsset,
  markUploaded,
  unusedAssets,
} from './files.repo';

type Deps = Pick<AppDeps, 'db' | 'storage'> & Partial<Pick<AppDeps, 'logger'>>;

export const MAX_FILE_BYTES = 500 * 1024 * 1024; // 01-ARCHITECTURE §7

export const fileDto = (a: AssetRow) => ({ id: a.id, name: a.fileName, size: a.size, mime: a.mime });

/**
 * Keeps letters (any script), digits, dot, dash, underscore; everything else becomes "_". A name of dots only
 * (`.`, `..`) is "file": it is a path step, not a name (audit 2026-10-10 security #21 — disk storage threw a 500).
 */
export const safeName = (name: string) =>
  name
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .slice(-120)
    .replace(/^\.+$/, '') || 'file';

/**
 * Storage cleanup (owner fix6-server 2a): of these assets, the ones nothing uses any more leave the bucket (R2)
 * at once, then their rows. Call after the transaction that took them off has committed. A failed delete
 * (storage down) keeps the row; the worker's hourly sweep (`files.purge`) tries again.
 */
export const releaseAssets = async (deps: Deps, accountId: string, ids: string[]) => {
  let removed = 0;
  for (const asset of await unusedAssets(deps.db, accountId, [...new Set(ids)])) {
    try {
      await deps.storage.remove(asset.storage_key);
      await deleteAssetRow(deps.db, accountId, asset.id);
      removed++;
    } catch (err) {
      deps.logger?.warn({ err: String(err), asset_id: asset.id }, 'file cleanup failed; the sweep retries');
    }
  }
  return removed;
};

/** Step 1 of an upload: an asset row + a presigned PUT straight to storage. */
export const presignUpload = async (deps: Deps, a: Actor, input: { name: string; size: number; mime: string }) => {
  if (input.size > MAX_FILE_BYTES) throw new AppError('payload_too_large', 'Files are limited to 500 MB');
  if (a.ctx.role === 'viewer') throw new AppError('forbidden', 'viewer_read_only');
  const id = newId();
  const key = `${a.ctx.accountId}/${id}/${safeName(input.name)}`;
  await insertAsset(deps.db, {
    id,
    accountId: a.ctx.accountId,
    ownerId: a.user.id,
    kind: 'file',
    storageKey: key,
    fileName: input.name.slice(0, 255),
    mime: input.mime || 'application/octet-stream',
    size: input.size,
    uploadStatus: 'pending',
  });
  const put = await deps.storage.presignPut(key, input.mime || 'application/octet-stream', input.size);
  return { file_id: id, upload_url: put.url, method: 'PUT' as const, headers: put.headers };
};

/**
 * The type storage reports for an upload: a client that sent `Content-Type` twice gets it back joined
 * ("a, a"), longer than the column — keep the first value, and the type declared at presign when nothing usable is left.
 */
export const storedMime = (reported: string, declared: string) => {
  const first = reported.split(',')[0]!.trim();
  return first && first.length <= 127 ? first : declared;
};

/** Step 2: the server checks the object really exists before the file can be attached anywhere. */
export const completeUpload = async (deps: Deps, a: Actor, fileId: string) => {
  const asset = await findAsset(deps.db, a.ctx.accountId, fileId);
  if (!asset || asset.ownerId !== a.user.id) throw new AppError('not_found', 'File not found');
  if (asset.uploadStatus === 'uploaded') return fileDto(asset);
  const head = await deps.storage.head(asset.storageKey!);
  if (!head) throw new AppError('unprocessable', 'upload_missing');
  if (head.size > MAX_FILE_BYTES) throw new AppError('payload_too_large', 'Files are limited to 500 MB');
  const mime = storedMime(head.mime, asset.mime);
  await markUploaded(deps.db, asset.id, head.size, mime);
  return fileDto({ ...asset, size: head.size, mime });
};

/** Files a user may attach: their own uploads that finished (not a version of another file). */
export const ownUploadedAssets = async (db: Db, a: Actor, ids: string[]) => {
  const unique = [...new Set(ids)];
  const rows = await assetsByIds(db, a.ctx.accountId, unique);
  const ok = rows.filter((r) => r.ownerId === a.user.id && r.uploadStatus === 'uploaded' && !r.parentAssetId);
  if (ok.length !== unique.length) throw new AppError('invalid_value', 'Unknown or unfinished file');
  return unique.map((id) => ok.find((r) => r.id === id)!);
};

export const loadFileColumn = async (db: Db, a: Actor, itemId: string, columnKey: string) => {
  const { item, access } = await loadItem(db, a, itemId);
  assertBoard(access, 'item.update');
  const column = await findColumnByKey(db, item.boardId, columnKey);
  if (!column || columnTypes.get(column.type)?.engine !== 'files')
    throw new AppError('not_found', 'File column not found');
  if (!columnAllowed(access, column.restrictedEdit)) throw new AppError('forbidden', `column_restricted:${column.key}`);
  return { item, column };
};

/**
 * Rewrites the cell cache `{files:[…], docs?:[…]}` from cell_files and the cell's docs (the truth), or clears it.
 * Fix: a file cell also holds docs ("new doc" in the cell) — docs with the item's permissions.
 * and links, whose only home is the cell value — kept as they are, or `links` when they change.
 */
export const syncFileCell = async (
  db: Db,
  a: Actor,
  itemId: string,
  boardId: string,
  columnId: string,
  links?: CellLink[],
) => {
  const rows = await cellFileAssets(db, itemId, columnId);
  const cellDocs = await listCellDocs(db, itemId, columnId);
  const cellLinks = links ?? (await fileCellRow(db, itemId, columnId))?.links ?? [];
  if (!rows.length && !cellDocs.length && !cellLinks.length) {
    await deleteCell(db, itemId, columnId);
    return;
  }
  await upsertCell(db, {
    itemId,
    columnId,
    accountId: a.ctx.accountId,
    boardId,
    value: {
      // One entry per file: the root's id (what the cell holds), the current version's name, size and number.
      files: rows.map((r) => ({
        asset_id: r.asset.id,
        name: r.current.fileName,
        size: r.current.size,
        mime: r.current.mime,
        version: r.current.version,
        added_by: r.addedBy ?? '',
        added_at: r.addedAt.toISOString(),
      })),
      ...(cellDocs.length ? { docs: cellDocs.map((d) => ({ doc_id: d.id, name: d.name })) } : {}),
      ...(cellLinks.length ? { links: cellLinks } : {}),
    },
    textValue:
      [...rows.map((r) => r.current.fileName), ...cellDocs.map((d) => d.name), ...cellLinks.map(fileLinkText)].join(
        ', ',
      ) || null,
    numberValue: rows.length + cellDocs.length + cellLinks.length,
    dateValue: null,
    dateEndValue: null,
    updatedBy: a.user.id,
    updatedByType: 'user',
  });
};

export const attachToCell = async (deps: Deps, a: Actor, itemId: string, columnKey: string, fileIds: string[]) => {
  const { db } = deps;
  const { item, column } = await loadFileColumn(db, a, itemId, columnKey);
  const files = await ownUploadedAssets(db, a, fileIds);
  await db.transaction(async (tx) => {
    const existing = await cellFileAssets(tx, item.id, column.id);
    // cell_files references the cell row, so the cell must exist before files are linked to it.
    if (!existing.length) await ensureFileCell(tx, a, item.id, item.boardId, column.id);
    await insertCellFiles(
      tx,
      files.map((f, i) => ({
        id: newId(),
        accountId: a.ctx.accountId,
        itemId: item.id,
        columnId: column.id,
        assetId: f.id,
        position: String(existing.length + i).padStart(6, '0'),
        createdBy: a.user.id,
      })),
    );
    await syncFileCell(tx, a, item.id, item.boardId, column.id);
    const eventId = await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'file.added',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      after: { files: files.map(fileDto) },
      // Which column: the "file added" trigger, AI columns' auto-run and webhooks read it.
      meta: { column_key: column.key, column_type: column.type },
    });
    // The activity trigger (0046) does not queue `automation.dispatch` for `file.added`; the event queues its own,
    // in the same transaction, when something on the board can hear it (as extension and flow events do).
    if (await fileEventListened(tx, item.boardId))
      await enqueueJob(tx, 'automation.dispatch', { event_id: eventId, account_id: a.ctx.accountId });
  });
};

/**
 * Whether a `file.added` on this board can be heard (0046's rules for its board): an active automation or webhook
 * on it (a sub-board's: its parent board's), or an auto-run AI column on it.
 */
const fileEventListened = async (db: Db, boardId: string) => {
  const res = (await db.execute(sql`
    select exists (
      select 1 from boards b
      where b.id = ${boardId} and (
        exists (select 1 from automations x where x.board_id = coalesce(b.parent_board_id, b.id)
                and x.is_active and x.deleted_at is null)
        or exists (select 1 from webhooks w where w.board_id = coalesce(b.parent_board_id, b.id)
                   and w.is_active and w.deleted_at is null)
        or exists (select 1 from columns c where c.board_id = b.id and c.type = 'ai' and c.deleted_at is null
                   and c.settings ->> 'auto_run' = 'true')
      )
    ) as ok`)) as { rows: { ok: boolean }[] };
  return !!res.rows[0]?.ok;
};

/** A cell a file was removed from (the trash entry's `restore_payload.cells`): where restore puts it back. */
export type TrashedCellFile = {
  item_id: string;
  column_id: string;
  position: string;
  created_by: string | null;
  created_at: string;
};

/**
 * Removing a file from a cell sends it — with all its versions — to the trash, restorable like an
 * item for the trash's retention, then purged with its storage. The same file taken off a second cell while in the
 * trash joins the same entry (restore puts it back in both).
 */
const trashCellFile = async (
  tx: Db,
  a: Actor,
  link: typeof cellFiles.$inferSelect,
  name: string,
  boardId: string,
): Promise<string> => {
  const cell: TrashedCellFile = {
    item_id: link.itemId,
    column_id: link.columnId,
    position: link.position,
    created_by: link.createdBy,
    created_at: link.createdAt.toISOString(),
  };
  const live = await trashEntryOf(tx, 'file', link.assetId);
  if (live) {
    const entry = (await findTrashEntry(tx, a.ctx.accountId, live.id))!;
    const cells = ((entry.restorePayload as { cells?: TrashedCellFile[] }).cells ?? []).concat(cell);
    await setRestorePayload(tx, entry.id, { ...entry.restorePayload, cells });
    return entry.id;
  }
  const id = newId();
  await insertTrashEntry(tx, {
    id,
    accountId: a.ctx.accountId,
    objectType: 'file',
    objectId: link.assetId,
    objectName: (name || '—').slice(0, 255),
    boardId,
    deletedBy: a.user.id,
    restorePayload: { cells: [cell] },
  });
  return id;
};

/** Puts a cell back for a restored file (cell_files hangs on the cell row) — an empty one when it was cleared. */
export const ensureFileCell = async (db: Db, a: Actor, itemId: string, boardId: string, columnId: string) => {
  // Any row will do (one holding only links or docs too): rewriting it here would drop its links.
  if (await fileCellRow(db, itemId, columnId)) return;
  await upsertCell(db, {
    itemId,
    columnId,
    accountId: a.ctx.accountId,
    boardId,
    value: { files: [] },
    textValue: null,
    numberValue: 0,
    dateValue: null,
    dateEndValue: null,
    updatedBy: a.user.id,
    updatedByType: 'user',
  });
};

export const detachFromCell = async (
  deps: Deps,
  a: Actor,
  itemId: string,
  columnKey: string,
  fileId: string,
  /**
   * false = the caller releases the file once its own transaction committed (an AI column's "replace"): it is not
   * kept in the trash. Otherwise the file goes to the trash with its versions.
   */
  opts: { release?: boolean } = {},
) => {
  const { db } = deps;
  const { item, column } = await loadFileColumn(db, a, itemId, columnKey);
  await db.transaction(async (tx) => {
    const current = (await cellFileAssets(tx, item.id, column.id)).find((r) => r.asset.id === fileId)?.current;
    const [link] = await deleteCellFile(tx, item.id, column.id, fileId);
    await syncFileCell(tx, a, item.id, item.boardId, column.id);
    const entryId =
      link && opts.release !== false ? await trashCellFile(tx, a, link, current?.fileName ?? '', item.boardId) : null;
    // An AI design removed (round 4): the AI cell that made it marks it rejected.
    if (link) await markAiOutputsRejected(tx, item.id, fileId);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'file.removed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      before: { file_id: fileId, ...(current ? { name: current.fileName } : {}) },
      // `trash_entry_id`: undo restores the file from the trash (as every delete-to-trash event).
      meta: { column_key: column.key, column_type: column.type, ...(entryId ? { trash_entry_id: entryId } : {}) },
    });
  });
};

/** A file attached from a link (AGENTS-MCP §4 `attach_file_from_url`): at most 25 MB, fetched within 20 s. */
export const URL_FILE_MAX_BYTES = 25 * 1024 * 1024;
const URL_FILE_TIMEOUT_MS = 20_000;
/**
 * What a link may bring in: documents, images, media, archives, data. Not web pages or anything a browser runs
 * (HTML, SVG, scripts) — a page is usually a login or error screen, not the file the user meant.
 */
const URL_FILE_MIME =
  /^(image\/(png|jpe?g|gif|webp|avif|bmp|tiff|heic|heif)|application\/(pdf|zip|x-zip-compressed|gzip|json|rtf|octet-stream|msword|vnd\.[\w.+-]+)|text\/(plain|csv|calendar|markdown|tab-separated-values)|audio\/[\w.+-]+|video\/[\w.+-]+)$/;
/** A file the server brings in itself (a link, an email attachment) may be of this type. */
export const isServerFileMime = (mime: string) => URL_FILE_MIME.test(mime);

/**
 * Downloads a public URL into a file column of an item: the same rights as uploading there (item.update, the
 * column's edit restriction — checked before anything is fetched), the SSRF-guarded download (`outbound.ts`), a
 * size cap and a content-type allow-list; then attached like an upload (event `file.added`).
 */
export const attachFromUrl = async (
  deps: Deps,
  a: Actor,
  itemId: string,
  columnKey: string,
  input: { url: string; name?: string },
) => {
  await loadFileColumn(deps.db, a, itemId, columnKey);
  if (a.ctx.role === 'viewer') throw new AppError('forbidden', 'viewer_read_only');
  const file = await outboundDownload(input.url, { maxBytes: URL_FILE_MAX_BYTES, timeoutMs: URL_FILE_TIMEOUT_MS });
  if (!URL_FILE_MIME.test(file.mime))
    throw new AppError('invalid_value', `unsupported_file_type: ${file.mime}`, { mime: file.mime });
  if (!file.body.length) throw new AppError('invalid_value', 'empty_file');
  const name = (input.name ?? file.fileName ?? 'file').slice(0, 255);
  const id = newId();
  const key = `${a.ctx.accountId}/${id}/${safeName(name)}`;
  await insertAsset(deps.db, {
    id,
    accountId: a.ctx.accountId,
    ownerId: a.user.id,
    kind: 'file',
    storageKey: key,
    fileName: name,
    mime: file.mime,
    size: file.body.length,
    uploadStatus: 'pending',
  });
  await deps.storage.put(key, file.body, file.mime);
  await markUploaded(deps.db, id, file.body.length, file.mime);
  await attachToCell(deps, a, itemId, columnKey, [id]);
  return { id, name, size: file.body.length, mime: file.mime };
};

/**
 * Discards an upload that was never attached (the composer removed it before posting — owner fix6-server 2a):
 * only the uploader, and only while nothing uses it; the object leaves storage at once.
 */
export const discardUpload = async (deps: Deps, a: Actor, fileId: string) => {
  const { db } = deps;
  const asset = await findAsset(db, a.ctx.accountId, fileId);
  if (!asset || asset.ownerId !== a.user.id) throw new AppError('not_found', 'File not found');
  if (!(await unusedAssets(db, a.ctx.accountId, [asset.id])).length) throw new AppError('conflict', 'file_in_use');
  await db.transaction(async (tx) => {
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'file.discarded',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { file_id: asset.id, name: asset.fileName, size: asset.size },
    });
  });
  await deps.storage.remove(asset.storageKey!);
  await deleteAssetRow(db, a.ctx.accountId, asset.id);
};

/**
 * May this person read this (uploaded) file — the one rule for every download (GET /files/{id}, "download all"):
 * the uploader (not through a board-limited token), or anyone who can read an item whose cell (a column not hidden
 * from them, 05 §6.1 / S-55) or live update carries it, or a doc that shows it (M8 ד2).
 */
export const mayReadAsset = async (
  db: Db,
  a: Actor,
  asset: Pick<AssetRow, 'id' | 'ownerId'> & { parentAssetId?: string | null },
) => {
  // A token limited to some boards reaches a file only through an item on them — even one its user uploaded.
  if (asset.ownerId === a.user.id && !a.ctx.boardLimit) return true;
  // A version is read through its file: whoever may read the root may read every version.
  const rootId = asset.parentAssetId ?? asset.id;
  const holders: { itemId: string; columnId: string | null }[] = [
    ...(await cellsHoldingAsset(db, rootId)),
    ...(await itemsWithUpdateAsset(db, rootId)).map((itemId) => ({ itemId, columnId: null })),
  ];
  for (const h of holders) {
    try {
      const { access } = await loadItem(db, a, h.itemId);
      if (h.columnId) {
        const column = await findColumnById(db, h.columnId);
        if (!column || !columnAllowed(access, column.restrictedView)) continue;
      }
      return true;
    } catch {
      // not readable through this item; try the next one
    }
  }
  for (const docId of await docsHoldingAsset(db, a.ctx.accountId, rootId)) {
    try {
      await loadDocAccess(db, a.ctx, a.user, docId);
      return true;
    } catch {
      // not readable through this doc
    }
  }
  return false;
};

/**
 * What may this person change about a file's own text (its transcript)? The same as editing what
 * holds it: in a cell — item.update and the column's edit restriction; in an update — its author. A file not yet
 * attached (just recorded in the composer) — its uploader. Returns the holder to name in the activity log, or null.
 */
export const assetEditHolder = async (
  db: Db,
  a: Actor,
  asset: Pick<AssetRow, 'id' | 'ownerId'> & { parentAssetId?: string | null },
): Promise<{ itemId: string | null; boardId: string | null } | null> => {
  const rootId = asset.parentAssetId ?? asset.id;
  const cellsOf = await cellsHoldingAsset(db, rootId);
  for (const h of cellsOf) {
    try {
      const { item, access } = await loadItem(db, a, h.itemId);
      assertBoard(access, 'item.update');
      const column = await findColumnById(db, h.columnId);
      if (!column || !columnAllowed(access, column.restrictedEdit)) continue;
      return { itemId: item.id, boardId: item.boardId };
    } catch {
      // not editable through this cell
    }
  }
  const ups = await updatesWithAsset(db, rootId);
  for (const u of ups) {
    if (u.createdBy !== a.user.id) continue;
    try {
      await loadItem(db, a, u.itemId);
      return { itemId: u.itemId, boardId: u.boardId };
    } catch {
      // the author lost access to the item
    }
  }
  if (!cellsOf.length && !ups.length && asset.ownerId === a.user.id && !a.ctx.boardLimit)
    return { itemId: null, boardId: null };
  return null;
};

/**
 * Metadata + a 15-minute download link. Access: the uploader (not through a board-limited token), or anyone who
 * can read an item whose cell or (live) update carries the file — the same board/item rules as everything else.
 * A file's id (the root) serves its current version; a version's id serves that version
 * `exact`: the root's own bytes — version 1 (the viewer's versions tab), not the current one.
 */
export const getFile = async (
  deps: Deps,
  a: Actor,
  fileId: string,
  opts: { inline?: boolean; exact?: boolean } = {},
) => {
  const asset = await findAsset(deps.db, a.ctx.accountId, fileId);
  if (!asset || asset.uploadStatus !== 'uploaded' || !(await mayReadAsset(deps.db, a, asset)))
    throw new AppError('not_found', 'File not found');
  const served = asset.parentAssetId || opts.exact ? asset : await currentOf(deps.db, asset);
  // A media file stored without a type plays in place by its extension.
  const mediaType = mediaServeType({ name: served.fileName, mime: served.mime });
  const inline = !!opts.inline && isInlineSafeMime(mediaType ?? served.mime);
  return {
    ...fileDto({ ...served, id: asset.id }),
    version: served.version,
    download_url: await deps.storage.presignGet(
      served.storageKey!,
      served.fileName,
      inline ? { inline: true, ...(mediaType ? { contentType: mediaType } : {}) } : undefined,
    ),
  };
};
