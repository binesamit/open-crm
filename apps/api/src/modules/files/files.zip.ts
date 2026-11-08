// SPDX-License-Identifier: AGPL-3.0-only
import type { Readable } from 'node:stream';
import { AppError, columnTypes } from '@bines/shared';
import type { AppDeps, Actor } from '../../types';
import { asLocale, st } from '../../lib/i18n';
import { isCompressedMime, safeName, uniqueIn } from '../../lib/zip-file';
import { type ZipEntry, zipStream } from '../../lib/zip-stream';
import { loadSettings } from '../accounts/accounts.service';
import { columnAllowed } from '../boards/boards.access';
import { findColumnByKey } from '../boards/boards.repo';
import { loadItem } from '../items/items.service';
import { findUpdate } from '../updates/updates.repo';
import { type AssetRow, cellFileAssets, updateFileAssets } from './files.repo';
import { mayReadAsset } from './files.service';

/**
 * "Download all": every file of a files cell, or of an update, as one ZIP streamed by the server.
 * The holder (the item, the column, the update) is checked first, then each file with the same rule as one download
 * (`mayReadAsset`): a file the person may not read is left out without its name — the archive then holds a short
 * note saying how many were left out. On / off and the limits are the account's (settings.downloads).
 */
type Deps = Pick<AppDeps, 'db' | 'storage'>;
const MB = 1024 * 1024;

export type FilesZip = { fileName: string; stream: Readable; files: number; skipped: number };

const fileStream = async (deps: Deps, key: string): Promise<Readable | Buffer | null> => {
  if (deps.storage.getStream) return deps.storage.getStream(key);
  return deps.storage.get(key, 4000 * MB);
};

const pack = async (deps: Deps, a: Actor, assets: AssetRow[], title: string): Promise<FilesZip> => {
  const limits = (await loadSettings(deps.db, a.ctx.accountId)).downloads;
  if (!limits.zip_enabled) throw new AppError('forbidden', 'zip_disabled');
  const files: AssetRow[] = [];
  let skipped = 0;
  for (const asset of assets) {
    if (asset.uploadStatus === 'uploaded' && asset.storageKey && (await mayReadAsset(deps.db, a, asset)))
      files.push(asset);
    else skipped++;
  }
  if (!files.length) throw new AppError('not_found', 'No files to download');
  if (files.length > limits.zip_max_files)
    throw new AppError('payload_too_large', 'zip_too_many_files', { max_files: limits.zip_max_files });
  if (files.reduce((sum, f) => sum + f.size, 0) > limits.zip_max_mb * MB)
    throw new AppError('payload_too_large', 'zip_too_large', { max_mb: limits.zip_max_mb });

  const locale = asLocale(a.user.locale);
  async function* entries(): AsyncGenerator<ZipEntry> {
    const used = new Set<string>();
    let missing = 0;
    for (const f of files) {
      const body = await fileStream(deps, f.storageKey!);
      if (!body) {
        missing++;
        continue;
      }
      yield {
        name: uniqueIn(used, safeName(f.fileName, f.id)),
        body,
        store: isCompressedMime(f.mime),
        date: f.createdAt,
      };
    }
    // Never a name: only how many were left out (no access, or gone from storage).
    if (skipped + missing)
      yield {
        name: uniqueIn(used, `${st('files.zip.noteName', undefined, locale)}.txt`),
        body: `${st('files.zip.noteBody', { count: skipped + missing }, locale)}\n`,
      };
  }
  return {
    fileName: `${safeName(title, 'files')}.zip`,
    stream: zipStream(entries()),
    files: files.length,
    skipped,
  };
};

/** GET /items/{id}/cells/{columnKey}/files.zip — a files cell: the item readable, the column not hidden from me. */
export const cellFilesZip = async (deps: Deps, a: Actor, itemId: string, columnKey: string) => {
  const { item, access } = await loadItem(deps.db, a, itemId);
  // The API names a column by its key (as every cell route does).
  const column = await findColumnByKey(deps.db, item.boardId, columnKey);
  if (!column || columnTypes.get(column.type)?.engine !== 'files' || !columnAllowed(access, column.restrictedView))
    throw new AppError('not_found', 'Column not found');
  const rows = await cellFileAssets(deps.db, item.id, column.id);
  return pack(
    deps,
    a,
    // Each file at its current version.
    rows.map((r) => r.current),
    `${item.name} - ${column.title}`,
  );
};

/** GET /updates/{id}/files.zip — an update's files: the update's item readable. */
export const updateFilesZip = async (deps: Deps, a: Actor, updateId: string) => {
  const update = await findUpdate(deps.db, a.ctx.accountId, updateId);
  if (!update) throw new AppError('not_found', 'Update not found');
  const { item } = await loadItem(deps.db, a, update.itemId);
  const rows = await updateFileAssets(deps.db, [update.id]);
  return pack(
    deps,
    a,
    rows.map((r) => r.asset),
    `${item.name} - ${st('files.zip.updateTitle', undefined, asLocale(a.user.locale))}`,
  );
};
