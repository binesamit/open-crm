// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Trash purge (07 §5.2): rows whose trash entry passed `purge_after` (30 days, or "delete permanently") are
 * removed for good. Runs on any client with `query(text, values)` — pg in the worker, PGlite in tests.
 */
export type SqlClient = { query: (text: string, values?: unknown[]) => Promise<{ rows: unknown[] }> };

export type DueEntry = { id: string; object_type: string; object_id: string };

/** Entries of children that disappear with the object (so they never point at missing rows). */
const CHILD_ENTRIES: Record<string, string> = {
  board: `update trash_entries set purged_at = now()
          where board_id = $1 and object_type <> 'board' and restored_at is null and purged_at is null`,
  group: `update trash_entries set purged_at = now()
          where object_type = 'item' and restored_at is null and purged_at is null
            and object_id in (select id from items where group_id = $1)`,
};

/** Statements per object type, run in order with `$1` = object id. */
const PURGE: Record<string, string[]> = {
  // Subitems, cells, links and updates go by FK cascade.
  item: ['delete from items where id = $1'],
  // items.group_id is ON DELETE RESTRICT: the group's items go first.
  group: ['delete from items where group_id = $1', 'delete from groups where id = $1'],
  // The column row stays as a tombstone: its key is never reused on the board (03 §1).
  column: ['delete from item_links where column_id = $1', 'delete from cells where column_id = $1'],
  view: ['delete from views where id = $1'],
  update: ['delete from updates where id = $1'],
  // The sub-board (D14) and its items go with the board.
  board: [
    'delete from items where board_id in (select id from boards where parent_board_id = $1)',
    'delete from items where board_id = $1',
    'delete from boards where id = $1',
  ],
  folder: ['delete from folders where id = $1'],
  // Only empty workspaces are deleted; their folders cascade.
  workspace: ['delete from workspaces where id = $1'],
  // M8: its members and file links cascade.
  doc: ['delete from docs where id = $1'],
  // M8 ד4: its members and widgets cascade.
  dashboard: ['delete from dashboards where id = $1'],
  // no row to delete — once the entry is purged nothing holds the file, and it leaves storage with
  // all its versions (`ASSETS_OF.file` → unusedAssets).
  file: [],
};

/** The items an object takes with it (subitems at every depth, D14), as SQL over `$1` = object id. */
const ITEMS_OF: Record<string, string> = {
  item: `with recursive t(id) as (
           select id from items where id = $1
           union all select i.id from items i join t on i.parent_item_id = t.id)
         select id from t`,
  group: `with recursive t(id) as (
            select id from items where group_id = $1
            union all select i.id from items i join t on i.parent_item_id = t.id)
          select id from t`,
  board: `select id from items where board_id = $1 or board_id in (select id from boards where parent_board_id = $1)`,
};

/** Files an object's rows hold (cells and updates, replies too) — candidates to leave storage after the purge. */
const ASSETS_OF: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(ITEMS_OF).map(([type, items]) => [
      type,
      `select f.asset_id from cell_files f where f.item_id in (${items})
       union select uf.asset_id from update_files uf join updates u on u.id = uf.update_id
       where u.item_id in (${items})`,
    ]),
  ),
  column: 'select asset_id from cell_files where column_id = $1',
  update: `select asset_id from update_files
           where update_id in (select id from updates where id = $1 or parent_update_id = $1)`,
  doc: 'select asset_id from doc_assets where doc_id = $1',
  // A file removed from a cell: the file; its versions go with it (`unusedAssets`).
  file: 'select $1::varchar as asset_id',
};
// A board's purge also ends the trash entries of files removed from its cells (CHILD_ENTRIES): their files too.
ASSETS_OF.board = `${ASSETS_OF.board}
  union select object_id from trash_entries
  where board_id = $1 and object_type = 'file' and restored_at is null and purged_at is null`;

export const assetsOfEntry = async (db: SqlClient, e: DueEntry): Promise<string[]> => {
  const q = ASSETS_OF[e.object_type];
  return q ? ((await db.query(q, [e.object_id])).rows as { asset_id: string }[]).map((r) => r.asset_id) : [];
};

export const dueTrashEntries = async (db: SqlClient, limit: number) =>
  (
    await db.query(
      `select id, object_type, object_id from trash_entries
       where restored_at is null and purged_at is null and purge_after <= now()
       order by purge_after limit $1`,
      [limit],
    )
  ).rows as DueEntry[];

/** Removes one object and marks its entry purged, in one transaction. */
export const purgeTrashEntry = async (db: SqlClient, e: DueEntry) => {
  await db.query('begin');
  try {
    const children = CHILD_ENTRIES[e.object_type];
    if (children) await db.query(children, [e.object_id]);
    for (const q of PURGE[e.object_type] ?? []) await db.query(q, [e.object_id]);
    await db.query('update trash_entries set purged_at = now() where id = $1', [e.id]);
    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
};
