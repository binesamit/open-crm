// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes, EXPORT_MAX_ITEMS, querySchema, t, todayIn, toCsv, type ExportRequest } from '@bines/shared';
import type { Db } from '../../db/client';
import { toXlsx, XLSX_TYPE } from '../../lib/xlsx';
import { recordEvent } from '../activity/activity.repo';
import { actorRegion } from '../accounts/region';
import { loadBoardAccess } from '../boards/boards.access';
import { findSubBoard, listGroups } from '../boards/boards.repo';
import { listItems, visibleColumns, type Actor } from '../items/items.service';
import { queryItems } from '../items/query.service';

/**
 * Board → .xlsx / .csv (M6 stage 8). Rows = the query's items (or the selection) the person may see, columns = the
 * view's visible columns in its order (column restrictions apply), the group as the second column. Values are the
 * cells' text — dates in the reader's region (A3, the items' DTO texts); numbers stay numbers in Excel.
 */
export const exportBoard = async (db: Db, a: Actor, boardId: string, req: ExportRequest) => {
  const { access, header, rows, region, selection } = await boardExportRows(db, a, boardId, req);

  await recordEvent(db, {
    accountId: a.ctx.accountId,
    type: 'board.exported',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId,
    meta: { format: req.format, rows: rows.length, selection },
  });

  // The file name keeps a sortable YYYY-MM-DD, of today in the reader's zone.
  const date = todayIn(region);
  const name = `${access.board.name} ${date}.${req.format}`;
  if (req.format === 'csv')
    return { body: Buffer.from(toCsv(header, rows), 'utf8'), type: 'text/csv; charset=utf-8', name };
  return { body: toXlsx(access.board.name, header, rows), type: XLSX_TYPE, name };
};

/**
 * Every item the query matches, in one read (the account export: no row cap). Pages of 2000 walked by cursor
 * repeated or skipped a row when an item was created or deleted meanwhile (audit 2026-10-10 B1).
 */
const allItems = async (db: Db, a: Actor, boardId: string, query: ReturnType<typeof querySchema.parse>) =>
  (await queryItems(db, a, boardId, query, { limit: null })).data;

/**
 * The rows of a board's export (the header, then one row per item and its subitems) — the board download's and the
 * account export's (`all`: every item, no cap). Throws 404 for a board the actor may not read.
 */
export const boardExportRows = async (
  db: Db,
  a: Actor,
  boardId: string,
  req: ExportRequest,
  opts: { all?: boolean } = {},
) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const query = querySchema.parse({ ...(req.query ?? {}), scope: 'parents' });
  const found = opts.all
    ? await allItems(db, a, boardId, query)
    : (await queryItems(db, a, boardId, query, { limit: EXPORT_MAX_ITEMS })).data;
  const wanted = req.item_ids ? new Set(req.item_ids) : null;
  const items = found.filter((i) => i.depth === 0 && (!wanted || wanted.has(i.id)));

  const visible = (await visibleColumns(db, access)).filter((c) => c.type !== 'name');
  const order = req.columns?.length
    ? req.columns.flatMap((k) => visible.filter((c) => c.key === k))
    : [...visible].sort((x, y) => (x.position < y.position ? -1 : x.position > y.position ? 1 : 0));
  const groups = new Map((await listGroups(db, boardId)).map((g) => [g.id, g.title]));
  const numeric = (type: string) => columnTypes.get(type)?.filterModel === 'number';

  type Row = (typeof items)[number];
  const valueOf = (i: Row, c: { key: string; type: string }) => {
    const cell = i.cells[c.key];
    if (!cell) return '';
    if (req.format === 'xlsx' && numeric(c.type) && typeof cell.value === 'number') return cell.value;
    return cell.text ?? '';
  };

  // Subitems (D14): the sub-board's items I may see, under their parent, indented by depth.
  const subBoard = req.include_subitems && !access.board.parentBoardId ? await findSubBoard(db, boardId) : null;
  const subColumns = subBoard
    ? (await visibleColumns(db, await loadBoardAccess(db, a.ctx, a.user, subBoard.id))).filter((c) => c.type !== 'name')
    : [];
  const byParent = new Map<string, Row[]>();
  if (subBoard)
    for (const s of await listItems(db, a, subBoard.id)) {
      const list = byParent.get(s.parent_item_id!) ?? [];
      list.push(s);
      byParent.set(s.parent_item_id!, list);
    }
  const blanks = (n: number) => Array.from({ length: n }, () => '');

  const region = await actorRegion(db, a);
  const header = [
    t('export.name', undefined, region.language),
    t('export.group', undefined, region.language),
    ...order.map((c) => c.title),
    ...subColumns.map((c) => t('export.sub_column', { title: c.title }, region.language)),
  ];
  const rows: (string | number)[][] = [];
  const addSubs = (parentId: string, depth: number) => {
    for (const s of byParent.get(parentId) ?? []) {
      rows.push([
        `${'  '.repeat(depth - 1)}↳ ${s.name}`,
        '',
        ...blanks(order.length),
        ...subColumns.map((c) => valueOf(s, c)),
      ]);
      addSubs(s.id, depth + 1);
    }
  };
  for (const i of items) {
    rows.push([
      i.name,
      (i.group_id && groups.get(i.group_id)) || '',
      ...order.map((c) => valueOf(i, c)),
      ...blanks(subColumns.length),
    ]);
    addSubs(i.id, 1);
  }
  return { access, header, rows, region, selection: !!wanted };
};

/** `attachment; filename=…` safe for Hebrew names (RFC 6266 / 5987). */
export const contentDisposition = (name: string) =>
  `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
