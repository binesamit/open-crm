// SPDX-License-Identifier: AGPL-3.0-only
import { sql } from 'drizzle-orm';
import type { BoardFile } from '@bines/shared';
import type { Db } from '../../db/client';
import { assertBoard, columnAllowed, loadBoardAccess } from '../boards/boards.access';
import { findSubBoard, listColumns } from '../boards/boards.repo';
import { itemsByIds } from '../items/items.repo';
import type { Actor } from '../items/items.service';
import { visibleAcrossBoards } from '../items/visibility';

/** Files read for one board view (the newest first); more is a sign the view should filter. */
export const BOARD_FILES_MAX = 2000;

type Row = {
  id: string;
  name: string;
  size: number | string;
  mime: string;
  created_at: Date | string;
  owner_id: string | null;
  item_id: string;
  column_id: string | null;
  update_id: string | null;
};

/**
 * The Files view (M8 ד9): every file on a board — in file columns and attached to updates and replies, of its
 * items and their subitems — that the reader may see: items through the board's `view_items` rule, file columns
 * through their view restriction. Newest first.
 */
export const boardFiles = async (db: Db, a: Actor, boardId: string): Promise<{ data: BoardFile[]; total: number }> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const sub = await findSubBoard(db, boardId);
  const boardIds = [boardId, ...(sub ? [sub.id] : [])];
  const columns = (await Promise.all(boardIds.map((b) => listColumns(db, b)))).flat();
  const subAccess = sub ? await loadBoardAccess(db, a.ctx, a.user, sub.id) : null;
  const allowedColumns = new Map(
    columns
      .filter((c) => columnAllowed(c.boardId === boardId ? access : (subAccess ?? access), c.restrictedView))
      .map((c) => [c.id, c]),
  );
  const ids = sql.join(
    boardIds.map((b) => sql`${b}`),
    sql`, `,
  );
  const rows = (
    (await db.execute(sql`
    select * from (
      select a.id, coalesce(cur.file_name, a.file_name) as name, coalesce(cur.size, a.size) as size,
        coalesce(cur.mime, a.mime) as mime, f.created_at, coalesce(f.created_by, a.owner_id) as owner_id,
        f.item_id, f.column_id, null::varchar as update_id
      from cell_files f
      join assets a on a.id = f.asset_id and a.deleted_at is null and a.upload_status = 'uploaded'
      -- the file's current version; none = the file is its only version
      left join lateral (
        select v.file_name, v.size, v.mime from assets v
        where v.parent_asset_id = a.id and v.deleted_at is null and v.upload_status = 'uploaded'
        order by v.version desc limit 1
      ) cur on true
      join items i on i.id = f.item_id and i.deleted_at is null and i.archived_at is null
      join columns col on col.id = f.column_id and col.deleted_at is null
      where f.account_id = ${a.ctx.accountId} and i.board_id in (${ids})
      union all
      select a.id, a.file_name, a.size, a.mime, uf.created_at, a.owner_id, u.item_id, null, u.id
      from update_files uf
      join assets a on a.id = uf.asset_id and a.deleted_at is null and a.upload_status = 'uploaded'
      join updates u on u.id = uf.update_id and u.deleted_at is null
      join items i on i.id = u.item_id and i.deleted_at is null and i.archived_at is null
      where uf.account_id = ${a.ctx.accountId} and i.board_id in (${ids})
    ) f
    order by created_at desc
    limit ${BOARD_FILES_MAX + 1}`)) as { rows: Row[] }
  ).rows;
  const items = await itemsByIds(db, a.ctx.accountId, [...new Set(rows.map((r) => r.item_id))]);
  const visible = await visibleAcrossBoards(db, a, items);
  const byId = new Map(items.map((i) => [i.id, i]));
  const data = rows
    .filter((r) => visible.has(r.item_id) && (!r.column_id || allowedColumns.has(r.column_id)))
    .slice(0, BOARD_FILES_MAX)
    .map((r) => {
      const item = byId.get(r.item_id)!;
      const col = r.column_id ? allowedColumns.get(r.column_id) : undefined;
      return {
        id: r.id,
        name: r.name,
        size: Number(r.size),
        mime: r.mime,
        created_at: new Date(r.created_at).toISOString(),
        uploaded_by: r.owner_id,
        item_id: r.item_id,
        item_name: item.name,
        parent_item_id: item.parentItemId,
        source: r.update_id ? ('update' as const) : ('cell' as const),
        column_id: col?.key ?? null,
        column_title: col?.title ?? null,
        update_id: r.update_id,
      };
    });
  return { data, total: data.length };
};
