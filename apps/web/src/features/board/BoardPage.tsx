// SPDX-License-Identifier: AGPL-3.0-only
import { AreaBoundary } from '../../lib/error-screen';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  applyPlan,
  BULK_QUERY_MAX,
  dateInZone,
  decodeQuery,
  encodeQuery,
  getRegion,
  GROUP_PALETTE,
  paint,
  groupRows,
  isEmptyFilter,
  planQuery,
  planUsesSubitems,
  descendantsOf,
  matchingSubtreeWithPaths,
  orderColumns,
  compileColoring,
  pruneQuery,
  querySchema,
  resolveField,
  rowComparator,
  rowMatches,
  searchHitsSubitem,
  t,
  type SortLevel,
  type MessageKey,
  type MyAccount,
  type Field,
  type Query,
  type QueryEnv,
  type ViewType,
  type WindowedInfo,
  queryColumnOf,
} from '@bines/shared';
import { isStub } from './windowed';
import { bucketSeed } from './table/bucket-seed';
import { dateGroupLabel, groupCountryName } from './date-group';
import { nestedSections, viewLevels } from './nested-sections';
import { useWindowedView } from './use-windowed-view';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Button, cn, Notice, Skeleton, SkeletonRows } from '@bines/ui';
import { api, errorMessage } from '../../lib/api';
import { promptDialog } from '../../lib/dialogs';
import {
  type BoardDetail,
  type Item,
  type Member,
  useBoard,
  useBoardMutations,
  useItems,
  useTags,
  useTeams,
} from './board-api';
import { withoutTopRows } from './hierarchy-refresh';
import { useRelationMatchesLive, useRelationUnmatchedEnv } from './relation-filter';
import { usePeople } from './people';
import { BoardAccountContext, ColoringContext } from './board-context';
import { ConversionBanner, ConversionMarksContext, failedItemIds, useConversionMarks } from './convert/marks';
import {
  BoardTable,
  groupColor,
  nameWidthOf,
  type Section,
  SubitemsContext,
  type SubitemsTable,
  SummaryChoicesContext,
  type SummaryChoices,
} from './table/BoardTable';
import { BatchBar } from './BatchBar';
import { type Selection, SelectionContext, useSelection } from './selection';
import { activeConditions, BoardToolbar } from './toolbar/BoardToolbar';
import { ColoringPanel } from './toolbar/ColoringPanel';
import { useViewState } from './views/use-view-state';
import { useBoardLive } from './use-board-live';
import { BoardHeader } from './header/BoardHeader';
import {
  MobileBoardLead,
  MobileSearch,
  MobileToolsButton,
  MobileViewSwitch,
  MobileViewDropdown,
} from './header/MobileBoardBar';
import type { FilterCtx } from './toolbar/FilterPanel';
import { SaveBar, ViewTabs } from './views/ViewTabs';
import { CalendarView } from './views/CalendarView';
import { BoardChartView } from './views/BoardChartView';
import { FilesView } from './views/FilesView';
import { MapView } from './views/MapView';
import { FormView } from '../forms/FormView';
import { CardsView } from './views/CardsView';
import { KanbanView } from './views/KanbanView';
import { TimelineChart } from './timeline/TimelineChart';
import { WorkloadView } from './timeline/WorkloadView';
import { BoardDashboardView } from '../dashboards/BoardDashboardView';
import { MainTableOrderSetting } from './views/MainTableOrderSetting';
import { ViewSettingsPanel } from './views/ViewSettingsPanel';
import { type View, useAccountLocale, useViewMutations, useViews } from './views/views-api';
import { isFindKey, isModLetter, isTyping } from '../../lib/keys';
import { useDesktop } from '../../lib/use-desktop';
import { MobileTable } from './table/MobileTable';
import { NameStatus } from './name-source/NameStatus';
import { ExtensionBoardView, useExtensionViewEntries } from '../extensions/ExtensionBoardView';
import { BoardEmptyState } from './BoardEmptyState';
import { reportChecklist } from '../checklist/checklist-api';
import { SampleDataNotice } from '../onboarding/SampleDataNotice';

const BUCKET_COLORS = GROUP_PALETTE.map((k) => paint(k));
/** The personal list of collapsed sections holds at most this many keys (the prefs schema's limit). */
const MAX_COLLAPSED = 500;
/**
 * A section's key as saved in `collapsed_groups` (keys are at most 64 characters there): long ones — a bucket of
 * a grouping by column, `column:value` — are saved as a short hash, so their state is kept too.
 */
const collapseKey = (key: string) => {
  if (key.length <= 64) return key;
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return `#${(h >>> 0).toString(36)}:${key.slice(0, 40)}`;
};
const EMPTY_COLOR = 'var(--status-empty)';
/** The conditions that decide which rows a search / filter opens by itself (fix5-board 1), as one comparable key. */
const conditionsOf = (q: Pick<Query, 'filter' | 'search' | 'person' | 'match_children' | 'subitems_strict'>) =>
  JSON.stringify([q.filter ?? null, q.search?.trim() || '', q.person ?? null, !!q.match_children, !!q.subitems_strict]);

/**
 * Board page (11-UI §2, 15-VIEWS): header, view tabs, toolbar, and the table of the current view. Filtering,
 * sorting and grouping run in the browser over the loaded items with the shared query engine (13-FILTERS §3.1),
 * so every toolbar change shows at once; the view's draft is kept per view and mirrored to `?view=&q=`.
 */
