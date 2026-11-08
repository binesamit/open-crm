// SPDX-License-Identifier: AGPL-3.0-only
import { getRegion } from '@bines/shared';
import { useMemo } from 'react';
import {
  applyPlan,
  type BulkEnv,
  descendantsOf,
  GROUP_COLUMN,
  planQuery,
  planUsesSubitems,
  pruneQuery,
  type Query,
  querySchema,
  type SheetColumn,
  sheetColumns,
  type SheetRow,
  sheetText,
  SUB_COLUMN_PREFIX,
  subSheetColumns,
  t,
} from '@bines/shared';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../../lib/api';
import { type BoardDetail, boardKeys, type Item, useBoard, useItems } from '../board-api';
import type { FilterCtx } from '../toolbar/FilterPanel';

/**
 * The sheet of a bulk edit (12-ROADMAP decision 2): what the current view shows — its filters and search, its
 * order, its visible columns — with the name first and the group column (for new rows) last. Every row as text.
 * With a sub-board, also the subitems sheet (B4): every subitem under the items of the sheet (all levels, in tree
 * order), the sub-board's columns, and the parent column (the parent's name) last.
 */
export const useSheet = (
  accountId: string,
  board: BoardDetail,
  ctx: FilterCtx,
  view: { query?: Partial<Query>; columns?: string[] },
) => {
  const cached = useItems(accountId, board.id).data;
  // A windowed board's cache holds only the rows seen so far: the sheet loads the whole board for itself.
  const whole = useQuery({
    queryKey: [...boardKeys.items(accountId, board.id), 'whole'],
    queryFn: () => api(accountId).get<{ data: Item[] }>(`/boards/${board.id}/items`),
    enabled: !!cached?.windowed,
  });
  const items = cached?.windowed ? whole.data?.data : cached?.data;
  const env = ctx.env;
  const query = useMemo(() => {
    try {
      return pruneQuery(querySchema.parse(view.query ?? {}), env);
    } catch {
      return querySchema.parse({});
    }
  }, [view.query, env]);
  const plan = useMemo(() => {
    try {
      return planQuery(query, env);
    } catch {
      return planQuery(querySchema.parse({}), env);
    }
  }, [query, env]);
  const usesSubitems = planUsesSubitems(plan);
  const subId = board.subitems_board_id ?? '';
  const subItems = useItems(accountId, subId).data?.data;
  const subBoard = useBoard(accountId, subId).data;

  const columns = useMemo<SheetColumn[]>(() => {
    const name = board.columns.find((c) => c.type === 'name');
    const shown = (view.columns ?? board.columns.map((c) => c.id))
      .map((id) => board.columns.find((c) => c.id === id))
      .filter((c): c is BoardDetail['columns'][number] => !!c && c.type !== 'name');
    return sheetColumns([
      ...(name ? [name] : [{ id: 'name', type: 'name', title: t('bulk.name'), settings: {} }]),
      ...shown,
      { id: GROUP_COLUMN, type: 'group', title: t('bulk.groupColumn'), settings: {} },
    ]);
  }, [board.columns, view.columns]);

  const rows = useMemo<SheetRow[] | null>(() => {
    if (!items || (subId && !subItems)) return null;
    const top = items.filter((i) => i.depth === 0);
    let list: Item[] = top;
    if (usesSubitems) {
      const byParent = new Map<string, Item[]>();
      for (const it of subItems ?? []) {
        if (!it.parent_item_id) continue;
        byParent.set(it.parent_item_id, [...(byParent.get(it.parent_item_id) ?? []), it]);
      }
      list = top.map((i) => ({ ...i, subitems: descendantsOf(byParent, i.id) }));
    }
    const groupRank = new Map(board.groups.map((g, i) => [g.id, i]));
    const matched = applyPlan(list, plan, env.timezone, query.group_by ? undefined : groupRank);
    // The table shows groups in board order (or the group-by buckets in the plan's order).
    const ordered = query.group_by ? matched : board.groups.flatMap((g) => matched.filter((i) => i.group_id === g.id));
    const groupTitle = new Map(board.groups.map((g) => [g.id, g.title]));
    return ordered.map((i) => ({
      key: i.id,
      itemId: i.id,
      groupId: i.group_id,
      texts: Object.fromEntries(
        columns.map((c) => [
          c.id,
          c.mode === 'name'
            ? i.name
            : c.mode === 'group'
              ? (groupTitle.get(i.group_id ?? '') ?? '')
              : sheetText(c.type, i.cells[c.id]),
        ]),
      ),
      // which secret cells have a value (shown masked; never their text).
      secrets: columns.filter((c) => c.mode === 'secret' && i.cells[c.id]?.value).map((c) => c.id),
    }));
  }, [items, subItems, usesSubitems, subId, board.groups, plan, env.timezone, query.group_by, columns]);

  const bulkEnv = useMemo<BulkEnv>(
    () => ({
      people: [
        ...ctx.members
          .filter((m) => m.status !== 'deactivated')
          .map((m) => ({ id: m.user_id, kind: 'person' as const, name: m.name || m.email, email: m.email })),
        ...ctx.teams.map((x) => ({ id: x.id, kind: 'team' as const, name: x.name })),
      ],
      tags: ctx.tags.map((x) => ({ id: x.id, name: x.name })),
      groups: board.groups.map((g) => ({ id: g.id, title: g.title })),
      // A date typed with a time is wall-clock in the account's zone (audit 2026-10-10 A1).
      region: getRegion(),
    }),
    [ctx.members, ctx.teams, ctx.tags, board.groups],
  );

  // ---- the subitems sheet (B4) ----
  const subColumns = useMemo<SheetColumn[] | null>(() => {
    if (!subBoard) return null;
    const name = subBoard.columns.find((c) => c.type === 'name');
    return subSheetColumns(
      [
        ...(name ? [name] : [{ id: 'name', type: 'name', title: t('bulk.name'), settings: {} }]),
        ...subBoard.columns.filter((c) => c.type !== 'name'),
      ],
      t('bulk.parentColumn'),
    );
  }, [subBoard]);

  const subRows = useMemo<SheetRow[] | null>(() => {
    if (!rows || !subItems || !subColumns) return null;
    const byParent = new Map<string, Item[]>();
    for (const it of subItems) {
      if (!it.parent_item_id) continue;
      byParent.set(it.parent_item_id, [...(byParent.get(it.parent_item_id) ?? []), it]);
    }
    for (const list of byParent.values())
      list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    const names = new Map<string, string>([
      ...(items ?? []).map((i): [string, string] => [i.id, i.name]),
      ...subItems.map((i): [string, string] => [i.id, i.name]),
    ]);
    return rows.flatMap((r) =>
      descendantsOf(byParent, r.itemId!).map((i) => ({
        key: i.id,
        itemId: i.id,
        groupId: null,
        parentId: i.parent_item_id,
        depth: i.depth,
        texts: Object.fromEntries(
          subColumns.map((c) => [
            c.id,
            c.mode === 'name'
              ? i.name
              : c.mode === 'parent'
                ? (names.get(i.parent_item_id ?? '') ?? '')
                : sheetText(c.type, i.cells[c.id.slice(SUB_COLUMN_PREFIX.length)]),
          ]),
        ),
        secrets: subColumns
          .filter((c) => c.mode === 'secret' && i.cells[c.id.slice(SUB_COLUMN_PREFIX.length)]?.value)
          .map((c) => c.id),
      })),
    );
  }, [rows, items, subItems, subColumns]);

  const sub = subId
    ? { columns: subColumns, rows: subRows, maxDepth: board.hierarchy_depth_max, boardId: subId }
    : null;
  return { columns, rows, env: bulkEnv, sub };
};
