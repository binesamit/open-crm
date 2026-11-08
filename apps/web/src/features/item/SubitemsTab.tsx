// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import {
  CARD_SUBITEM_DEFAULT_COLUMNS,
  viewSettingsSchema,
  cardSubitemsOf,
  dateInZone,
  getRegion,
  isEmptyFilter,
  planQuery,
  pruneQuery,
  querySchema,
  resolveCardSubitems,
  resolveField,
  rowComparator,
  rowMatches,
  saveCardSubitemsDefault,
  summarize,
  summaryOptions,
  t,
  type CardSubitemsDraft,
  type CardTab,
  type QueryEnv,
  type SummaryFn,
  queryColumnOf,
} from '@bines/shared';
import { Button, cn, Notice, SkeletonRows } from '@bines/ui';
import { errorMessage } from '../../lib/api';
import { promptDialog } from '../../lib/dialogs';
import { useDesktop } from '../../lib/use-desktop';
import { cellFor } from '../board/cells';
import { BoardAccountContext } from '../board/board-context';
import {
  type BoardDetail,
  type Column,
  type Item,
  type Member,
  useBoard,
  useBoardMutations,
  useItems,
  useTags,
  useTeams,
} from '../board/board-api';
import { SummaryCell, SummarySlot } from '../board/table/BoardTable';
import { FilterPanel, type FilterCtx } from '../board/toolbar/FilterPanel';
import { SortPanel } from '../board/toolbar/BoardToolbar';
import { CheckRow, PickerButton, ToolbarPanel } from '../board/toolbar/parts';
import { useAccountLocale, useViewMutations } from '../board/views/views-api';
import { ComputedNameMark } from '../board/name-source/ComputedName';
import { computedNameInfo } from '../board/name-source/name-source-api';
import { useSaveCardSubitems, useSubBoardViews } from './card-settings';

/**
 * The board that holds an item's subitems (D14): a top item's subitems live on its board's sub-board; a subitem's
 * own subitems live on the same sub-board (one level deeper).
 */
export const subBoardIdOf = (board: BoardDetail | undefined) =>
  board ? (board.parent_board_id ? board.id : (board.subitems_board_id ?? '')) : '';

/** The sub-board's columns shown in the tab: the chosen ones in their order, or the first few. */
export const subitemColumns = (subBoard: BoardDetail | undefined, columns: string[] | undefined): Column[] => {
  const all = (subBoard?.columns ?? []).filter((c) => c.type !== 'name');
  if (!columns) return all.slice(0, CARD_SUBITEM_DEFAULT_COLUMNS);
  return columns.map((id) => all.find((c) => c.id === id)).filter((c): c is Column => !!c);
};

/** The item's subitems, every level, grouped by parent (in their order). */
const useChildren = (accountId: string, subBoardId: string) => {
  const items = useItems(accountId, subBoardId);
  const children = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of items.data?.data ?? []) {
      if (!it.parent_item_id) continue;
      map.set(it.parent_item_id, [...(map.get(it.parent_item_id) ?? []), it]);
    }
    for (const list of map.values())
      list.sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    return map;
  }, [items.data]);
  return { items, children };
};

/** The count on the "subitems" tab: the item's direct subitems. */
export const useSubitemCount = (accountId: string, board: BoardDetail | undefined, itemId: string, on: boolean) => {
  const { children } = useChildren(accountId, on ? subBoardIdOf(board) : '');
  return children.get(itemId)?.length ?? 0;
};

