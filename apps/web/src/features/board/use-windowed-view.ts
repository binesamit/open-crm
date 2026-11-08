// SPDX-License-Identifier: AGPL-3.0-only
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  EMPTY_BUCKET,
  GROUP_PATH_SEP,
  encodeQuery,
  type Field,
  type FilterGroup,
  GROUP_PALETTE,
  paint,
  isEmptyFilter,
  type OutlineRequestInput,
  type OutlineSection,
  type Query,
  type QueryEnv,
  resolveField,
  summaryOptions,
  t,
  type GroupDateUnit,
  type ViewSettings,
  type ViewType,
} from '@bines/shared';
import { api } from '../../lib/api';
import type { BoardDetail, Column, Item, Member, Tag } from './board-api';
import { groupColor, groupSummaryFn, groupSummaryOptions, type Section } from './table/BoardTable';
import { kanbanColumns } from './views/KanbanView';
import { outlineKey, stubItem, useOutline, useWindowRows } from './windowed';
import { dateGroupLabel, groupCountryName } from './date-group';
import { levelSeed, viewLevels } from './nested-sections';

const BUCKET_COLORS = GROUP_PALETTE.map((k) => paint(k));
const EMPTY_COLOR = 'var(--status-empty)';
/** Kanban lanes and Cards show this many loaded cards at first, and as many more per "show more". */
const CARDS_PAGE = 30;
/** Views that show the items of a date range (calendar, timeline, Gantt, workload): loaded by that range. */
const DATED_VIEWS: ViewType[] = ['calendar', 'timeline', 'gantt', 'workload'];

/** The footers a table shows (the view's choice per visible column, else the type's default) — none = skipped. */
const footerRequests = (columnIds: string[], env: QueryEnv, choices: ViewSettings['summaries']) =>
  columnIds.flatMap((id) => {
    try {
      const options = summaryOptions(resolveField(id, env));
      const fn = options.find((o) => o === choices[id]) ?? options[0];
      return fn && fn !== 'none' ? [{ column_id: id, fn }] : [];
    } catch {
      return [];
    }
  });

/** A bucket's title as the browser names it (its own people / tag names, translated date buckets). */
const bucketTitle = (
  field: Field,
  b: OutlineSection,
  names: Map<string, string>,
  g?: { date_unit?: GroupDateUnit; mode?: string },
) => {
  if (b.key === EMPTY_BUCKET) return t('group.empty');
  if (field.model === 'checkbox') return t('group.checked');
  if (field.model === 'people' || field.model === 'tags') return names.get(b.key) ?? b.label ?? b.key;
  if (field.model === 'date') return dateGroupLabel(b.key, g?.date_unit);
  // ק2: a phone's / an address's country by its name; a team by its name.
  if (g?.mode === 'country') return groupCountryName(b.key);
  if (g?.mode === 'team') return names.get(b.key) ?? b.label ?? b.key;
  return b.label ?? b.key;
};

/**
 * The board page's data on a windowed board (perf review §7.1): sections / lanes / cards built from the server's
 * outline, with placeholder rows for ids not loaded yet, and `onRange` to load the rows that come into view.
 * Null on a normal board (everything is computed in the browser as before).
 */
