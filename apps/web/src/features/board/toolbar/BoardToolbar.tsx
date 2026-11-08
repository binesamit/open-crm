// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useRef, useState } from 'react';
import {
  columnTypes,
  MAX_SORT_LEVELS,
  orderColumns,
  ruleProblem,
  t,
  type Column,
  type QueryRow,
  type SortLevel,
  type ViewSettings,
  type ViewType,
} from '@bines/shared';
import { ClearSearchButton, cn, matchesSearch, SearchField, searchNeedle } from '@bines/ui';
import { closestCenter, DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { activeRules, removeRuleAt } from './filter-model';
import { FilterPanel, ruleChipLabel, type FilterCtx } from './FilterPanel';
import { CheckRow, IconButton, PickerButton, ToolbarIconOnly, ToolbarPanel, ToolbarSheet } from './parts';
import { GroupByPanel } from './GroupByPanel';
import { Icon } from '../../../lib/icons';
import { isFindKey } from '../../../lib/keys';
import { columnTypeLabel } from '../../../lib/locale';

type Update = (fn: (s: ViewSettings) => ViewSettings) => void;
const setQuery = (update: Update, patch: Partial<ViewSettings['query']>) =>
  update((s) => ({ ...s, query: { ...s.query, ...patch } }));

/**
 * The view's active conditions — the Person filter, then every complete filter rule — each with its wording and
 * the query patch that removes it (the filter button's count and tooltip; the phone's chips row).
 */
export const activeConditions = (q: ViewSettings['query'], ctx: FilterCtx) => {
  const personName = q.person ? personChoices(ctx).find((p) => p.key === q.person)?.name : undefined;
  return [
    ...(q.person
      ? [
          {
            key: 'person',
            label: `${t('toolbar.person')}: ${personName ?? q.person}`,
            clear: { person: undefined } as Partial<ViewSettings['query']>,
          },
        ]
      : []),
    // A rule that cannot run here (old / imported data) is skipped by the query: not counted.
    ...activeRules(q.filter)
      .filter(({ rule }) => ruleProblem(rule, ctx.env) === null)
      .map(({ path, rule }) => ({
        key: path.join('.'),
        label: ruleChipLabel(rule, ctx),
        clear: { filter: removeRuleAt(q.filter, path) } as Partial<ViewSettings['query']>,
      })),
  ];
};

/**
 * The board toolbar (11-UI §2, 13-FILTERS §4.1): search, filter, sort, group by, hidden columns, view settings.
 * Prod fix (r15board 1): no "collapse all" (the group menu and Ctrl+G have it), no "person" (the filter covers
 * it), coloring moved into the view settings, and "hidden" sits right before the gear.
 * Every change goes to the view draft; the save bar offers "save to view / save as new / reset" (15 §2).
 */
export const BoardToolbar = ({
  settings,
  update,
  onSearch,
  ctx,
  rows,
  matching,
  viewType,
  subColumns,
  extra,
  end,
  sheet,
  onReorderColumns,
}: {
  settings: ViewSettings;
  update: Update;
  /** The board's search (round 11: kept across the board's views, never in a view's draft). */
  onSearch: (search: string) => void;
  ctx: FilterCtx;
  rows: QueryRow[];
  matching: number;
  viewType: ViewType;
  /** The sub-board's columns (name included) — the table sorts subitems by them; none = no subitems. */
  subColumns?: Column[];
  extra?: React.ReactNode;
  /** View-type settings (Kanban lanes, calendar dates…), after the common tools. */
  end?: React.ReactNode;
  /** Prod fix (mobilehead): the phone's tools sheet — no search (the bar has it), one full-width row per tool. */
  sheet?: boolean;
  /** A column moved in the hide panel; unset = a draft of the view (`column_order`). */
  onReorderColumns?: (columnId: string, order: string[]) => void;
}) => {
  const table = viewType === 'table';
  const q = settings.query;
  // Owner fix 5: no chips — the filter button just counts the active conditions (the person filter too); their
  // wording stays in its tooltip.
  const conditions = activeConditions(q, ctx).map((c) => c.label);
  const columns = orderColumns(
    ctx.columns.filter((c) => c.type !== 'name'),
    settings.column_order,
  );
  // Subitems show in the table only: that is where their sort applies.
  const subSort = table && subColumns?.length ? subColumns : null;
  // Round 13: the sub-board's columns can be hidden too (their own list in the hide panel, saved with the view).
  const subHideable = subSort ? subSort.filter((c) => c.type !== 'name') : [];
  const subHidden = subHideable.length
    ? settings.subitems_hidden_columns.filter((id) => subHideable.some((c) => c.id === id))
    : [];
  // Only columns still on the board count (a deleted column's id may linger in a saved view).
  const hidden = settings.hidden_columns.filter((id) => columns.some((c) => c.id === id));
  const hiddenCount = hidden.length + subHidden.length;
  return (
    // F4 order: search, filter (dashed), then the ghost tools, export, and view settings as an icon.
    // Phones: search on its own row, then every tool in one row that scrolls sideways (never a lone wrapped icon);
    // `relative` keeps the icons' hidden labels (sr-only, absolute) inside that row, not widening the page.
    <ToolbarSheet.Provider value={!!sheet}>
      <div
        className={
          sheet ? 'flex w-full flex-col items-stretch gap-0.5' : 'flex w-full min-w-0 flex-wrap items-center gap-1.5'
        }
        data-testid="board-toolbar"
        data-sheet={sheet || undefined}
      >
        {sheet ? null : <SearchBox value={q.search ?? ''} onChange={onSearch} />}
        <div
          className={
            sheet
              ? 'contents'
              : 'contents max-md:relative max-md:flex max-md:w-full max-md:items-center max-md:gap-1.5 max-md:overflow-x-auto max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden max-md:[&>*]:shrink-0'
          }
        >
          <ToolbarPanel
            label={t('toolbar.filter')}
            icon="filter"
            count={conditions.length}
            plainCount
            countTitle={conditions.join(' · ')}
            testId="toolbar-filter"
            tour="board.filter"
            variant="dashed"
            scrim
            // Phones: a bottom sheet (the !important beats the popover's inline placement).
            panelClassName="w-[min(880px,95vw)] max-w-[calc(100vw-1rem)] p-0 max-md:inset-x-0! max-md:top-auto! max-md:bottom-0! max-md:w-full! max-md:max-w-none max-md:max-h-[85vh]! max-md:rounded-b-none max-md:rounded-t-[20px]"
          >
            {() => (
              <FilterPanel
                filter={q.filter}
                onChange={(filter) => setQuery(update, { filter })}
                ctx={ctx}
                rows={rows}
                matching={matching}
                matchChildren={q.match_children}
                onMatchChildren={(match_children) => setQuery(update, { match_children })}
                strict={!!q.subitems_strict}
                onStrict={(subitems_strict) => setQuery(update, { subitems_strict })}
              />
            )}
          </ToolbarPanel>
          <ToolbarPanel
            label={t('toolbar.sort')}
            icon="sort"
            count={q.sort.length + (subSort ? settings.subitems_sort.length : 0)}
            testId="toolbar-sort"
            tour="board.sort"
          >
            {() => (
              <div className="w-[min(420px,90vw)] space-y-4" data-testid="sort-panel">
                <SortPanel sort={q.sort} columns={ctx.columns} onChange={(sort) => setQuery(update, { sort })} />
                {subSort ? (
                  // Owner fix: the subitems get their own sort (sub-board columns), saved with the view.
                  <div className="border-t border-line pt-3">
                    <SortPanel
                      title={t('sort.subitems')}
                      empty={t('sort.subitemsEmpty')}
                      testPrefix="subsort"
                      sort={settings.subitems_sort}
                      columns={subSort}
                      onChange={(subitems_sort) => update((s) => ({ ...s, subitems_sort }))}
                    />
                  </div>
                ) : null}
              </div>
            )}
          </ToolbarPanel>
          {table ? (
            <ToolbarPanel
              label={t('toolbar.groupBy')}
              icon="group"
              active={!!q.group_by || !!q.subgroups?.length}
              testId="toolbar-group"
            >
              {(close) => (
                <GroupByPanel
                  value={{ group_by: q.group_by, subgroups: q.subgroups }}
                  ctx={ctx}
                  onChange={(g) => {
                    setQuery(update, { group_by: g.group_by, subgroups: g.subgroups });
                    // Back to the board's groups with no levels inside: nothing more to set here.
                    if (!g.group_by && !g.subgroups?.length) close();
                  }}
                />
              )}
            </ToolbarPanel>
          ) : null}
          {extra}
          {table ? (
            // Round 12 (product decision): "מוסתרות" without its text — the icon and, when columns are hidden, their count.
            <ToolbarPanel
              label={hiddenCount ? t('toolbar.hidden', { n: hiddenCount }) : t('toolbar.hide')}
              icon="eyeOff"
              compact
              count={hiddenCount}
              active={hiddenCount > 0}
              testId="toolbar-hide"
            >
              {() => (
                <HidePanel
                  columns={columns}
                  onReorder={(id, column_order) =>
                    onReorderColumns ? onReorderColumns(id, column_order) : update((s) => ({ ...s, column_order }))
                  }
                  hidden={hidden}
                  onChange={(hidden_columns) => update((s) => ({ ...s, hidden_columns }))}
                  sub={
                    subHideable.length
                      ? {
                          columns: subHideable,
                          hidden: subHidden,
                          onChange: (subitems_hidden_columns) => update((s) => ({ ...s, subitems_hidden_columns })),
                        }
                      : undefined
                  }
                />
              )}
            </ToolbarPanel>
          ) : null}
          <ToolbarIconOnly.Provider value={!sheet}>{end}</ToolbarIconOnly.Provider>
        </div>
      </div>
    </ToolbarSheet.Provider>
  );
};

/** The shortcut as this keyboard writes it (shown in the field while it is idle). */
const FIND_KEYS = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘ F' : 'Ctrl F';

/**
 * Free-text search (Ctrl+F): typing filters as you go (debounced); Esc clears and leaves the field.
 * Owner fix 5: Ctrl+F is the board's search, never the browser's find bar — the field says so ("חיפוש בלוח…" and
 * a Ctrl F chip while idle) and lights up with the accent ring when the shortcut brings it up.
 */
export const SearchBox = ({
  value,
  onChange,
  autoFocus,
  onLeave,
}: {
  value: string;
  onChange: (v: string) => void;
  /** Prod fix (mobilehead): the phone bar's search opens focused… */
  autoFocus?: boolean;
  /** …and folds back into its icon when the field is left (`empty`: nothing is searched). */
  onLeave?: (empty: boolean) => void;
}) => {
  const [text, setText] = useState(value);
  const [seen, setSeen] = useState(value);
  const [focused, setFocused] = useState(false);
  // Brought up by Ctrl+F (until the field is left): the accent ring instead of the plain focus.
  const [summoned, setSummoned] = useState(false);
  const ref = useRef<HTMLInputElement>(null);
  // An outside change (reset, another view) replaces what is typed.
  if (value !== seen) {
    setSeen(value);
    setText(value);
  }
  useEffect(() => {
    if (text.trim() === value) return;
    const id = setTimeout(() => onChange(text.trim()), 200);
    return () => clearTimeout(id);
  }, [text, value, onChange]);
  // Round 11: switching views right after typing (inside the debounce) still keeps what was typed.
  const latest = useRef({ text, value, onChange });
  useEffect(() => {
    latest.current = { text, value, onChange };
  });
  useEffect(
    () => () => {
      const { text: typed, value: had, onChange: send } = latest.current;
      if (typed.trim() !== had) send(typed.trim());
    },
    [],
  );
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isFindKey(e)) return;
      e.preventDefault();
      setSummoned(true);
      ref.current?.focus();
      ref.current?.select();
    };
    // Capture: before any field or grid handler can stop it, so the browser's find never opens here.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
  // Owner fix (fix5-board 4): idle (empty, not in use) the search is a compact tool — the magnifier and the
  // Ctrl F hint; a click or Ctrl+F opens the field, and it folds back when left empty. Phones keep the full field
  // (no keyboard shortcut there). The input stays mounted (only its width changes), so focus / typing just work.
  const idle = !focused && !text;
  return (
    <div
      className="relative shrink-0 max-md:w-full"
      data-testid="board-search"
      data-tour="board.search"
      data-collapsed={idle || undefined}
    >
      <span
        aria-hidden
        data-testid="search-icon"
        className="pointer-events-none absolute inset-y-0 start-2.5 z-[1] flex items-center text-muted"
      >
        <Icon name="search" size={14} strokeWidth={2} />
      </span>
      <input
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocused(true)}
        autoFocus={autoFocus}
        onBlur={(e) => {
          setFocused(false);
          setSummoned(false);
          onLeave?.(!e.currentTarget.value.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setText('');
            onChange('');
            e.currentTarget.blur();
          }
        }}
        placeholder={t('toolbar.searchBoard')}
        aria-label={t('toolbar.search')}
        aria-keyshortcuts="Control+F"
        title={t('toolbar.searchBoardHint')}
        data-testid="toolbar-search"
        data-summoned={summoned || undefined}
        className={cn(
          'h-8 w-56 rounded-[10px] border border-line-strong bg-surface ps-8 pe-2 text-sm outline-none transition-[width,box-shadow,background-color,border-color] duration-200 placeholder:text-muted focus:border-heading focus:ring-3 focus:ring-[var(--accent-soft)] max-md:w-full',
          // Folded: just wide enough for [magnifier][Ctrl F] laid side by side from the start edge (fix6-table 2).
          idle &&
            'md:w-[88px] md:cursor-pointer md:border-transparent md:bg-transparent md:pe-1 md:placeholder:text-transparent md:hover:bg-surface-2',
          text && 'border-primary bg-primary-soft',
          summoned &&
            'w-64 border-accent! ring-3 ring-[color-mix(in_srgb,var(--accent)_45%,transparent)]! max-md:w-full',
          text && 'pe-8',
        )}
      />
      {/* Fix: an "X" clears the search while it holds text (at once, no debounce). */}
      <span className="absolute inset-y-0 end-1.5 flex items-center">
        <ClearSearchButton
          value={text}
          testId="toolbar-search-clear"
          onClear={() => {
            setText('');
            onChange('');
            ref.current?.focus();
          }}
        />
      </span>
      {idle ? (
        <kbd
          aria-hidden
          data-testid="search-kbd"
          // Anchored right after the magnifier (start edge), never to the far end — so the two can never overlap,
          // whatever width the shortcut text takes in either direction.
          className="pointer-events-none absolute inset-y-0 start-8 my-auto flex h-5 items-center whitespace-nowrap rounded-[6px] border border-line bg-surface-2 px-1.5 font-sans text-[0.6875rem] font-semibold text-muted max-md:hidden"
        >
          {/* LTR text inside, never on the kbd itself: `start-8` resolves by the element's own direction. */}
          <span dir="ltr">{FIND_KEYS}</span>
        </kbd>
      ) : null}
    </div>
  );
};