/** "+ add subitem" (Enter adds; the field stays for the next one). */
const AddRow = ({
  parentId,
  depth,
  onAdd,
  testId,
  className,
  computed,
}: {
  parentId: string;
  depth: number;
  onAdd: (parentId: string, name: string, done: (ok: boolean) => void) => void;
  /** the sub-board computes names — a "+ add" button, no name to type (none is sent). */
  computed?: boolean;
  /** The form's test id (the top level's: `card-subitems-add`). */
  testId?: string;
  className?: string;
}) => {
  const [name, setName] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const value = name.trim();
    if (computed) return onAdd(parentId, '', () => undefined);
    if (!value) return;
    setName('');
    onAdd(parentId, value, (ok) => {
      if (!ok) setName((cur) => cur || value);
    });
  };
  return (
    <form
      onSubmit={submit}
      data-testid={testId}
      className={cn('flex h-9 items-center border-t border-line-soft px-2.5', className)}
      style={{ paddingInlineStart: `${0.625 + depth * 1.25}rem` }}
    >
      {computed ? (
        <button
          type="submit"
          data-testid="card-subitem-add"
          data-parent-id={parentId}
          className="h-7 truncate text-start text-sm text-muted hover:text-primary"
        >
          + {t('subitems.add')}
        </button>
      ) : (
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('subitems.add')}
          aria-label={t('subitems.add')}
          data-testid="card-subitem-add"
          data-parent-id={parentId}
          className="h-7 w-full min-w-0 bg-transparent text-sm outline-none placeholder:text-muted"
        />
      )}
    </form>
  );
};

/** ▸ that opens a subitem's own subitems (or its "+ add" when it has none yet). */
const Toggle = ({
  sub,
  kids,
  expanded,
  onToggle,
}: {
  sub: Item;
  kids: number;
  expanded: boolean;
  onToggle: () => void;
}) => (
  <Button
    variant="ghost"
    size="sm"
    aria-expanded={expanded}
    aria-label={t('subitems.toggle', { name: sub.name })}
    title={kids ? t('subitems.count', { n: kids }) : t('menu.item.addSubitem')}
    data-testid="card-subitem-toggle"
    onClick={onToggle}
    className="h-6 w-6 shrink-0 px-0 text-muted"
  >
    <span
      aria-hidden
      className={cn('inline-block text-sm transition-transform', expanded ? 'rotate-90' : 'rtl:rotate-180')}
    >
      ›
    </span>
  </Button>
);

/**
 * The item's subitems (owner fix 2, cardsub): the "Subitems" tab and — `embedded` — the table under the item's
 * fields in the "Fields" tab. What shows comes from the card's settings (`resolveCardSubitems`): a saved view of
 * the sub-board (columns, filter, sort, footer) or the tab's columns; the view picker and the filter / sort here
 * change it for this visit, and "save as default" keeps it in the card's settings. Every cell is the same editor
 * as the board's table; the footer sums each column like the board's (its calculation chosen by clicking it);
 * phones get small cards instead of the table. A subitem's name opens its own card; ▸ opens its subitems below
 * it (every level the board allows), each level with its own "+ add subitem".
 */