export const BoardPage = ({
  account,
  meId,
  boardId,
  initialViewId,
  initialQ,
}: {
  account: MyAccount;
  meId: string;
  boardId: string;
  initialViewId?: string;
  initialQ?: string;
}) => {
  const board = useBoard(account.id, boardId);
  const items = useItems(account.id, boardId);
  const people = usePeople(account.id, boardId);
  const views = useViews(account.id, boardId);
  const locale = useAccountLocale(account.id);
  const m = useBoardMutations(account.id, boardId);
  const vm = useViewMutations(account.id, boardId);
  const live = useBoardLive(account.id, boardId);

  const [chosenId, setChosenId] = useState<string | undefined>(initialViewId);
  const list = views.data?.data ?? [];
  const view = list.find((v) => v.id === chosenId) ?? list.find((v) => v.id === views.data?.current_view_id);
  const vs = useViewState(boardId, view, vm);

  // A shared link (?q=) opens as a draft over its view, once (15 §2).
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !view) return;
    seeded.current = true;
    if (!initialQ) return;
    try {
      // The link's search is the board's search (round 11), the rest a draft over the view.
      const { search, ...query } = decodeQuery(initialQ);
      if (search) vs.setSearch(search);
      vs.seed(view.id, { ...view.settings, query: { ...query, search: view.settings.query.search } });
    } catch {
      // a broken link just opens the view as saved
    }
  }, [view, initialQ, vs]);

  const selectView = (id: string) => {
    setChosenId(id);
    vm.open.mutate(id);
    // "First steps": switching views leaves no trace in the log — the app reports it.
    reportChecklist(account.id, 'view_switched');
  };
  // …and so does opening a board.
  useEffect(() => reportChecklist(account.id, 'board_opened'), [account.id, boardId]);

  // Owner fix 5: on a board page Ctrl+F is the board's search (the toolbar's field takes it) — never the
  // browser's find bar, not even while the board is still loading.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isFindKey(e)) e.preventDefault();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  useUrlSync(
    view?.id,
    view?.is_default ?? true,
    vs.changes.some((c) => c.startsWith('query.')) || vs.search ? vs.effective.query : null,
  );

  if (board.isPending || items.isPending || views.isPending)
    // N16: the page's shape (title, tabs, toolbar, rows) instead of "loading…".
    return (
      <div className="flex flex-col gap-4 px-6 pt-6" data-testid="board-loading">
        <Skeleton className="h-7 w-48" />
        <div className="flex gap-2">
          <Skeleton className="h-8 w-28 rounded-[10px]" />
          <Skeleton className="h-8 w-20 rounded-[10px]" />
          <Skeleton className="h-8 w-20 rounded-[10px]" />
        </div>
        <Skeleton className="h-8 w-[min(420px,100%)] rounded-[10px]" />
        <SkeletonRows rows={8} label={t('app.loading')} />
      </div>
    );
  const error = board.error ?? items.error ?? views.error;
  if (error || !view || !board.data || !items.data)
    return (
      <div className="p-8">
        <Notice tone="error">{errorMessage(error)}</Notice>
      </div>
    );

  return (
    <BoardAccountContext.Provider value={{ id: account.id, slug: account.slug, meId }}>
      {/* `contents`: no box of its own — only marks whether the live channel is open (E2E waits on it). */}
      <div className="contents" data-testid="board-live" data-live={live ? 'on' : 'off'}>
        <BoardView
          account={account}
          board={board.data}
          items={items.data.data}
          windowedInfo={items.data.windowed}
          members={people}
          locale={locale.data}
          meId={meId}
          view={view}
          views={list}
          vs={vs}
          mutations={m}
          viewMutations={vm}
          onSelectView={selectView}
          initialQ={initialQ}
        />
      </div>
    </BoardAccountContext.Provider>
  );
};

/** Mirrors the open view and its draft query into the URL (replace, no history spam) so it can be shared. */
const useUrlSync = (viewId: string | undefined, isDefault: boolean, draftQuery: object | null) => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { view?: string; q?: string };
  const q = draftQuery ? encodeQuery(draftQuery) : undefined;
  const viewParam = viewId && !isDefault ? viewId : undefined;
  useEffect(() => {
    if (!viewId || (search.view === viewParam && search.q === q)) return;
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => ({ ...prev, view: viewParam, q }),
      replace: true,
    } as never);
  }, [viewId, viewParam, q, search.view, search.q, navigate]);
};

type Props = {
  account: MyAccount;
  board: BoardDetail;
  /** Every item of the board — or, on a windowed board (`windowedInfo`), the rows loaded so far. */
  items: Item[];
  windowedInfo?: WindowedInfo;
  members: Member[];
  locale: { timezone: string; weekend: 'fri_sat' | 'sat_sun'; first_day: number } | undefined;
  meId: string;
  view: View;
  views: View[];
  vs: ReturnType<typeof useViewState>;
  mutations: ReturnType<typeof useBoardMutations>;
  viewMutations: ReturnType<typeof useViewMutations>;
  onSelectView: (id: string) => void;
  /** The `?q=` the page was opened with (seeded as the first view's draft). */
  initialQ?: string;
};