/** The Person filter's choices: me, the other members, then the teams. */
const personChoices = (ctx: FilterCtx) => {
  const me = ctx.members.find((m) => m.user_id === ctx.meId);
  return [
    ...(me ? [{ key: 'me', name: t('filter.me'), member: me }] : []),
    ...ctx.members
      .filter((m) => m.user_id !== ctx.meId)
      .map((m) => ({ key: `user:${m.user_id}`, name: m.name || m.email, member: m })),
    ...ctx.teams.map((x) => ({ key: `team:${x.id}`, name: x.name, member: { name: x.name, avatar_url: null } })),
  ];
};

const sortable = (columns: Column[]) => columns.filter((c) => (columnTypes.get(c.type)?.sortKey ?? 'none') !== 'none');

/** Up to 5 sort levels, dragged into order (13 §4.1). `testPrefix` names the test ids (`sort-row`, `sort-add`). */
export const SortPanel = ({
  sort,
  columns,
  onChange,
  title = t('sort.title'),
  empty = t('sort.empty'),
  testPrefix = 'sort',
}: {
  sort: SortLevel[];
  columns: Column[];
  onChange: (sort: SortLevel[]) => void;
  title?: string;
  empty?: string;
  testPrefix?: string;
}) => {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const ids = sort.map((s, i) => `${i}:${s.column_id}`);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    onChange(arrayMove(sort, ids.indexOf(String(active.id)), ids.indexOf(String(over.id))));
  };
  const choices = sortable(columns);
  const unused = choices.filter((c) => !sort.some((s) => s.column_id === c.id));
  return (
    <div className="space-y-2" data-testid={`${testPrefix}-section`}>
      <div className="text-sm font-semibold">{title}</div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {sort.map((s, i) => (
            <SortRow
              key={ids[i]}
              id={ids[i]!}
              level={s}
              testId={`${testPrefix}-row`}
              columns={choices.filter((c) => c.id === s.column_id || !sort.some((x) => x.column_id === c.id))}
              onChange={(next) => onChange(sort.map((x, j) => (j === i ? next : x)))}
              onRemove={() => onChange(sort.filter((_, j) => j !== i))}
            />
          ))}
        </SortableContext>
      </DndContext>
      {!sort.length ? <p className="text-xs text-muted">{empty}</p> : null}
      {sort.length < MAX_SORT_LEVELS && unused.length ? (
        <button
          type="button"
          className="text-sm text-primary hover:underline"
          data-testid={`${testPrefix}-add`}
          onClick={() => onChange([...sort, { column_id: unused[0]!.id, direction: 'asc', nulls: 'last' }])}
        >
          {t('sort.add')}
        </button>
      ) : null}
    </div>
  );
};

