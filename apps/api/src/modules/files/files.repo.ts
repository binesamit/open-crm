// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { CellLink } from '@bines/shared';
import type { Db } from '../../db/client';
import { assertWithinLimit, GB } from '../billing/entitlements';
import { assets, cellFiles, cells, updateFiles, updates, users } from '../../db/schema';

export type AssetRow = typeof assets.$inferSelect;

/** Every new file passes the plan's storage limit here: uploads, forms, extensions, URL attachments. */
export const insertAsset = async (db: Db, row: typeof assets.$inferInsert) => {
  if (row.size && row.size > 0) await assertWithinLimit(db, row.accountId, 'storage_gb', row.size / GB);
  return db.insert(assets).values(row);
};

export const findAsset = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(assets)
      .where(and(eq(assets.accountId, accountId), eq(assets.id, id), isNull(assets.deletedAt)))
      .limit(1)
  )[0];

export const assetsByIds = (db: Db, accountId: string, ids: string[]) =>
  ids.length
    ? db
        .select()
        .from(assets)
        .where(and(eq(assets.accountId, accountId), inArray(assets.id, ids), isNull(assets.deletedAt)))
    : Promise.resolve([] as AssetRow[]);

export const markUploaded = (db: Db, id: string, size: number, mime: string) =>
  db.update(assets).set({ uploadStatus: 'uploaded', size, mime }).where(eq(assets.id, id));

// --- versions ----
/**
 * A file's versions: the first upload is the root (version 1) — cells always point at it; each new version is its
 * own asset with `parent_asset_id` = the root and the next number. The newest one is the current version.
 */
export const rootIdOf = (a: Pick<AssetRow, 'id' | 'parentAssetId'>) => a.parentAssetId ?? a.id;

/** The newest uploaded version of each of these roots (absent: the root is its only version). */
export const latestVersions = async (db: Db, rootIds: string[]) => {
  const out = new Map<string, AssetRow>();
  if (!rootIds.length) return out;
  const rows = await db
    .selectDistinctOn([assets.parentAssetId])
    .from(assets)
    .where(
      and(
        inArray(assets.parentAssetId, [...new Set(rootIds)]),
        isNull(assets.deletedAt),
        eq(assets.uploadStatus, 'uploaded'),
      ),
    )
    .orderBy(assets.parentAssetId, desc(assets.version));
  for (const r of rows) out.set(r.parentAssetId!, r);
  return out;
};

/** The current version of a root file: its newest version, else the root itself. */
export const currentOf = async (db: Db, root: AssetRow) => (await latestVersions(db, [root.id])).get(root.id) ?? root;

/** How many uploaded versions each root has, the root included (the trash's "· 3 versions"). */
export const versionCounts = async (db: Db, rootIds: string[]) => {
  const out = new Map<string, number>();
  if (!rootIds.length) return out;
  const ids = [...new Set(rootIds)];
  const root = sql<string>`coalesce(${assets.parentAssetId}, ${assets.id})`;
  const rows = await db
    .select({ root, n: sql<number>`count(*)::int` })
    .from(assets)
    .where(
      and(
        sql`(${inArray(assets.id, ids)} or ${inArray(assets.parentAssetId, ids)})`,
        isNull(assets.deletedAt),
        eq(assets.uploadStatus, 'uploaded'),
      ),
    )
    .groupBy(root);
  for (const r of rows) out.set(r.root, Number(r.n));
  return out;
};

/** Every version of a root (the root included), newest first, with the uploader's name. */
export const versionsOf = (db: Db, accountId: string, rootId: string) =>
  db
    .select({ asset: assets, ownerName: users.name })
    .from(assets)
    .leftJoin(users, eq(users.id, assets.ownerId))
    .where(
      and(
        eq(assets.accountId, accountId),
        sql`(${assets.id} = ${rootId} or ${assets.parentAssetId} = ${rootId})`,
        isNull(assets.deletedAt),
        eq(assets.uploadStatus, 'uploaded'),
      ),
    )
    .orderBy(desc(assets.version));

/**
 * The highest version number of a root (the current one is always the newest, so it is never deleted and its
 * number never reused). Locks the root row first: two uploads at once get consecutive numbers.
 */
export const maxVersionLocked = async (db: Db, rootId: string) => {
  await db.execute(sql`select id from assets where id = ${rootId} for update`);
  return Number(
    (
      (await db.execute(
        sql`select coalesce(max(version), 1) as v from assets where id = ${rootId} or parent_asset_id = ${rootId}`,
      )) as unknown as { rows: { v: number | string }[] }
    ).rows[0]?.v ?? 1,
  );
};

/** Makes an own upload a version of a root. */
export const setAsVersion = (db: Db, id: string, rootId: string, version: number) =>
  db.update(assets).set({ parentAssetId: rootId, version }).where(eq(assets.id, id));