export const SubitemsTable = ({
  accountId,
  board,
  item,
  columns: tabColumns,
  members,
  onOpen,
  embedded = false,
}: {
  accountId: string;
  /** The item's own board (its card settings). */
  board: BoardDetail;
  item: Item;
  /** The subitems tab's chosen columns (`CardTab.columns`). */
  columns: string[] | undefined;
  members: Member[];
  onOpen: (itemId: string) => void;
  /** Inside the "Fields" tab: a titled section, nothing at all where no subitem can be. */
  embedded?: boolean;
}) => {
  const { meId } = useContext(BoardAccountContext);
  const desktop = useDesktop();
  const subBoardId = subBoardIdOf(board);
  const subBoard = useBoard(accountId, subBoardId).data;
  const rootBoard = useBoard(accountId, board.parent_board_id ?? board.id).data;
  const { items, children } = useChildren(accountId, subBoardId);
  const views = useSubBoardViews(accountId, subBoard ? subBoardId : '').data;
  const locale = useAccountLocale(accountId).data;
  const teams = useTeams(accountId).data?.data;
  const tags = useTags(accountId).data?.data;
  // Creating the first subitem creates the sub-board, so the mutation runs on the item's board until one exists.
  const m = useBoardMutations(accountId, subBoardId || board.id);
  const saveCard = useSaveCardSubitems(accountId, board);
  const vm = useViewMutations(accountId, subBoardId);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  /** The view picked here (`undefined` = the card's default, `null` = the card's columns) and the ad-hoc changes. */
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const [draft, setDraft] = useState<CardSubitemsDraft>({});
  const maxDepth = rootBoard?.hierarchy_depth_max ?? 1;
  const canAdd = !!(subBoard ?? board).capabilities['item.create'];
  const canEdit = !!subBoard?.capabilities['item.update'];
  const subComputed = computedNameInfo(subBoard).computed;
  const canManage = !!board.capabilities['board.update'];

  const subColumns = useMemo(() => (subBoard?.columns ?? []).filter((c) => c.type !== 'name'), [subBoard]);
  const resolved = resolveCardSubitems({
    card: board.card,
    allColumns: subColumns.map((c) => c.id),
    tabColumns,
    views: views ?? [],
    picked,
    draft,
  });
  const list = resolved.columns.map((id) => subColumns.find((c) => c.id === id)!).filter(Boolean);

  // The engine over the sub-board's columns (13-FILTERS) — the same filter / sort / summaries as the board.
  const timezone = locale?.timezone ?? 'Asia/Jerusalem';
  const [today] = useState(() => dateInZone(new Date(), timezone));
  const env = useMemo<QueryEnv>(
    () => ({
      columns: (subBoard?.columns ?? []).map(queryColumnOf),
      meId,
      teams: (teams ?? []).map((x) => ({ id: x.id, member_ids: x.member_ids })),
      today,
      timezone,
      weekend: locale?.weekend ?? 'fri_sat',
      firstDay: locale?.first_day ?? 0,
      calendar: getRegion().calendar,
    }),
    [subBoard, meId, teams, today, timezone, locale],
  );
  const { filter, sort, search, person } = resolved;
  const plan = (() => {
    try {
      return planQuery(pruneQuery(querySchema.parse({ filter, sort, search, person }), env), env);
    } catch {
      return null;
    }
  })();
  const filtering = !!plan && !isEmptyFilter({ filter, search, person });
  // Shown subitems per parent: a subitem stays when it — or one of its own subitems — matches; then sorted.
  const shown = (() => {
    if (!plan || (!filtering && !plan.sort.length)) return children;
    const compare = plan.sort.length ? rowComparator(plan) : null;
    const memo = new Map<string, boolean>();
    const keep = (it: Item): boolean => {
      const hit = memo.get(it.id);
      if (hit !== undefined) return hit;
      const ok = rowMatches(plan, it, timezone) || (children.get(it.id) ?? []).some(keep);
      memo.set(it.id, ok);
      return ok;
    };
    const out = new Map<string, Item[]>();
    for (const [parentId, kids] of children) {
      const kept = filtering ? kids.filter(keep) : kids;
      out.set(parentId, compare ? [...kept].sort(compare) : kept);
    }
    return out;
  })();

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const add = (parentId: string, name: string, done: (ok: boolean) => void) => {
    setError(null);
    m.createSubitem.mutate(
      // An empty name = a computed sub-board: the server names the subitem.
      { parentId, ...(name ? { name } : {}) },
      {
        onSuccess: () => done(true),
        onError: (e) => {
          setError(errorMessage(e));
          done(false);
        },
      },
    );
  };
  const saveSettings = (next: ReturnType<typeof cardSubitemsOf>, after?: () => void, tabs?: CardTab[]) =>
    saveCard.mutate(tabs ? { subitems: next, tabs } : { subitems: next }, {
      onSuccess: after,
      onError: (e) => setError(errorMessage(e)),
    });

  const top = shown.get(item.id) ?? [];
  const total = children.get(item.id)?.length ?? 0;
  const canNestTop = canAdd && item.depth + 1 <= maxDepth;

  if (subBoardId && items.isPending) return <SkeletonRows rows={3} label={t('app.loading')} />;
  if (items.isError) return <Notice tone="error">{errorMessage(items.error)}</Notice>;
  // In the Fields tab: nothing where this item cannot have subitems.
  if (embedded && !total && !canNestTop) return null;

  const cell = (sub: Item, c: Column) => {
    const Cell = cellFor(c);
    const value = sub.cells[c.id];
    return (
      <Cell
        column={c}
        value={value?.value ?? null}
        text={value?.text ?? null}
        names={value?.names}
        editable={canEdit && !c.read_only && !c.restricted_edit}
        members={members}
        accountId={accountId}
        itemId={sub.id}
        boardId={subBoardId}
        rowCells={sub.cells}
        onChange={(v) => m.setCell.mutate({ itemId: sub.id, columnId: c.id, value: v })}
        canEditSettings={!!subBoard?.capabilities['column.update']}
        onSettingsChange={(settings) => m.updateColumn.mutateAsync({ columnId: c.id, settings })}
      />
    );
  };

  // The footer over the item's shown direct subitems (the board footer's calculations, 11-UI §2).
  const summaries = list.map((c) => {
    try {
      const field = resolveField(c.id, env);
      return { options: summaryOptions(field), summary: summarize(field, top, timezone, resolved.summaries[c.id]) };
    } catch {
      return { options: [] as SummaryFn[], summary: null };
    }
  });
  const chooseSummary = canManage
    ? (columnId: string, fn: SummaryFn) => {
        const card = cardSubitemsOf(board.card);
        saveSettings({ ...card, summaries: { ...card.summaries, [columnId]: fn } });
      }
    : undefined;
  const showSummary = resolved.showSummary && top.length > 0 && list.length > 0;

  const nameOf = (s: Item, kids: number) => (
    <>
      {s.name_computed && subBoard ? <ComputedNameMark board={subBoard} /> : null}
      <button
        type="button"
        onClick={() => onOpen(s.id)}
        data-testid="card-subitem-open"
        title={s.name}
        className={cn(
          'min-w-0 flex-1 truncate rounded-[6px] px-1 py-1 text-start text-sm text-fg hover:bg-surface-2 hover:text-primary hover:underline',
          s.name_computed && 'text-fg-2',
        )}
      >
        {s.name}
      </button>
      {kids ? (
        <span className="shrink-0 rounded-full bg-surface-2 px-1.5 text-xs font-normal text-fg-2">{kids}</span>
      ) : null}
    </>
  );

  // name | cells…; the cells keep a fixed width, the table scrolls sideways on narrow screens.
  const grid = { gridTemplateColumns: `minmax(200px,1fr) repeat(${list.length}, 132px)` };
  const rows = (parentId: string, depth: number): ReactNode[] =>
    (shown.get(parentId) ?? []).flatMap((sub) => {
      const kids = shown.get(sub.id) ?? [];
      const expanded = open.has(sub.id);
      const canNest = canAdd && sub.depth + 1 <= maxDepth;
      const nested = expanded
        ? [
            ...rows(sub.id, depth + 1),
            ...(canNest
              ? [
                  <AddRow
                    key={`${sub.id}-add`}
                    parentId={sub.id}
                    depth={depth + 1}
                    onAdd={add}
                    computed={subComputed}
                  />,
                ]
              : []),
          ]
        : [];
      if (!desktop)
        // Phones: a small card per subitem — its name, then each shown column as a label and its editor.
        return [
          <div
            key={sub.id}
            className="flex flex-col gap-1.5 border-t border-line-soft px-2.5 py-2"
            style={{ paddingInlineStart: `${0.625 + depth * 1.25}rem` }}
            data-testid="card-subitem"
            data-item-id={sub.id}
            data-item-name={sub.name}
            data-depth={depth}
            data-layout="card"
          >
            <div className="flex min-w-0 items-center gap-1">
              {kids.length || canNest ? (
                <Toggle sub={sub} kids={kids.length} expanded={expanded} onToggle={() => toggle(sub.id)} />
              ) : null}
              {nameOf(sub, kids.length)}
            </div>
            {list.map((c) => (
              <div
                key={c.id}
                className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] items-center gap-2"
                data-column={c.id}
                data-column-type={c.type}
              >
                <span className="truncate text-xs font-semibold text-muted" title={c.description ?? c.title}>
                  {c.title}
                </span>
                <div className="h-8 min-w-0 overflow-hidden rounded-[var(--radius-sm)] border border-line bg-surface">
                  {cell(sub, c)}
                </div>
              </div>
            ))}
          </div>,
          ...nested,
        ];
      return [
        <div
          key={sub.id}
          className="grid min-h-9 items-stretch border-t border-line-soft"
          style={grid}
          data-testid="card-subitem"
          data-item-id={sub.id}
          data-item-name={sub.name}
          data-depth={depth}
        >
          <div
            className="flex min-w-0 items-center gap-1 px-1.5"
            style={{ paddingInlineStart: `${0.375 + depth * 1.25}rem` }}
          >
            {kids.length || canNest ? (
              <Toggle sub={sub} kids={kids.length} expanded={expanded} onToggle={() => toggle(sub.id)} />
            ) : (
              <span className="w-6 shrink-0" />
            )}
            {nameOf(sub, kids.length)}
          </div>
          {list.map((c) => (
            <div
              key={c.id}
              className="min-w-0 overflow-hidden border-s border-line-soft"
              data-column={c.id}
              data-column-type={c.type}
            >
              {cell(sub, c)}
            </div>
          ))}
        </div>,
        ...nested,
      ];
    });

  const empty = !top.length ? (
    <p className="border-t border-line-soft px-3 py-2.5 text-sm text-muted" data-testid="card-subitems-empty">
      {total ? t('cardsub.emptyFiltered') : t('item.subitems.empty')}
    </p>
  ) : null;
  const addTop = canNestTop ? (
    <AddRow parentId={item.id} depth={0} onAdd={add} testId="card-subitems-add" computed={subComputed} />
  ) : null;

  const summaryRow = !showSummary ? null : desktop ? (
    <div className="grid h-9 border-t border-line-soft bg-surface-3" style={grid} data-testid="card-subitems-summary">
      <span className="flex items-center truncate px-3 text-xs font-semibold text-muted">{t('cardsub.summary')}</span>
      {list.map((c, i) => (
        <SummarySlot
          key={c.id}
          column={c}
          options={summaries[i]!.options}
          current={resolved.summaries[c.id]}
          onChoose={chooseSummary ? (fn) => chooseSummary(c.id, fn) : undefined}
        >
          <SummaryCell summary={summaries[i]!.summary} defaultFn={summaries[i]!.options[0]} />
        </SummarySlot>
      ))}
    </div>
  ) : (
    <div
      className="flex flex-col gap-1 border-t border-line-soft bg-surface-3 px-2.5 py-2"
      data-testid="card-subitems-summary"
    >
      {list.map((c, i) =>
        summaries[i]!.summary ? (
          <div key={c.id} className="flex items-center justify-between gap-2" data-summary={c.id}>
            <span className="truncate text-xs font-semibold text-muted">{c.title}</span>
            <SummaryCell summary={summaries[i]!.summary} defaultFn={summaries[i]!.options[0]} />
          </div>
        ) : null,
      )}
    </div>
  );

  const viewName = (id: string | null | undefined) => views?.find((v) => v.id === id)?.name;
  const defaultViewName = viewName(cardSubitemsOf(board.card).view_id);
  const pickedLabel =
    picked === undefined
      ? defaultViewName
        ? `${t('cardsub.view.default')} · ${defaultViewName}`
        : t('cardsub.view.default')
      : picked === null
        ? t('cardsub.view.none')
        : (viewName(picked) ?? t('cardsub.view.default'));
  const pick = (v: string | null | undefined) => {
    setPicked(v);
    setDraft({});
  };
  const changed =
    picked !== undefined || draft.filter !== undefined || draft.sort !== undefined || draft.columns !== undefined;
  const pickedView = views?.find((v) => v.id === resolved.viewId);
  // A view's settings with what the card shows now (columns, filter, sort); a new view takes the footer too.
  const asViewSettings = (base: ReturnType<typeof viewSettingsSchema.parse>, footer = false) => ({
    ...base,
    query: { ...base.query, filter, sort },
    column_order: resolved.columns,
    hidden_columns: subColumns.map((c) => c.id).filter((id) => !resolved.columns.includes(id)),
    summaries: footer ? ({ ...base.summaries, ...resolved.summaries } as typeof base.summaries) : base.summaries,
  });
  const saveDefault = () => {
    const next = saveCardSubitemsDefault(cardSubitemsOf(board.card), picked, draft);
    // Columns chosen here without a view are the subitems tab's columns.
    const tabs =
      draft.columns && !resolved.viewId
        ? board.card.tabs.some((x) => x.type === 'subitems')
          ? board.card.tabs.map((x) => (x.type === 'subitems' ? { ...x, columns: draft.columns } : x))
          : [...board.card.tabs, { id: 'subitems', type: 'subitems' as const, hidden: false, columns: draft.columns }]
        : undefined;
    saveSettings(next, () => pick(undefined), tabs);
  };
  const saveAsView = async () => {
    const name = await promptDialog({
      title: t('cardsub.saveAsView'),
      label: t('view.name'),
      initial: '',
    });
    if (!name) return;
    vm.create.mutate(
      { name, type: 'table', settings: asViewSettings(viewSettingsSchema.parse({}), true) },
      { onSuccess: (v) => pick(v.id), onError: (e) => setError(errorMessage(e)) },
    );
  };
  const saveToView = () => {
    if (!pickedView) return;
    vm.save.mutate(
      { view: pickedView, settings: asViewSettings(pickedView.settings) },
      { onSuccess: () => setDraft({}), onError: (e) => setError(errorMessage(e)) },
    );
  };
  const toggleColumn = (id: string, on: boolean) =>
    setDraft((d) => ({
      ...d,
      columns: on ? [...resolved.columns, id] : resolved.columns.filter((x) => x !== id),
    }));
  const filterCtx: FilterCtx = {
    env,
    columns: subBoard?.columns ?? [],
    subColumns: [],
    groups: [],
    members,
    teams: teams ?? [],
    tags: tags ?? [],
    meId,
  };
  const all = children.get(item.id) ?? [];
  const filterCount = filter ? filter.rules.length : 0;

  const tools = subBoard ? (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="card-subitems-tools">
      <PickerButton
        label={pickedLabel}
        placeholder={t('cardsub.view')}
        menuLabel={t('cardsub.view')}
        testId="card-subitems-view"
        className="max-w-[16rem]"
        items={[
          {
            label: defaultViewName ? `${t('cardsub.view.default')} · ${defaultViewName}` : t('cardsub.view.default'),
            checked: picked === undefined,
            onSelect: () => pick(undefined),
            testId: 'card-subitems-view-default',
          },
          {
            label: t('cardsub.view.none'),
            checked: picked === null,
            onSelect: () => pick(null),
            testId: 'card-subitems-view-none',
          },
          ...(views ?? []).map((v) => ({
            label: v.name,
            checked: picked === v.id,
            onSelect: () => pick(v.id),
            testId: 'card-subitems-view-option',
          })),
        ]}
      />
      <ToolbarPanel
        label={t('toolbar.filter')}
        icon="filter"
        count={filterCount}
        testId="card-subitems-filter"
        panelClassName="w-[min(760px,95vw)] max-w-[calc(100vw-1rem)] p-0"
      >
        {() => (
          <FilterPanel
            filter={filter}
            onChange={(f) => setDraft((d) => ({ ...d, filter: f ?? null }))}
            ctx={filterCtx}
            rows={all}
            matching={top.length}
            matchChildren={false}
            onMatchChildren={() => undefined}
          />
        )}
      </ToolbarPanel>
      <ToolbarPanel label={t('toolbar.sort')} icon="sort" count={sort.length} testId="card-subitems-sort">
        {() => (
          <div className="w-[min(420px,90vw)]" data-testid="card-subitems-sort-panel">
            <SortPanel sort={sort} columns={subBoard.columns} onChange={(s) => setDraft((d) => ({ ...d, sort: s }))} />
          </div>
        )}
      </ToolbarPanel>
      <ToolbarPanel label={t('cardsub.columns')} icon="table" compact testId="card-subitems-columns">
        {() => (
          <div className="max-h-80 w-64 overflow-auto" data-testid="card-subitems-columns-panel">
            {subColumns.map((c) => (
              <CheckRow
                key={c.id}
                checked={resolved.columns.includes(c.id)}
                onToggle={() => toggleColumn(c.id, !resolved.columns.includes(c.id))}
              >
                <span className="truncate" data-testid="card-subitems-column-toggle" data-column={c.id}>
                  {c.title}
                </span>
              </CheckRow>
            ))}
          </div>
        )}
      </ToolbarPanel>
      {draft.filter !== undefined || draft.sort !== undefined || draft.columns !== undefined ? (
        <>
          {pickedView?.can_save && !pickedView.is_system ? (
            <Button
              variant="ghost"
              size="sm"
              busy={vm.save.isPending}
              data-testid="card-subitems-save-view"
              onClick={saveToView}
            >
              {t('cardsub.saveToView', { name: pickedView.name })}
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            busy={vm.create.isPending}
            data-testid="card-subitems-save-as-view"
            onClick={() => void saveAsView()}
          >
            {t('cardsub.saveAsView')}
          </Button>
        </>
      ) : null}
      {changed ? (
        <>
          <Button variant="ghost" size="sm" data-testid="card-subitems-reset" onClick={() => pick(undefined)}>
            {t('cardsub.reset')}
          </Button>
          {canManage ? (
            <Button
              variant="secondary"
              size="sm"
              busy={saveCard.isPending}
              data-testid="card-subitems-save-default"
              onClick={saveDefault}
            >
              {t('cardsub.saveDefault')}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  ) : null;

  return (
    <section
      className="flex flex-col gap-2.5"
      data-testid={embedded ? 'card-fields-subitems' : 'card-subitems'}
      data-view-id={resolved.viewId ?? ''}
    >
      {embedded || tools ? (
        <div className="flex flex-wrap items-center gap-2">
          {embedded ? (
            <h3 className="flex items-center gap-1.5 text-[0.8125rem] font-bold text-heading">
              {t('item.subitems')}
              <span className="rounded-full bg-surface-2 px-1.5 text-xs font-normal text-fg-2 tabular-nums">
                {total}
              </span>
            </h3>
          ) : null}
          <div className="ms-auto">{tools}</div>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-[14px] border border-line" data-testid="card-subitems-table">
        {desktop ? (
          <div className="min-w-fit">
            <div className="grid h-9 items-center bg-surface-3 text-xs font-semibold text-muted" style={grid}>
              <span className="truncate px-3">{t('item.subitems')}</span>
              {list.map((c) => (
                <span
                  key={c.id}
                  className="truncate border-s border-line-soft px-2 text-center"
                  title={c.description ?? c.title}
                  data-column-head={c.id}
                >
                  {c.title}
                </span>
              ))}
            </div>
            {rows(item.id, 0)}
            {empty}
            {addTop}
            {summaryRow}
          </div>
        ) : (
          <div className="[&>*:first-child]:border-t-0">
            {rows(item.id, 0)}
            {empty}
            {addTop}
            {summaryRow}
          </div>
        )}
      </div>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </section>
  );
};

/** "Subitems" tab of the item card: the subitems table with its view picker. */
export const SubitemsTab = (props: {
  accountId: string;
  board: BoardDetail;
  item: Item;
  columns: string[] | undefined;
  members: Member[];
  onOpen: (itemId: string) => void;
}) => <SubitemsTable {...props} />;