const SortRow = ({
  id,
  level,
  testId,
  columns,
  onChange,
  onRemove,
}: {
  id: string;
  level: SortLevel;
  testId: string;
  columns: Column[];
  onChange: (s: SortLevel) => void;
  onRemove: () => void;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className="flex items-center gap-2"
      data-testid={testId}
    >
      <span {...attributes} {...listeners} className="cursor-grab px-1 text-muted" aria-label={t('sort.drag')}>
        ⠿
      </span>
      <PickerButton
        label={columns.find((c) => c.id === level.column_id)?.title}
        placeholder={t('filter.column')}
        menuLabel={t('filter.column')}
        className="w-44"
        testId={`${testId}-column`}
        items={columns.map((c) => ({
          label: c.title,
          keywords: columnTypeLabel(c.type),
          checked: c.id === level.column_id,
          onSelect: () => onChange({ ...level, column_id: c.id }),
        }))}
      />
      <div className="flex overflow-hidden rounded-[var(--radius-sm)] border border-line text-xs">
        {(['asc', 'desc'] as const).map((d) => (
          <button
            key={d}
            type="button"
            aria-pressed={level.direction === d}
            data-testid={`${testId}-${d}`}
            onClick={() => onChange({ ...level, direction: d })}
            className={cn('px-2 py-1.5', level.direction === d ? 'bg-primary text-on-primary' : 'hover:bg-surface-2')}
          >
            {t(`sort.${d}`)}
          </button>
        ))}
      </div>
      <IconButton label={t('sort.remove')} onClick={onRemove} className="ms-auto">
        ✕
      </IconButton>
    </div>
  );
};