// ---- cells ----
/** A cell's files in order: the root (the id the cell holds) and its current version (name, size, bytes). */
export const cellFileAssets = async (db: Db, itemId: string, columnId: string) => {
  const rows = await db
    .select({ asset: assets, addedBy: cellFiles.createdBy, addedAt: cellFiles.createdAt, position: cellFiles.position })
    .from(cellFiles)
    .innerJoin(assets, eq(assets.id, cellFiles.assetId))
    .where(and(eq(cellFiles.itemId, itemId), eq(cellFiles.columnId, columnId), isNull(assets.deletedAt)))
    .orderBy(asc(cellFiles.position));
  const latest = await latestVersions(
    db,
    rows.map((r) => r.asset.id),
  );
  return rows.map((r) => ({ ...r, current: latest.get(r.asset.id) ?? r.asset }));
};

/**
 * A files cell's row with its links (the cell value is their only home). `lock` = `for update`, so
 * two link edits on one cell queue instead of one losing the other.
 */
export const fileCellRow = async (db: Db, itemId: string, columnId: string, lock = false) => {
  const q = db
    .select({ value: cells.value })
    .from(cells)
    .where(and(eq(cells.itemId, itemId), eq(cells.columnId, columnId)))
    .limit(1);
  const row = (lock ? await q.for('update') : await q)[0];
  if (!row) return undefined;
  const links = (row.value as { links?: CellLink[] } | null)?.links;
  return { links: Array.isArray(links) ? links : [] };
};

/**
 * AI style examples: the `limit` newest usable images (uploaded, of `mimes`, at most `maxBytes`) of a
 * file column over these items, newest first (by when each was added to its cell).
 */
export const newestCellImages = async (
  db: Db,
  itemIds: string[],
  f: { columnId: string; mimes: readonly string[]; maxBytes: number },
  limit: number,
) => {
  if (!itemIds.length) return [];
  // The few candidate items' files, newest first; each judged (and returned) at its current version.
  const rows = await db
    .select({ asset: assets, itemId: cellFiles.itemId, addedAt: cellFiles.createdAt })
    .from(cellFiles)
    .innerJoin(assets, eq(assets.id, cellFiles.assetId))
    .where(and(inArray(cellFiles.itemId, itemIds), eq(cellFiles.columnId, f.columnId), isNull(assets.deletedAt)))
    .orderBy(desc(cellFiles.createdAt), desc(cellFiles.id));
  const latest = await latestVersions(
    db,
    rows.map((r) => r.asset.id),
  );
  return rows
    .map((r) => ({ ...r, asset: latest.get(r.asset.id) ?? r.asset }))
    .filter(
      (r) => r.asset.uploadStatus === 'uploaded' && f.mimes.includes(r.asset.mime ?? '') && r.asset.size <= f.maxBytes,
    )
    .slice(0, limit);
};

export const insertCellFiles = (db: Db, rows: (typeof cellFiles.$inferInsert)[]) =>
  rows.length ? db.insert(cellFiles).values(rows).onConflictDoNothing() : Promise.resolve();

export const deleteCellFile = (db: Db, itemId: string, columnId: string, assetId: string) =>
  db
    .delete(cellFiles)
    .where(and(eq(cellFiles.itemId, itemId), eq(cellFiles.columnId, columnId), eq(cellFiles.assetId, assetId)))
    .returning();

/** Items whose cells hold this asset — the access path for downloads. */
export const itemsHoldingAsset = async (db: Db, assetId: string) =>
  (await db.select({ itemId: cellFiles.itemId }).from(cellFiles).where(eq(cellFiles.assetId, assetId))).map(
    (r) => r.itemId,
  );

/** The cells (item + column, and their board) that carry this asset. */
export const cellsHoldingAsset = (db: Db, assetId: string) =>
  db
    .select({ itemId: cellFiles.itemId, columnId: cellFiles.columnId, boardId: cells.boardId })
    .from(cellFiles)
    .innerJoin(cells, and(eq(cells.itemId, cellFiles.itemId), eq(cells.columnId, cellFiles.columnId)))
    .where(eq(cellFiles.assetId, assetId));

// ---- updates ----
export const insertUpdateFiles = (db: Db, rows: (typeof updateFiles.$inferInsert)[]) =>
  rows.length ? db.insert(updateFiles).values(rows).onConflictDoNothing() : Promise.resolve();

export const updateFileAssets = (db: Db, updateIds: string[]) =>
  updateIds.length
    ? db
        .select({ updateId: updateFiles.updateId, position: updateFiles.position, asset: assets })
        .from(updateFiles)
        .innerJoin(assets, eq(assets.id, updateFiles.assetId))
        .where(and(inArray(updateFiles.updateId, updateIds), isNull(assets.deletedAt)))
        .orderBy(asc(updateFiles.position))
    : Promise.resolve([] as { updateId: string; position: string; asset: AssetRow }[]);

