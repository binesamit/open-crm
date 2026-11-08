// SPDX-License-Identifier: AGPL-3.0-only
import type { SqlClient } from './trash.repo';

/**
 * A stored file nothing points at (07 §5.2), judged by its root `r` (the asset itself, or for a file version — prod
 * the file it is a version of: a version is in use exactly as long as its file is): no cell, update, doc
 * (its content or cover, M8), avatar, account logo, account setting (branding logos), agent knowledge source (מ9),
 * support ticket, AI chat message or interactive document uses it, and it is not a cell file
 * waiting in the trash. Keep in sync (test/files-sweep-sync.test.ts in the API checks it)
 * with `unusedAssets` in apps/api/src/modules/files/files.repo.ts.
 */
const UNUSED = `a.storage_key is not null
  and not exists (select 1 from cell_files f where f.asset_id = r.id)
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

/** Each asset with its root (itself, or the file it is a version of). */
const WITH_ROOT = 'from assets a join assets r on r.id = coalesce(a.parent_asset_id, a.id)';
/** Versions before roots: a root's row goes last (deleting it cascades its versions' rows). */
const VERSIONS_FIRST = '(a.parent_asset_id is null), a.created_at';

export type StoredAsset = { id: string; storage_key: string };

/**
 * Orphans whose file is older than `graceHours`: uploads that were never attached (a composer draft thrown away, a
 * closed tab) and anything else left unused — removed from storage (R2) and the database by the periodic sweep.
 */
export const orphanAssets = async (db: SqlClient, limit: number, graceHours: number) =>
  (
    await db.query(
      `select a.id, a.storage_key ${WITH_ROOT}
       where r.created_at < now() - make_interval(hours => $2) and ${UNUSED}
       order by ${VERSIONS_FIRST}
       limit $1`,
      [limit, graceHours],
    )
  ).rows as StoredAsset[];

/** Of these assets (and the versions of those that are files), the ones nothing uses any more. */
export const unusedAssets = async (db: SqlClient, ids: string[]) =>
  ids.length
    ? ((
        await db.query(
          `select a.id, a.storage_key ${WITH_ROOT}
           where (a.id = any($1::text[]) or a.parent_asset_id = any($1::text[])) and ${UNUSED}
           order by ${VERSIONS_FIRST}`,
          [ids],
        )
      ).rows as StoredAsset[])
    : [];

/** A root's row only once its versions' rows are gone (so no version's object is ever left behind). */
export const deleteAsset = (db: SqlClient, id: string) =>
  db.query('delete from assets where id = $1 and not exists (select 1 from assets v where v.parent_asset_id = $1)', [
    id,
  ]);