export const useWindowedView = (p: {
  accountId: string;
  board: BoardDetail;
  windowed: boolean;
  viewType: ViewType;
  query: Query;
  env: QueryEnv;
  settings: ViewSettings;
  /** The table's visible columns, in order (footers). */
  columns: Column[];
  items: Item[];
  members: Member[];
  tags: Tag[] | undefined;
  /** The account's teams ("by team" bucket names). */
  teams?: { id: string; name: string }[];
  seedOf: (field: Field, key: string, rows?: Item[], title?: string) => Section['seed'];
}) => {
  const { accountId, board, windowed, viewType, query, env, settings, columns, items, members, tags, teams, seedOf } =
    p;
  const need = useWindowRows(accountId, board.id, windowed);

  const laneColumn = useMemo(() => {
    if (viewType !== 'kanban') return undefined;
    const choices = kanbanColumns(board, env);
    return (choices.find((c) => c.id === settings.kanban?.column_id) ?? choices[0])?.id;
  }, [viewType, board, env, settings.kanban?.column_id]);

  const columnIds = useMemo(() => columns.map((c) => c.id), [columns]);
  const request = useMemo<OutlineRequestInput | null>(() => {
    if (!windowed || DATED_VIEWS.includes(viewType)) return null;
    if (viewType === 'table') {
      const gs = settings.group_summary;
      const gsOptions = gs ? groupSummaryOptions(gs.column_id, env) : [];
      return {
        query,
        summaries: footerRequests(columnIds, env, settings.summaries),
        group_summary:
          gs && gsOptions.length
            ? { column_id: gs.column_id, fn: groupSummaryFn(gs, settings.summaries[gs.column_id], gsOptions) }
            : null,
        layout: 'groups',
      };
    }
    if (viewType === 'kanban' && !laneColumn) return null;
    return {
      query: { ...query, group_by: undefined },
      layout: 'flat',
      ...(viewType === 'kanban' ? { lanes_by: laneColumn } : {}),
    };
  }, [windowed, viewType, query, env, columnIds, settings.summaries, settings.group_summary, laneColumn]);
  const outline = useOutline(accountId, board.id, request);
  const od = outline.data;

  const loaded = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // The table: board groups (every one, or those with matches when filtering) or the buckets of a grouping.
  const sections = useMemo<Section[] | null>(() => {
    if (!windowed || viewType !== 'table' || !od) return null;
    const rowOf = (id: string, groupId: string | null) => loaded.get(id) ?? stubItem(id, board.id, groupId);
    // Prod ק3: the server's nested outline — each node in tree order; keys as the browser builds them.
    if (query.subgroups?.length) {
      const levels = viewLevels(query, env);
      if (levels.length < 2) return null;
      if (!od.sections.some((s) => s.level !== undefined)) return null; // the previous outline, still on screen
      const names = new Map([
        ...members.map((mb) => [mb.user_id, mb.name || mb.email] as const),
        ...(tags ?? []).map((x) => [x.id, `#${x.name}`] as const),
        ...(teams ?? []).map((x) => [x.id, x.name] as const),
      ]);
      const last = levels.length - 1;
      const seeds = new Map<string, Section['seed'] | null>();
      return od.sections.map((b, i) => {
        const level = b.level ?? 0;
        const lv = levels[level]!;
        const parts = b.key.split(GROUP_PATH_SEP);
        const own = parts.at(-1)!;
        const keyOf = (n: number) =>
          parts
            .slice(0, n)
            .map((k, j) => `${levels[j]!.field.id}:${k}`)
            .join(GROUP_PATH_SEP);
        const key = keyOf(parts.length);
        const group = lv.g ? undefined : board.groups.find((g) => g.id === own);
        const title = group ? group.title : bucketTitle(lv.field, { ...b, key: own }, names, lv.g);
        const rows = b.ids.map((id) => rowOf(id, group?.id ?? null));
        const seed = levelSeed({ board, env, members }, lv, own, rows, title, seeds.get(keyOf(parts.length - 1)));
        seeds.set(key, seed);
        const header = level < last;
        return {
          key,
          title,
          color: group
            ? groupColor(group)
            : (paint(b.color) ?? (own === EMPTY_BUCKET ? EMPTY_COLOR : BUCKET_COLORS[i % BUCKET_COLORS.length]!)),
          items: rows,
          level,
          column: lv.field.id,
          bucket: own,
          ...(header ? { header: true, count: b.count ?? 0, ...(group ? { group } : {}) } : seed ? { seed } : {}),
          summaries: b.summaries,
          groupSummary: b.group_summary ?? null,
        };
      });
    }
    const groupBy = query.group_by;
    if (groupBy) {
      if (od.grouped_by !== groupBy.column_id) return null; // the previous view's outline, still on screen
      let field: Field;
      try {
        field = resolveField(groupBy.column_id, env);
      } catch {
        return null;
      }
      const names = new Map([
        ...members.map((mb) => [mb.user_id, mb.name || mb.email] as const),
        ...(tags ?? []).map((x) => [x.id, `#${x.name}`] as const),
        ...(teams ?? []).map((x) => [x.id, x.name] as const),
      ]);
      return od.sections.map((b, i) => {
        const title = bucketTitle(field, b, names, groupBy);
        const rows = b.ids.map((id) => rowOf(id, null));
        return {
          key: `${groupBy.column_id}:${b.key}`,
          title,
          color: paint(b.color) ?? (b.key === EMPTY_BUCKET ? EMPTY_COLOR : BUCKET_COLORS[i % BUCKET_COLORS.length]!),
          items: rows,
          // Loaded rows only (stubs have no cells): a value without a key of its own is copied from one of them.
          seed: seedOf(field, b.key, rows, title),
          summaries: b.summaries,
          groupSummary: b.group_summary ?? null,
        };
      });
    }
    if (od.grouped_by) return null;
    const byKey = new Map(od.sections.map((s) => [s.key, s]));
    const filtered = !isEmptyFilter(query);
    return board.groups
      .map((g) => {
        const s = byKey.get(g.id);
        return {
          key: g.id,
          title: g.title,
          color: groupColor(g),
          group: g,
          items: (s?.ids ?? []).map((id) => rowOf(id, g.id)),
          summaries: s?.summaries ?? {},
          groupSummary: s?.group_summary ?? null,
        };
      })
      .filter((s) => !filtered || s.items.length > 0);
  }, [windowed, viewType, od, loaded, board, query, env, members, tags, teams, seedOf]);

  // Kanban lanes and Cards: the first cards of each lane (or of the list), loaded; more on demand.
  const [limits, setLimits] = useState<Record<string, number>>({});
  const cardIds = useMemo(() => {
    if (!windowed || !od || (viewType !== 'kanban' && viewType !== 'cards')) return [];
    if (viewType === 'kanban' && od.grouped_by !== laneColumn) return [];
    const ids = od.sections.flatMap((s) => s.ids.slice(0, limits[s.key] ?? CARDS_PAGE));
    return [...new Set(ids)];
  }, [windowed, od, viewType, laneColumn, limits]);
  useEffect(() => {
    if (cardIds.length) need(cardIds, 'cards');
  }, [cardIds, need]);
  const more = useCallback(
    (key: string) => setLimits((prev) => ({ ...prev, [key]: (prev[key] ?? CARDS_PAGE) + CARDS_PAGE })),
    [],
  );
  const cards = useMemo(() => cardIds.flatMap((id) => loaded.get(id) ?? []), [cardIds, loaded]);
  const laneTotals = useMemo(() => Object.fromEntries((od?.sections ?? []).map((s) => [s.key, s.ids.length])), [od]);

  // Calendar: the items of the days on screen, by the view's query plus the date range.
  const [range, setRange] = useState<{ columnId: string; first: string; last: string } | null>(null);
  const onCalendarRange = useCallback(
    (columnId: string, first: string, last: string) =>
      setRange((cur) =>
        cur?.columnId === columnId && cur.first === first && cur.last === last ? cur : { columnId, first, last },
      ),
    [],
  );
  const calendar = useQuery({
    queryKey: outlineKey(accountId, board.id, ['calendar', query, range]),
    queryFn: () => {
      const rule = {
        kind: 'rule' as const,
        column_id: range!.columnId,
        operator: 'between' as const,
        values: [range!.first, range!.last],
        negate: false,
      };
      const filter: FilterGroup = {
        kind: 'group',
        operator: 'and',
        negate: false,
        rules: [...(query.filter ? [query.filter] : []), rule],
      };
      const q = encodeQuery({ ...query, group_by: undefined, filter });
      return api(accountId).get<{ data: Item[] }>(`/boards/${board.id}/items?q=${q}`);
    },
    enabled: windowed && DATED_VIEWS.includes(viewType) && !!range,
    placeholderData: keepPreviousData,
  });

  const tableItems = useMemo(
    () => (sections ? [...new Map(sections.flatMap((s) => s.items).map((i) => [i.id, i])).values()] : []),
    [sections],
  );
  const kanban = useMemo(() => ({ totals: laneTotals, onMore: more }), [laneTotals, more]);
  const cardsMore = useMemo(() => ({ total: od?.total ?? 0, load: () => more('') }), [od?.total, more]);

  if (!windowed) return null;
  const dated = DATED_VIEWS.includes(viewType);
  return {
    /** The table's sections (null while the first outline loads). */
    sections,
    /** Rows of the view in order (the table: placeholders included). */
    matched: viewType === 'table' ? tableItems : dated ? (calendar.data?.data ?? []) : cards,
    total: dated ? (calendar.data?.data.length ?? 0) : (od?.total ?? 0),
    // Timeline / Gantt / Workload draw their axis (and ask for its range) before any item arrives: never a skeleton,
    // which would unmount them and lose the navigation.
    loading: viewType === 'calendar' ? !calendar.data && !!range : dated ? false : !od,
    /** Footers the server left out (computed columns on a big view). */
    skipped: od?.skipped_summaries ?? [],
    onRange: need,
    onCalendarRange,
    kanban,
    cardsMore,
  };
};