const BoardView = ({
  account,
  board,
  items,
  windowedInfo,
  members,
  locale,
  meId,
  view,
  views,
  vs,
  mutations: m,
  viewMutations: vm,
  onSelectView,
  initialQ,
}: Props) => {
  // the board's default table in my own column order when the board keeps it per person.
  const personalOrder = view.is_system && board.main_table_column_order === 'personal';
  const myOrder = personalOrder ? view.prefs.column_order : undefined;
  const settings = useMemo(
    () => (myOrder ? { ...vs.effective, column_order: myOrder } : vs.effective),
    [vs.effective, myOrder],
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  const timezone = locale?.timezone ?? 'Asia/Jerusalem';
  const [today] = useState(() => dateInZone(new Date(), timezone));
  const { id: accountId } = useContext(BoardAccountContext);
  const teamsData = useTeams(accountId).data?.data;
  const tagsData = useTags(accountId).data?.data;
  const teams = useMemo(() => (teamsData ?? []).map((x) => ({ id: x.id, member_ids: x.member_ids })), [teamsData]);
  // The sub-board (D14) — filters can read the subitems (`sub:` rules, match_children). Same queries as the
  // subitems table's, so nothing loads twice.
  const subBoard = useBoard(accountId, board.subitems_board_id ?? '').data;
  const subItems = useItems(accountId, board.subitems_board_id ?? '').data?.data;
  // r19relfilter: "has a link that does not match" reads each relation column's unmatched links (for me).
  const relationUnmatched = useRelationUnmatchedEnv(accountId, board.id, board.columns, settings.query.filter);
  const env = useMemo<QueryEnv>(
    () => ({
      columns: board.columns.map(queryColumnOf),
      subitems: (subBoard?.columns ?? []).filter((c) => c.type !== 'name').map(queryColumnOf),
      meId,
      teams,
      today,
      timezone,
      weekend: locale?.weekend ?? 'fri_sat',
      firstDay: locale?.first_day ?? 0,
      calendar: getRegion().calendar,
      ...(relationUnmatched ? { relationUnmatched } : {}),
    }),
    [board.columns, subBoard?.columns, meId, teams, today, timezone, locale, relationUnmatched],
  );
  const top = useMemo(() => items.filter((i) => i.depth === 0), [items]);
  // The view's saved query: what the server is sent for it (windowed rows, chart, select-all) skips rules that no
  // longer apply, as the board does here — never a failed view.
  const query = useMemo(
    () => ({ ...pruneQuery(settings.query, env), ignore_invalid_rules: true }),
    [settings.query, env],
  );
  const plan = useMemo(() => {
    try {
      return planQuery(query, env);
    } catch {
      return planQuery(querySchema.parse({}), env);
    }
  }, [query, env]);
  // Conditional coloring of this view (compiled once; ItemRow asks for each item's colours).
  const colorOf = useMemo(
    () => (settings.coloring.length ? compileColoring(settings.coloring, env) : null),
    [settings.coloring, env],
  );
  const groupRank = useMemo(() => new Map(board.groups.map((g, i) => [g.id, i])), [board.groups]);
  // Subitems per parent (every depth — subitems of subitems too), for filters that read them.
  const usesSubitems = planUsesSubitems(plan);
  const directChildren = useMemo(() => {
    const map = new Map<string, Item[]>();
    if (!usesSubitems) return map;
    for (const it of subItems ?? []) {
      if (!it.parent_item_id) continue;
      map.set(it.parent_item_id, [...(map.get(it.parent_item_id) ?? []), it]);
    }
    for (const list of map.values())
      list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    return map;
  }, [usesSubitems, subItems]);
  const windowed = !!windowedInfo;
  // D28: cells that failed in a column conversion — marked in the table; "show only them" filters the board.
  const conversions = useConversionMarks(accountId, board.id);
  const [failedOnly, setFailedOnly] = useState(false);
  const failedIds = useMemo(
    () => (failedOnly && conversions.failed.length ? failedItemIds(conversions.failed) : null),
    [failedOnly, conversions.failed],
  );
  const localMatched = useMemo(() => {
    if (windowed) return []; // the server filters, sorts and groups a windowed board (its outline)
    const base = failedIds ? top.filter((i) => failedIds.has(i.id)) : top;
    const rows = usesSubitems ? base.map((i) => ({ ...i, subitems: descendantsOf(directChildren, i.id) })) : base;
    return applyPlan(rows, plan, timezone, query.group_by || view.type !== 'table' ? undefined : groupRank);
  }, [windowed, failedIds, usesSubitems, top, directChildren, plan, timezone, query.group_by, view.type, groupRank]);

  const columns = useMemo(
    () =>
      orderColumns(board.columns, settings.column_order)
        .filter((c) => c.type !== 'name' && !settings.hidden_columns.includes(c.id))
        .map((c) => ({ ...c, width: settings.column_widths[c.id] ?? c.width })),
    [board.columns, settings.column_order, settings.hidden_columns, settings.column_widths],
  );
  // r25: the relation ⚠ marks follow changes on the linked boards live.
  useRelationMatchesLive(accountId, board.id, columns, board.columns, settings.query.filter);
  const groupDates = settings.query.group_by;
  const seedOf = useCallback(
    (field: Field, key: string, rows?: Item[], title?: string) =>
      bucketSeed(field, key, {
        groupId: board.groups[0]?.id,
        members,
        env,
        columns: board.columns,
        rows,
        title,
        dates: { unit: groupDates?.date_unit, pastDetail: groupDates?.past_detail },
      }),
    [board.groups, board.columns, members, env, groupDates?.date_unit, groupDates?.past_detail],
  );
  // A board above the windowed threshold (perf review §7.1): its view comes from the server's outline.
  const win = useWindowedView({
    accountId,
    board,
    windowed,
    viewType: view.type,
    query,
    env,
    settings,
    columns,
    items: top,
    members,
    tags: tagsData,
    teams: teamsData,
    seedOf,
  });
  const matched = win ? win.matched : localMatched;
  /**
   * Owner fix (fix5-board 1): entering a board shows every subitem list closed — in any view, also when the view
   * comes with a search or a subitem filter (saved with it, restored from this tab's draft or a `?q=` link).
   * Those used to open their matches on every entry. A search / filter opens its matches only after the user
   * changes it during this visit: the conditions each view had when first shown here are its entry state.
   */
  const conditionsKey = conditionsOf(settings.query);
  // A shared link (`?q=`) becomes the first view's draft right after this first render: its query is the entry.
  const [entryConditions, setEntryConditions] = useState<Record<string, string>>(() => {
    let entry = conditionsKey;
    if (initialQ)
      try {
        entry = conditionsOf(decodeQuery(initialQ));
      } catch {
        // a broken link opens the view as saved
      }
    return { [view.id]: entry };
  });
  if (!(view.id in entryConditions)) setEntryConditions((prev) => ({ ...prev, [view.id]: conditionsKey }));
  const conditionsChanged = view.id in entryConditions && entryConditions[view.id] !== conditionsKey;
  /**
   * Under each matching item, at every depth, only the subitems that keep it in the result; `open` = the rows
   * that open by themselves — the path to each subitem match. An item that matches by its own values keeps all
   * its subitems and opens only towards subitems the search finds (owner fix: the search reaches subitems).
   * Nothing opens by itself until the conditions change in this visit (above).
   */
  const subitemsFilter = useMemo(() => {
    if (!usesSubitems) return undefined;
    const children = new Map<string, Item[]>();
    const open = new Set<string>();
    const pathOnly = new Set<string>();
    for (const row of matched) {
      if (isStub(row)) continue; // a windowed board's row not loaded yet
      const { tree, pathOnly: paths } = matchingSubtreeWithPaths(plan, row, timezone, directChildren);
      for (const id of paths) pathOnly.add(id);
      for (const [parentId, kept] of tree) children.set(parentId, kept);
      if (!conditionsChanged) continue;
      if (!rowMatches(plan, { ...row, subitems: [] }, timezone, 'fail')) {
        for (const [parentId, kept] of tree) if (kept.length) open.add(parentId);
        continue;
      }
      // Opens `id` when a search hit lies below it.
      const reach = (id: string): boolean => {
        let hit = false;
        for (const c of tree.get(id) ?? []) if (reach(c.id) || searchHitsSubitem(plan, c)) hit = true;
        if (hit) open.add(id);
        return hit;
      };
      reach(row.id);
    }
    return { children, open, pathOnly };
  }, [usesSubitems, matched, plan, timezone, directChildren, conditionsChanged]);

  const windowSections = win?.sections;
  const sections = useMemo<Section[]>(() => {
    if (windowed) return windowSections ?? [];
    // Prod ק3: nested levels (the first is the grouping or the board's groups).
    if (query.subgroups?.length) {
      const levels = viewLevels(query, env);
      if (levels.length > 1)
        return nestedSections({
          rows: matched,
          levels,
          board,
          env,
          members,
          names: new Map([
            ...members.map((mb) => [mb.user_id, mb.name || mb.email] as const),
            ...(tagsData ?? []).map((x) => [x.id, `#${x.name}`] as const),
            ...(teamsData ?? []).map((x) => [x.id, x.name] as const),
          ]),
        });
    }
    if (query.group_by) {
      const field = resolveField(query.group_by.column_id, env);
      const names = new Map([
        ...members.map((mb) => [mb.user_id, mb.name || mb.email] as const),
        ...(tagsData ?? []).map((x) => [x.id, `#${x.name}`] as const),
        ...(teamsData ?? []).map((x) => [x.id, x.name] as const),
      ]);
      const g = query.group_by;
      // a date groups by the view's unit (when / day / week / month / quarter / year).
      const dates = { unit: g.date_unit, pastDetail: g.past_detail };
      return groupRows(matched, field, {
        timezone,
        direction: g.direction,
        nameOf: (id) => names.get(id),
        emptyLabel: t('group.empty'),
        checkedLabel: t('group.checked'),
        dates: { env, label: dateGroupLabel, ...dates, edge: g.date_edge },
        // ק2: how other columns group (each / combination / team, ranges, first letter, domain, country).
        mode: g.mode,
        rangeSize: g.range_size,
        showEmpty: g.show_empty,
        teams: env.teams,
        countryName: groupCountryName,
      }).map((b, i) => ({
        key: `${query.group_by!.column_id}:${b.key}`,
        title: b.label,
        color: paint(b.color) ?? (b.key === '__empty__' ? EMPTY_COLOR : BUCKET_COLORS[i % BUCKET_COLORS.length]!),
        items: b.rows,
        seed: bucketSeed(field, b.key, {
          groupId: board.groups[0]?.id,
          members,
          env,
          columns: board.columns,
          rows: b.rows,
          title: b.label,
          dates,
        }),
      }));
    }
    const filtered = !isEmptyFilter(query);
    return board.groups
      .map((g) => ({
        key: g.id,
        title: g.title,
        color: groupColor(g),
        group: g,
        items: matched.filter((i) => i.group_id === g.id),
      }))
      .filter((s) => !filtered || s.items.length > 0);
  }, [windowed, windowSections, query, env, matched, members, tagsData, teamsData, timezone, board]);

  // Selection (07 §6) in the table, Kanban and Cards; its order is the view's, so Shift+click ranges follow it.
  const order = useMemo(
    () =>
      view.type === 'table'
        ? sections.flatMap((s) => (s.header ? [] : s.items.map((i) => i.id)))
        : view.type === 'kanban' || view.type === 'cards'
          ? matched.map((i) => i.id)
          : [],
    [sections, matched, view.type],
  );
  const ownSelection = useSelection(order, windowed ? BULK_QUERY_MAX : undefined);
  // A windowed board's batch over every match runs by the view's query (BatchBar).
  const matchTotal = win?.total;
  const matchAll = useMemo(
    () => (matchTotal !== undefined ? { query: { ...query, group_by: undefined }, total: matchTotal } : undefined),
    [matchTotal, query],
  );
  // The conditions that decide which items open by themselves (a new filter opens its matches again).
  const subitemsFilterKey = useMemo(
    () => JSON.stringify([query.filter, query.search, query.person, query.match_children, query.subitems_strict]),
    [query.filter, query.search, query.person, query.match_children, query.subitems_strict],
  );
  const setSubitemsSort = useCallback(
    (subitems_sort: SortLevel[]) => vs.update((s) => ({ ...s, subitems_sort })),
    [vs],
  );
  const ownSubitems = useSubitemsTable(
    board,
    order,
    env,
    settings.subitems_sort,
    setSubitemsSort,
    subitemsFilter,
    subitemsFilterKey,
    settings.subitems_hidden_columns,
  );
  // One batch at a time (bulk runs per board): checking a subitem clears the items, and the other way round.
  const selection = useMemo(
    () => exclusive(ownSelection, ownSubitems.selection.clear),
    [ownSelection, ownSubitems.selection.clear],
  );
  const subitems = useMemo(
    () => ({ ...ownSubitems, selection: exclusive(ownSubitems.selection, ownSelection.clear) }),
    [ownSubitems, ownSelection.clear],
  );
  useEffect(() => {
    if (!order.length) return; // a view with selection (table, Kanban, Cards)
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      if (isModLetter(e, 'a')) {
        e.preventDefault();
        selection.selectAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [order.length, selection]);

  /**
   * Owner fix 2: collapsed sections are a personal list of keys (saved at once, not after a pause). "Collapse all"
   * always collapses — every section on screen, every board group (also those a filter hides now) and every open
   * subitem list; after it, opening a group opens that group only. Only "expand all" (the toolbar button while all
   * are collapsed) opens everything again.
   */
  const saved = useMemo(() => new Set(settings.collapsed_groups), [settings.collapsed_groups]);
  const collapsed = useMemo(
    () => new Set(sections.filter((s) => saved.has(collapseKey(s.key))).map((s) => s.key)),
    [sections, saved],
  );
  // Phones get the table as cards (F4); the grid needs the width.
  const desktop = useDesktop();
  // Phones: the tools sheet (the bar's filter button, or a tap on a condition chip).
  const [toolsOpen, setToolsOpen] = useState(false);
  // r18board 3: the phone's views sheet — opened from the bar's board name or the view chips row.
  const [viewSheetOpen, setViewSheetOpen] = useState(false);
  const allCollapsed = sections.length > 0 && sections.every((s) => collapsed.has(s.key));
  const toggle = useCallback(
    (key: string) => {
      const k = collapseKey(key);
      vs.setPrefs(
        { collapsed_groups: saved.has(k) ? [...saved].filter((x) => x !== k) : [...saved, k].slice(-MAX_COLLAPSED) },
        { now: true },
      );
    },
    [saved, vs],
  );
  const collapseSubitems = ownSubitems.collapseAll;
  const collapseAll = useCallback(() => {
    const keys = [...sections.map((s) => s.key), ...board.groups.map((g) => g.id)].map(collapseKey);
    vs.setPrefs({ collapsed_groups: [...new Set([...saved, ...keys])].slice(-MAX_COLLAPSED) }, { now: true });
    collapseSubitems?.();
  }, [sections, board.groups, saved, vs, collapseSubitems]);
  const expandAll = useCallback(() => vs.setPrefs({ collapsed_groups: [] }, { now: true }), [vs]);
  // Prod ק3: a nested grouping's level — collapse all its sections; open everything again.
  const levelActions = useMemo(
    () =>
      sections.some((s) => s.level !== undefined)
        ? {
            collapse: (level: number) => {
              const keys = sections.filter((s) => (s.level ?? 0) === level).map((s) => collapseKey(s.key));
              vs.setPrefs({ collapsed_groups: [...new Set([...saved, ...keys])].slice(-MAX_COLLAPSED) }, { now: true });
            },
            expandAll,
          }
        : undefined,
    [sections, saved, vs, expandAll],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isModLetter(e, 'g')) {
        e.preventDefault();
        collapseAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [collapseAll]);

  // Owner fix 4: the name column resizes like every other one (personal width, else the board's).
  const nameWidth = useMemo(() => {
    const name = board.columns.find((c) => c.type === 'name');
    return nameWidthOf(name, name ? settings.column_widths[name.id] : undefined);
  }, [board.columns, settings.column_widths]);
  const onWidth = useCallback(
    (columnId: string, width: number) =>
      vs.setPrefs({ column_widths: { ...view.prefs.column_widths, [columnId]: width } }),
    [vs, view.prefs.column_widths],
  );

  const summaryChoices = useMemo<SummaryChoices>(
    () => ({
      choices: settings.summaries,
      choose: (columnId, fn) => vs.update((s) => ({ ...s, summaries: { ...s.summaries, [columnId]: fn } })),
    }),
    [settings.summaries, vs],
  );

  const caps = board.capabilities;
  const canCreateShared = !!caps['view.create'];
  const createView = async (type: ViewType, fromDraft: boolean) => {
    const name = await promptDialog({
      title: fromDraft ? t('view.saveAsNew') : t('view.new'),
      label: t('view.name'),
      initial: fromDraft ? t('view.copyOf', { name: view.name }) : t(`view.type.${type}` as MessageKey),
    });
    if (!name) return;
    const created = await vm.create.mutateAsync({
      name,
      type,
      // A new view starts from what is on screen (15 §6); personal widths/collapse stay personal.
      settings: {
        ...vs.withoutSearch(settings),
        column_widths: view.settings.column_widths,
        collapsed_groups: view.settings.collapsed_groups,
      },
      visibility: canCreateShared ? 'shared' : 'private',
    });
    if (fromDraft) vs.reset();
    onSelectView(created.id);
  };

  // Extension board views (D27 ת2) join the "+" menu; their tab stores which installation and feature.
  const extensionEntries = useExtensionViewEntries(accountId, board.id, async ({ name, settings: ext }) => {
    const created = await vm.create.mutateAsync({
      name,
      type: 'extension',
      settings: { ...vs.withoutSearch(settings), ...ext },
      visibility: canCreateShared ? 'shared' : 'private',
    });
    onSelectView(created.id);
  });

  const mutationError = [
    m.setCell,
    m.createItem,
    m.createColumn,
    m.deleteGroup,
    m.createGroup,
    m.renameItem,
    m.updateColumn,
    vm.create,
    vm.update,
    vm.save,
    vm.remove,
  ].find((x) => x.isError)?.error;

  const filterCtx: FilterCtx = {
    env,
    columns: board.columns,
    subColumns: (subBoard?.columns ?? []).filter((c) => c.type !== 'name'),
    groups: board.groups,
    members,
    teams: teamsData ?? [],
    tags: tagsData ?? [],
    meId,
  };

  /**
   * Prod (product owner: "in the default view let me drag columns and keep it"): the default table never takes a draft
   * (its changes become a new view). The board's setting decides what a drag there does: `shared` (default) moves
   * the board's own columns, for everyone (`column.reorder`); `personal` keeps my own order (my prefs
   * of the view), for anyone. Every other view — and `shared` without `column.reorder` — keeps a draft of the view.
   */
  const boardOrder = view.is_system && !personalOrder && !!board.capabilities['column.reorder'];
  const nameId = board.columns.find((c) => c.type === 'name')?.id;
  const reorderColumns = (columnId: string, column_order: string[]) => {
    if (personalOrder) vs.setPrefs({ column_order }, { now: true });
    else if (boardOrder && nameId) m.reorderColumn.mutate({ columnId, order: [nameId, ...column_order] });
    else vs.update((s) => ({ ...s, column_order }));
  };

  // A form view (M11) has no filter / search / view settings: it is the form's editor.
  const toolbar = (sheet: boolean) =>
    view.type === 'form' ? null : (
      <BoardToolbar
        sheet={sheet}
        settings={settings}
        update={vs.update}
        onSearch={vs.setSearch}
        ctx={filterCtx}
        rows={top}
        matching={win ? win.total : matched.length}
        viewType={view.type}
        // Column order is the view's: a change is a draft like any other, saved with the save bar (the Main
        // Table's is the board's, saved at once — above).
        onReorderColumns={reorderColumns}
        subColumns={subBoard?.columns}
        end={
          <ViewSettingsPanel
            type={view.type}
            board={board}
            env={env}
            settings={settings}
            update={vs.update}
            view={view}
            views={views}
            members={members}
            mainTable={view.is_system ? <MainTableOrderSetting accountId={accountId} board={board} /> : undefined}
            coloring={
              view.type === 'table' ? (
                <ColoringPanel
                  rules={settings.coloring}
                  ctx={filterCtx}
                  onChange={(coloring) => vs.update((s) => ({ ...s, coloring }))}
                />
              ) : undefined
            }
          />
        }
      />
    );
  const saveBar =
    vs.dirty || mutationError ? (
      <>
        <SaveBar view={view} state={vs} mutations={vm} onSaveAsNew={() => void createView(view.type, true)} />
        {mutationError ? <Notice tone="error">{errorMessage(mutationError)}</Notice> : null}
      </>
    ) : null;
  // Prod fix (mobilehead): phones get one compact bar (BoardHeader) and the rest scrolls away with the rows.
  const conditions = desktop ? [] : activeConditions(settings.query, filterCtx);
  const phoneBar = ({ open, setOpen }: { open: boolean; setOpen: (open: boolean) => void }) => (
    <>
      <MobileViewSwitch
        boardName={board.name}
        view={view}
        views={views}
        dirty={vs.dirty}
        canCreateShared={canCreateShared}
        onSelect={onSelectView}
        onCreate={(type) => void createView(type, false)}
        extraCreate={extensionEntries}
        mutations={vm}
        open={viewSheetOpen}
        onOpenChange={setViewSheetOpen}
        hideTrigger={open}
      />
      {/* A form view (M11) is the form's editor: no search or tools on the phone either. */}
      {view.type === 'form' ? null : (
        <MobileSearch value={settings.query.search ?? ''} onChange={vs.setSearch} open={open} setOpen={setOpen} />
      )}
      {open || view.type === 'form' ? null : (
        <MobileToolsButton
          count={conditions.length}
          active={
            settings.query.sort.length > 0 ||
            !!settings.query.group_by ||
            !!settings.query.subgroups?.length ||
            settings.hidden_columns.length > 0 ||
            settings.coloring.length > 0
          }
          open={toolsOpen}
          setOpen={setToolsOpen}
          conditions={conditions}
          onClear={(key) => {
            const c = conditions.find((x) => x.key === key);
            if (c) vs.update((s) => ({ ...s, query: { ...s.query, ...c.clear } }));
          }}
          onClearAll={() => vs.update((s) => ({ ...s, query: { ...s.query, person: undefined, filter: undefined } }))}
        >
          {toolsOpen ? toolbar(true) : null}
        </MobileToolsButton>
      )}
    </>
  );

  // a new item goes into the first group; a board with no group yet gets one first (its default name).
  const canAddItem = !!caps['item.create'] && (!!board.groups[0] || !!caps['group.create']);
  const addItem = async (top: boolean) => {
    try {
      const groupId = board.groups[0]?.id ?? (await m.createGroup.mutateAsync(t('board.newGroup'))).id;
      m.createItem.mutate({
        name: board.item_terminology === 'item' ? t('board.itemDefault') : board.item_terminology,
        groupId,
        top,
      });
    } catch {
      // Shown by the board's mutation error.
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BoardHeader
        phoneBar={desktop ? undefined : phoneBar}
        board={board}
        filterCtx={filterCtx}
        onRename={(name) => m.renameBoard.mutate(name)}
        onNewItem={canAddItem ? () => void addItem(true) : undefined}
        creating={m.createItem.isPending}
        mutations={m}
        exportRequest={() => ({
          query: { ...settings.query, ignore_invalid_rules: true },
          columns: columns.map((c) => c.id),
        })}
      />
      {board.archived_at ? <ArchivedBanner board={board} /> : null}
      {/* Prod phase B: sample rows a kit brought — "delete the sample data" (admins). */}
      <div className={cn(desktop ? 'px-6 pt-2' : 'px-3 pt-2', 'empty:hidden')}>
        <SampleDataNotice account={account} boardId={board.id} />
      </div>
      {/* F4 (every view, like the table): the tabs row, then the toolbar row (search + tools). Phones: the bar. */}
      {desktop ? (
        <div className="flex flex-col items-start gap-2 px-6 pb-2 [&>*]:max-w-full">
          <ViewTabs
            views={views}
            current={view}
            dirty={vs.dirty}
            canCreateShared={canCreateShared}
            onSelect={onSelectView}
            onCreate={(type) => void createView(type, false)}
            extraCreate={extensionEntries}
            mutations={vm}
          />
          {toolbar(false)}
        </div>
      ) : null}
      {desktop && saveBar ? <div className="flex flex-wrap items-center gap-3 px-6 pt-2">{saveBar}</div> : null}
      {/*: computed names — a background recompute's progress, the duplicate names warning. */}
      <div className="flex flex-wrap items-center gap-2 px-6 pt-1 empty:hidden max-md:px-3" data-testid="name-status">
        <NameStatus board={board} items={items} />
        {subBoard ? <NameStatus board={subBoard} items={subItems} /> : null}
      </div>
      <ConversionBanner
        accountId={accountId}
        boardId={board.id}
        failed={conversions.failed}
        columns={board.columns}
        only={failedOnly}
        // A windowed board is filtered by the server: there the marks show, the quick filter does not.
        onOnly={windowed ? undefined : setFailedOnly}
      />
      {/* Margin, not padding: the table scrolls sideways inside the panel's gutter instead of running to its edge. */}
      <div
        ref={scrollRef}
        className="relative mx-6 flex-1 overflow-auto pb-16 pt-4 max-md:mx-2 max-md:pt-0"
        data-testid="board-scroll"
        data-windowed={windowed || undefined}
      >
        {/* Phone: the top gap is a spacer that scrolls away, not padding — sticky headers stick at a scroll
            container's padding edge, and rows would peek above them. */}
        {desktop ? null : <div aria-hidden className="h-2" />}
        {desktop ? null : (
          <MobileBoardLead
            views={
              <MobileViewDropdown
                view={view}
                views={views}
                dirty={vs.dirty}
                canCreateShared={canCreateShared}
                onSelect={onSelectView}
                onCreate={(type) => void createView(type, false)}
                extraCreate={extensionEntries}
                mutations={vm}
                onManage={() => setViewSheetOpen(true)}
              />
            }
          >
            {saveBar ? <div className="flex flex-wrap items-center gap-2">{saveBar}</div> : null}
          </MobileBoardLead>
        )}
        {/* Round 12: a crash in a view shows the error screen here only — the toolbar, tabs and sidebar stay. */}
        <AreaBoundary area="view" resetKey={view.id}>
          {win?.loading ? (
            // A windowed board's first outline (or a view change's) is on its way.
            <SkeletonRows rows={8} label={t('app.loading')} />
          ) : view.type === 'form' ? (
            <FormView accountId={accountId} board={board} viewId={view.id} />
          ) : view.type === 'extension' ? (
            <ExtensionBoardView accountId={accountId} boardId={board.id} settings={settings} meId={meId} view={view} />
          ) : view.type === 'kanban' || view.type === 'cards' ? (
            <SelectionContext.Provider value={selection}>
              {view.type === 'kanban' ? (
                <KanbanView
                  board={board}
                  items={matched}
                  settings={settings}
                  env={env}
                  members={members}
                  mutations={m}
                  update={vs.update}
                  sorted={query.sort.length > 0}
                  windowed={win?.kanban}
                />
              ) : (
                <CardsView
                  board={board}
                  items={matched}
                  settings={settings}
                  env={env}
                  members={members}
                  mutations={m}
                  more={win?.cardsMore}
                />
              )}
              <BatchBar board={board} selection={selection} members={members} mutations={m} matchAll={matchAll} />
            </SelectionContext.Provider>
          ) : view.type === 'timeline' || view.type === 'gantt' ? (
            <TimelineChart
              variant={view.type}
              board={board}
              items={matched}
              settings={settings}
              env={env}
              members={members}
              mutations={m}
              update={vs.update}
              windowed={windowed}
              onRange={win?.onCalendarRange}
            />
          ) : view.type === 'workload' ? (
            <WorkloadView
              board={board}
              items={matched}
              settings={settings}
              env={env}
              members={members}
              update={vs.update}
              onRange={win?.onCalendarRange}
              subBoard={subBoard}
              subItems={subItems}
            />
          ) : view.type === 'dashboard' ? (
            <BoardDashboardView account={account} board={board} settings={settings} query={query} update={vs.update} />
          ) : view.type === 'chart' ? (
            <BoardChartView
              board={board}
              items={matched}
              settings={settings}
              query={query}
              env={env}
              members={members}
              windowed={windowed}
            />
          ) : view.type === 'files' ? (
            <FilesView
              board={board}
              items={matched}
              filtered={!windowed && !isEmptyFilter(query)}
              settings={settings}
              update={vs.update}
              members={members}
            />
          ) : view.type === 'map' ? (
            <MapView board={board} items={matched} settings={settings} env={env} members={members} mutations={m} />
          ) : view.type === 'calendar' ? (
            <CalendarView
              board={board}
              items={matched}
              settings={settings}
              env={env}
              mutations={m}
              onRange={win?.onCalendarRange}
              update={vs.update}
            />
          ) : sections.length ? (
            <SelectionContext.Provider value={selection}>
              {/* Audit 2026-10-10 ux #12: a board with no items at all (not one a filter or search emptied). */}
              {!windowed && !query.group_by && isEmptyFilter(query) && sections.every((x) => !x.items.length) ? (
                <BoardEmptyState
                  account={account}
                  boardId={board.groups.length ? board.id : undefined}
                  onCreate={canAddItem ? () => void addItem(false) : undefined}
                />
              ) : null}
              <SubitemsContext.Provider value={subitems}>
                <SummaryChoicesContext.Provider value={summaryChoices}>
                  <ColoringContext.Provider value={colorOf}>
                    <ConversionMarksContext.Provider value={conversions.marks}>
                      {desktop ? null : (
                        <MobileTable
                          layout={settings.mobile_layout}
                          board={board}
                          sections={sections}
                          columns={columns}
                          members={members}
                          mutations={m}
                          collapsed={collapsed}
                          onToggle={toggle}
                          env={env}
                          groupSummary={settings.group_summary}
                          onRange={win?.onRange}
                        />
                      )}
                      {desktop ? (
                        <BoardTable
                          board={board}
                          sections={sections}
                          columns={columns}
                          members={members}
                          mutations={m}
                          collapsed={collapsed}
                          onToggle={toggle}
                          onCollapseAll={collapseAll}
                          onExpandAll={allCollapsed ? expandAll : undefined}
                          levelActions={levelActions}
                          onWidth={onWidth}
                          scrollRef={scrollRef}
                          env={env}
                          showSummary={settings.show_summary}
                          rowHeight={settings.row_height}
                          wrapText={settings.wrap_text}
                          search={query.search}
                          manualOrder={!query.sort.length && !query.group_by}
                          sort={settings.query.sort}
                          onSort={(sort) => vs.update((s) => ({ ...s, query: { ...s.query, sort } }))}
                          // The default table, shared: no callback — the header reorders the board's columns (above).
                          onReorderColumns={
                            boardOrder
                              ? undefined
                              : personalOrder
                                ? (column_order) => vs.setPrefs({ column_order }, { now: true })
                                : (column_order) => vs.update((s) => ({ ...s, column_order }))
                          }
                          canReorderColumns={personalOrder || undefined}
                          groupSummary={settings.group_summary}
                          nameWidth={nameWidth}
                          onRange={win?.onRange}
                        />
                      ) : null}
                    </ConversionMarksContext.Provider>
                  </ColoringContext.Provider>
                </SummaryChoicesContext.Provider>
                <BatchBar board={board} selection={selection} members={members} mutations={m} matchAll={matchAll} />
                {subitems.board ? (
                  <BatchBar
                    board={subitems.board}
                    selection={subitems.selection}
                    members={members}
                    mutations={subitems.mutations}
                  />
                ) : null}
              </SubitemsContext.Provider>
            </SelectionContext.Provider>
          ) : !windowed && isEmptyFilter(query) && !board.groups.length ? (
            // a board with no group at all is an empty board, not "no results".
            <BoardEmptyState
              account={account}
              boardId={board.groups.length ? board.id : undefined}
              onCreate={canAddItem ? () => void addItem(false) : undefined}
            />
          ) : (
            <div className="py-16 text-center text-sm text-muted" data-testid="no-results">
              {t('filter.noResults')}
              <button type="button" className="ms-2 text-primary hover:underline" onClick={vs.reset}>
                {t('view.reset')}
              </button>
            </div>
          )}
        </AreaBoundary>
      </div>
    </div>
  );
};

/**
 * Subitems in the table (D14): the sub-board and its items, which rows are open (for this visit only), and widths of sub-board columns (the board default, saved after the drag settles).
 */
/** A selection that empties `clearOther` whenever something gets checked in it. */
const exclusive = (s: Selection, clearOther: () => void): Selection => ({
  ...s,
  toggle: (id, range) => {
    clearOther();
    s.toggle(id, range);
  },
  setMany: (ids, on) => {
    if (on) clearOther();
    s.setMany(ids, on);
  },
  selectAll: () => {
    clearOther();
    s.selectAll();
  },
});

/**
 * `filter` (a filter that reads subitems): each matching item shows only its matching subitems, and items with
 * such matches open — for as long as the filter is on (not saved).
 */
const NO_HIDDEN: string[] = [];

const useSubitemsTable = (
  board: BoardDetail,
  topIds: string[],
  env: QueryEnv,
  sort: SortLevel[],
  setSort: (sort: SortLevel[]) => void,
  filter?: { children: Map<string, Item[]>; open: Set<string>; pathOnly: Set<string> },
  filterKey = '',
  hiddenColumns: string[] = NO_HIDDEN,
): SubitemsTable => {
  const { id: accountId } = useContext(BoardAccountContext);
  const subId = board.subitems_board_id ?? '';
  const subBoard = useBoard(accountId, subId);
  const subItems = useItems(accountId, subId);
  const mutations = useBoardMutations(accountId, subId);
  /**
   * Owner fix (fix4-board 3): open subitem lists live only for this visit — never saved with a view nor across
   * visits; entering a board shows every subitem list closed (a search / filter changed in this visit still opens
   * its matches). Memory only — nothing is read or written on entry. The set is tagged with its board so switching
   * boards in place starts closed too.
   */
  const boardId = board.id;
  const [expandedState, setExpandedState] = useState<{ board: string; ids: Set<string> }>(() => ({
    board: boardId,
    ids: new Set(),
  }));
  const expanded = useMemo(
    () => (expandedState.board === boardId ? expandedState.ids : new Set<string>()),
    [expandedState, boardId],
  );
  const [focusAdd, setFocusAdd] = useState<string | null>(null);
  /**
   * Owner fix 6: rows the user closed while a filter is on. A filter opens its matches only as a start; closing
   * one wins until the filter changes (then its matches open again).
   */
  const [closedFiltered, setClosedFiltered] = useState<{ key: string; ids: ReadonlySet<string> }>(() => ({
    key: '',
    ids: new Set(),
  }));
  const filtering = !!filter;
  const setExpanded = useCallback(
    (itemId: string, open: boolean) => {
      if (filtering)
        setClosedFiltered((prev) => {
          const ids = new Set(prev.key === filterKey ? prev.ids : []);
          if (open) ids.delete(itemId);
          else ids.add(itemId);
          return { key: filterKey, ids };
        });
      setExpandedState((prev) => {
        const next = new Set(prev.board === boardId ? prev.ids : []);
        if (open) next.add(itemId);
        else next.delete(itemId);
        return { board: boardId, ids: next };
      });
    },
    [boardId, filtering, filterKey],
  );
  // Owner fix 2: "collapse all" closes every open subitem list too (also those a filter opened).
  const filterOpen = filter?.open;
  const collapseAll = useCallback(() => {
    if (filterOpen) setClosedFiltered({ key: filterKey, ids: new Set(filterOpen) });
    setExpandedState({ board: boardId, ids: new Set() });
  }, [filterOpen, filterKey, boardId]);
  const allChildren = useMemo(() => {
    const map = new Map<string, Item[]>();
    // after a hierarchy move (or its undo) the two caches refetch apart — never a row twice.
    for (const it of withoutTopRows(subItems.data?.data ?? [], topIds)) {
      if (!it.parent_item_id) continue;
      map.set(it.parent_item_id, [...(map.get(it.parent_item_id) ?? []), it]);
    }
    for (const list of map.values())
      list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    return map;
  }, [subItems.data, topIds]);
  // Owner fix: the view's subitem sort (`subitems_sort`, sub-board columns) orders the subitems under every
  // parent; without one they keep their manual order. Levels on columns that no longer exist are dropped.
  const subColumns = subBoard.data?.columns;
  const compare = useMemo(() => {
    if (!sort.length || !subColumns) return null;
    const subEnv: QueryEnv = {
      ...env,
      columns: subColumns.map(queryColumnOf),
      subitems: undefined,
    };
    try {
      const plan = planQuery(pruneQuery(querySchema.parse({ sort }), subEnv), subEnv);
      return plan.sort.length ? rowComparator(plan) : null;
    } catch {
      return null;
    }
  }, [sort, subColumns, env]);
  const childrenOf = useMemo(() => {
    if (!filter && !compare) return allChildren;
    const map = new Map(allChildren);
    for (const [parentId, list] of filter?.children ?? []) map.set(parentId, list);
    if (compare) for (const [parentId, list] of map) map.set(parentId, [...list].sort(compare));
    return map;
  }, [allChildren, filter, compare]);
  const shownExpanded = useMemo(() => {
    if (!filter) return expanded;
    const closed = closedFiltered.key === filterKey ? closedFiltered.ids : null;
    const out = new Set(expanded);
    for (const parentId of filter.open) if (!closed?.has(parentId)) out.add(parentId);
    return out;
  }, [expanded, filter, closedFiltered, filterKey]);
  // Shift+click ranges follow the open subitems in screen order.
  const order = useMemo(() => {
    const out: string[] = [];
    const walk = (parentId: string) => {
      if (!shownExpanded.has(parentId)) return;
      for (const child of childrenOf.get(parentId) ?? []) {
        out.push(child.id);
        walk(child.id);
      }
    };
    topIds.forEach(walk);
    return out;
  }, [topIds, shownExpanded, childrenOf]);
  const selection = useSelection(order);
  // One save timer per column (audit 2026-10-10, web #4): resizing a second column within 400 ms used to cancel
  // the first column's save, and the refresh that followed snapped it back.
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const onWidth = useCallback(
    (columnId: string, width: number) => {
      mutations.previewColumnWidth(columnId, width);
      clearTimeout(saveTimers.current.get(columnId));
      saveTimers.current.set(
        columnId,
        setTimeout(() => {
          saveTimers.current.delete(columnId);
          mutations.setColumnWidth.mutate({ columnId, width });
        }, 400),
      );
    },
    [mutations],
  );
  const pathOnly = filter?.pathOnly;
  return useMemo(
    () => ({
      board: subBoard.data,
      mutations,
      childrenOf,
      expanded: shownExpanded,
      setExpanded,
      onWidth,
      focusAdd,
      requestAdd: (parentId: string) => {
        setExpanded(parentId, true);
        setFocusAdd(parentId);
      },
      selection,
      sorted: !!compare,
      sortLevels: sort,
      onSort: setSort,
      collapseAll,
      hiddenColumns,
      pathOnly,
    }),
    [
      subBoard.data,
      mutations,
      childrenOf,
      shownExpanded,
      setExpanded,
      onWidth,
      focusAdd,
      selection,
      compare,
      sort,
      setSort,
      collapseAll,
      hiddenColumns,
      pathOnly,
    ],
  );
};

/** An archived board still opens (links, the archive page); a banner says so and offers to restore it. */
const ArchivedBanner = ({ board }: { board: BoardDetail }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const qc = useQueryClient();
  const restore = useMutation({
    mutationFn: () => api(accountId).post(`/archive/board/${board.id}/restore`, {}),
    onSuccess: async () => {
      // A sidebar tree still loading from before the restore would land after it without the board: drop it, so the
      // refetch below is the one that counts.
      await qc.cancelQueries({ queryKey: ['account', accountId, 'tree'] });
      await qc.invalidateQueries({ queryKey: ['account', accountId] });
    },
  });
  return (
    <div className="mx-6 mb-2 flex items-center gap-3" data-testid="archived-banner">
      <Notice>{t('archive.banner')}</Notice>
      {board.capabilities['board.delete'] ? (
        <Button variant="secondary" busy={restore.isPending} onClick={() => restore.mutate()}>
          {t('archive.restore')}
        </Button>
      ) : null}
    </div>
  );
};