export const deleteUpdateFile = (db: Db, updateId: string, assetId: string) =>
  db.delete(updateFiles).where(and(eq(updateFiles.updateId, updateId), eq(updateFiles.assetId, assetId)));

/** Items whose (live) updates carry this asset. */
export const itemsWithUpdateAsset = async (db: Db, assetId: string) =>
  (
    await db
      .select({ itemId: updates.itemId })
      .from(updateFiles)
      .innerJoin(updates, eq(updates.id, updateFiles.updateId))
      .where(and(eq(updateFiles.assetId, assetId), isNull(updates.deletedAt)))
  ).map((r) => r.itemId);

/** The live updates that carry a file, with their authors (who may edit them — transcripts). */
export const updatesWithAsset = (db: Db, assetId: string) =>
  db
    .select({ updateId: updates.id, itemId: updates.itemId, boardId: updates.boardId, createdBy: updates.createdBy })
    .from(updateFiles)
    .innerJoin(updates, eq(updates.id, updateFiles.updateId))
    .where(and(eq(updateFiles.assetId, assetId), isNull(updates.deletedAt)));

/** A file version's transcript; null removes it. */
export const setAssetTranscript = (db: Db, assetId: string, transcript: Record<string, unknown> | null) =>
  db.update(assets).set({ transcript }).where(eq(assets.id, assetId));

// ---- storage cleanup (owner fix6-server 2) ----
/**
 * Whether the root file `r` is unused: no cell, update, doc (content or cover, M8), avatar, account logo, account
 * setting, agent knowledge source, support ticket or AI chat message holds it, and it is not a cell file waiting in
 * the trash. A version is in use exactly as long as its root is. Keep in sync with the worker's
 * `UNUSED` (apps/worker/src/repositories/files.repo.ts).
 */
const ROOT_UNUSED = sql`
      not exists (select 1 from cell_files f where f.asset_id = r.id)
      and not exists (select 1 from update_files u where u.asset_id = r.id)
      and not exists (select 1 from doc_assets d where d.asset_id = r.id)
      and not exists (select 1 from docs d where d.cover_asset_id = r.id)
      and not exists (select 1 from users x where x.avatar_asset_id = r.id)
      and not exists (select 1 from accounts x where x.logo_asset_id = r.id)
      and not exists (select 1 from account_settings s
                      where s.account_id = r.account_id and strpos(s.settings::text, r.id) > 0)
      and not exists (select 1 from agent_knowledge k where k.asset_id = r.id and k.deleted_at is null)
      and not exists (select 1 from support_ticket_attachments x where x.asset_id = r.id)
      and not exists (select 1 from ai_message_files m where m.asset_id = r.id)
      and not exists (select 1 from idoc_templates x where x.account_id = r.account_id
                      and (strpos(x.sections::text, r.id) > 0 or strpos(x.settings::text, r.id) > 0))
      and not exists (select 1 from idoc_docs x where x.account_id = r.account_id
                      and (strpos(x.sections::text, r.id) > 0 or strpos(x.settings::text, r.id) > 0))
      and not exists (select 1 from idoc_signatures x where x.file_asset_id = r.id)
      and not exists (select 1 from item_template_assets x where x.asset_id = r.id)
      and not exists (select 1 from trash_entries t where t.object_type = 'file' and t.object_id = r.id
                      and t.restored_at is null and t.purged_at is null)`;

/**
 * Of these assets of the account — and every version of the roots among them — the stored ones nothing uses.
 * Versions come first: a root's row goes last (its delete would cascade its versions' rows).
 */
export const unusedAssets = async (db: Db, accountId: string, ids: string[]) => {
  if (!ids.length) return [];
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const res = await db.execute(sql`
    select a.id, a.storage_key from assets a
    join assets r on r.id = coalesce(a.parent_asset_id, a.id)
    where a.account_id = ${accountId}
      and (a.id = any(array[${list}]::text[]) or a.parent_asset_id = any(array[${list}]::text[]))
      and a.storage_key is not null
      and ${ROOT_UNUSED}
    order by (a.parent_asset_id is null), a.version desc`);
  return (res as unknown as { rows: { id: string; storage_key: string }[] }).rows;
};

/** Deletes an asset row; a root only once its versions' rows are gone (so no version's object is ever orphaned). */
export const deleteAssetRow = (db: Db, accountId: string, id: string) =>
  db
    .delete(assets)
    .where(
      and(
        eq(assets.accountId, accountId),
        eq(assets.id, id),
        sql`not exists (select 1 from assets v where v.parent_asset_id = ${id})`,
      ),
    );