/**
 * Hide columns (15 §4): hiding never deletes data; the name column always stays. Rows drag to reorder the
 * view's columns (a draft, like dragging headers in the table — saved with the save bar).
 */
const HidePanel = ({
  columns,
  hidden,
  onChange,
  onReorder,
  sub,
}: {
  columns: Column[];
  hidden: string[];
  onChange: (hidden: string[]) => void;
  onReorder?: (columnId: string, order: string[]) => void;
  /** Round 13: the sub-board's columns (a "subitems" section), hidden per view (`subitems_hidden_columns`). */
  sub?: { columns: Column[]; hidden: string[]; onChange: (hidden: string[]) => void };
}) => {
  const [q, setQ] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const searching = q.trim() !== '';
  const matches = (c: Column) => matchesSearch(`${c.title} ${columnTypeLabel(c.type)}`, searchNeedle(q));
  const shown = columns.filter(matches);
  const subShown = sub ? sub.columns.filter(matches) : [];
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id || !onReorder) return;
    const keys = columns.map((c) => c.id);
    onReorder(String(active.id), arrayMove(keys, keys.indexOf(String(active.id)), keys.indexOf(String(over.id))));
  };
  return (
    <div className="w-72 space-y-2" data-testid="hide-panel">
      <SearchField value={q} onChange={setQ} placeholder={t('toolbar.searchColumns')} testId="hide-search" autoFocus />
      <div className="flex justify-between text-xs">
        <button
          type="button"
          className="text-primary hover:underline"
          data-testid="hide-show-all"
          onClick={() => {
            onChange([]);
            sub?.onChange([]);
          }}
        >
          {t('toolbar.showAll')}
        </button>
        <button
          type="button"
          className="text-primary hover:underline"
          data-testid="hide-hide-all"
          onClick={() => {
            onChange(columns.map((c) => c.id));
            sub?.onChange(sub.columns.map((c) => c.id));
          }}
        >
          {t('toolbar.hideAll')}
        </button>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
        <SortableContext items={shown.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <div className="max-h-80 overflow-y-auto">
            {shown.map((c) => (
              <HideRow
                key={c.id}
                column={c}
                visible={!hidden.includes(c.id)}
                draggable={!!onReorder && !searching}
                onToggle={(visible) => onChange(visible ? [...hidden, c.id] : hidden.filter((h) => h !== c.id))}
              />
            ))}
            {sub && subShown.length ? (
              <div className="mt-2 border-t border-line pt-2" data-testid="hide-sub-section">
                <div className="flex items-center justify-between px-1 pb-1">
                  <span className="text-xs font-semibold text-muted">{t('r13.hide.subitems')}</span>
                  {sub.hidden.length ? (
                    <span className="text-xs text-muted" data-testid="hide-sub-count">
                      {t('toolbar.hidden', { n: sub.hidden.length })}
                    </span>
                  ) : null}
                </div>
                {subShown.map((c) => (
                  <HideRow
                    key={`sub:${c.id}`}
                    column={c}
                    sub
                    visible={!sub.hidden.includes(c.id)}
                    draggable={false}
                    onToggle={(visible) =>
                      sub.onChange(visible ? [...sub.hidden, c.id] : sub.hidden.filter((h) => h !== c.id))
                    }
                  />
                ))}
              </div>
            ) : null}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
};

const HideRow = ({
  column,
  visible,
  draggable,
  onToggle,
  sub,
}: {
  column: Column;
  visible: boolean;
  draggable: boolean;
  onToggle: (wasVisible: boolean) => void;
  /** A sub-board column (its own id space — never sortable among the board's columns). */
  sub?: boolean;
}) => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sub ? `sub:${column.id}` : column.id,
    disabled: !draggable,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      className={cn('flex items-center', isDragging && 'relative z-10 rounded bg-surface shadow-md')}
      data-testid={sub ? 'hide-sub-row' : 'hide-row'}
      data-column={column.id}
    >
      {draggable ? (
        <span
          {...attributes}
          {...listeners}
          aria-label={t('toolbar.dragColumn')}
          title={t('toolbar.dragColumn')}
          className="cursor-grab px-1 text-muted active:cursor-grabbing"
        >
          ⠿
        </span>
      ) : null}
      <CheckRow checked={visible} onToggle={() => onToggle(visible)}>
        <span className="truncate">{column.title}</span>
        <span className="ms-auto text-xs text-muted">{columnTypeLabel(column.type)}</span>
      </CheckRow>
    </div>
  );
};
