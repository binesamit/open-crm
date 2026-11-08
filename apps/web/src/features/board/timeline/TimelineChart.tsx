// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  addDays,
  applyDrag,
  type Axis,
  axisEnd,
  axisWidth,
  buildAxis,
  criticalPath,
  type DepLink,
  dragDays,
  type DragEdge,
  durationMode,
  getRegion,
  type KeepDays,
  groupRows,
  isHiddenDay,
  lightDays,
  linksOfValue,
  offsetInAxis,
  dayAt,
  readDateSpan,
  paint,
  readIds,
  type Field,
  type QueryEnv,
  type Span,
  spanBox,
  type TimelineSettings,
  spanOfAll,
  spanToValue,
  t,
  TIMELINE_GROUP,
  TIMELINE_NO_GROUP,
  type ViewSettings,
  workdaysOnlyAxis,
  xOf,
  type Zoom,
  queryColumnOf,
} from '@bines/shared';
import { cn } from '@bines/ui';
import { type BoardDetail, type Item, type Member, useBoard, useBoardMutations, useItems } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { groupColor } from '../table/BoardTable';
import { safeField } from '../toolbar/filter-model';
import { useOpenItem } from '../open-item';
import { calendarColumns } from '../views/CalendarView';
import { useUndoToast } from '../../../lib/undo';
import { Icon } from '../../../lib/icons';
import { AxisBackground, AxisControls, AxisHeader, axisHeaderHeight, dirOf, holidayRuns, skipMarks } from './TimeAxis';
import { gapFill, showsDuration, spanDuration } from '../day-text';

/**
 * Timeline and Gantt views (M8 ד6–ד7, D25) on the shared time axis: items as bars by a date / timeline column,
 * rows grouped by board group / a people or status column / nothing, zoom day…year, today marker, the account's
 * weekend shaded. Dragging a bar moves it, dragging its edge resizes it (writes the column; Ctrl+Z / the toast undo
 * it — with every dependent a dependency moved along). The Gantt adds the item tree with subitems under their
 * parents, dependency arrows, milestones (one-day dates) and the optional critical path.
 */

const ROW_PX = 36;
const SECTION_PX = 34;
const BAR_PX = 22;
/** Prev / next move the axis by this many days at each zoom. */
const STEP_DAYS: Record<Zoom, number> = { day: 14, week: 56, month: 180, quarter: 365, year: 730 };

type Row =
  | { kind: 'section'; key: string; title: string; color: string; count: number; span: Span | null }
  | {
      kind: 'item';
      key: string;
      item: Item;
      depth: number;
      sub: boolean;
      span: Span | null;
      color: string;
      hasChildren: boolean;
      open: boolean;
    };

type Label = { id: number; color?: string };

/** Date / timeline columns of a board, the timeline first (a range draws a real bar). */
const datedColumns = (board: BoardDetail, env: QueryEnv) => {
  const list = calendarColumns(board, env);
  return [...list.filter((c) => c.type === 'timeline'), ...list.filter((c) => c.type !== 'timeline')];
};

/** Columns a timeline can group by: people, status, dropdown. */
export const timelineGroupColumns = (board: BoardDetail, env: QueryEnv) =>
  board.columns.filter((c) => {
    const f = safeField(c.id, env);
    return f?.source === 'column' && (f.model === 'people' || f.model === 'label' || f.model === 'labels');
  });

/** Status / dropdown columns that can colour bars. */
export const colorColumns = (board: BoardDetail, env: QueryEnv) =>
  board.columns.filter((c) => {
    const f = safeField(c.id, env);
    return f?.source === 'column' && (f.model === 'label' || f.model === 'labels');
  });

/** The board's date column a timeline / Gantt uses: the view's choice, else the first timeline, else a date. */
export const timelineDateColumn = (board: BoardDetail, env: QueryEnv, chosen?: string) => {
  const list = datedColumns(board, env);
  return list.find((c) => c.id === chosen) ?? list[0];
};

export const TimelineChart = ({
  variant,
  board,
  items,
  settings,
  env,
  members,
  mutations: m,
  update,
  windowed,
  onRange,
}: {
  variant: 'timeline' | 'gantt';
  board: BoardDetail;
  items: Item[];
  settings: ViewSettings;
  env: QueryEnv;
  members: Member[];
  mutations: ReturnType<typeof useBoardMutations>;
  update: (fn: (s: ViewSettings) => ViewSettings) => void;
  /** A windowed board: the axis follows the navigation (not the items), and `onRange` loads the items shown. */
  windowed?: boolean;
  onRange?: (columnId: string, first: string, last: string) => void;
}) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const gantt = variant === 'gantt';
  const cfg = (gantt ? settings.gantt : settings.timeline) ?? { zoom: 'week' as Zoom };
  const zoom: Zoom = cfg.zoom ?? 'week';
  const column = timelineDateColumn(board, env, cfg.date_column_id);
  const field = column ? safeField(column.id, env) : null;
  const canMove = !!board.capabilities['item.update'];
  const open = useOpenItem(board.id);
  const undoToast = useUndoToast(accountId);

  // Subitems (Gantt): the sub-board, its items and its matching date column (same title and type, else the first).
  const showSubs = gantt && (settings.gantt?.show_subitems ?? true) && !!board.subitems_board_id;
  const subBoard = useBoard(accountId, showSubs ? board.subitems_board_id! : '').data;
  const subItems = useItems(accountId, showSubs ? board.subitems_board_id! : '').data?.data;
  const subMutations = useBoardMutations(accountId, board.subitems_board_id ?? '');
  const subEnv = useMemo<QueryEnv | null>(
    () => (subBoard ? { ...env, columns: subBoard.columns.map(queryColumnOf) } : null),
    [subBoard, env],
  );
  const subColumn = useMemo(() => {
    if (!subBoard || !subEnv || !column) return undefined;
    const list = datedColumns(subBoard, subEnv);
    return list.find((c) => c.type === column.type && c.title === column.title) ?? list[0];
  }, [subBoard, subEnv, column]);
  const subField = subColumn && subEnv ? safeField(subColumn.id, subEnv) : null;
  const children = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of subItems ?? []) {
      if (!it.parent_item_id) continue;
      map.set(it.parent_item_id, [...(map.get(it.parent_item_id) ?? []), it]);
    }
    for (const list of map.values()) list.sort((a, b) => (a.position < b.position ? -1 : 1));
    return map;
  }, [subItems]);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const spanOf = useCallback(
    (it: Item, f: Field | null): Span | null => {
      if (!f) return null;
      const s = readDateSpan(it, f, env.timezone);
      return s?.from && s.to ? { from: s.from, to: s.to } : null;
    },
    [env.timezone],
  );

  // Colours: the chosen label column, else the item's board group.
  const colorField = cfg.color_by ? safeField(cfg.color_by, env) : null;
  const groupColors = useMemo(() => new Map(board.groups.map((g) => [g.id, groupColor(g)])), [board.groups]);
  const colorOf = useCallback(
    (it: Item, fallback: string) => {
      if (colorField?.source === 'column') {
        const id = readIds(it, colorField)[0];
        const labels = (colorField.settings.labels ?? []) as Label[];
        const c = labels.find((l) => String(l.id) === id)?.color;
        if (c) return paint(c);
      }
      return (it.group_id && groupColors.get(it.group_id)) || fallback;
    },
    [colorField, groupColors],
  );

  // Pending drags: the bar stays where it was dropped until the server answers.
  const [pending, setPending] = useState<Map<string, Span>>(() => new Map());
  const effectiveSpan = useCallback(
    (it: Item, f: Field | null) => pending.get(it.id) ?? spanOf(it, f),
    [pending, spanOf],
  );

  // Sections → rows.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const groupBy = cfg.group_by ?? TIMELINE_GROUP;
    let sections: { key: string; title: string; color: string; items: Item[] }[];
    if (groupBy === TIMELINE_NO_GROUP) sections = [{ key: '__all__', title: '', color: '', items }];
    else if (groupBy === TIMELINE_GROUP || !safeField(groupBy, env)) {
      sections = board.groups.map((g) => ({
        key: g.id,
        title: g.title,
        color: groupColor(g),
        items: items.filter((i) => i.group_id === g.id),
      }));
    } else {
      const f = safeField(groupBy, env)!;
      const names = new Map(members.map((mb) => [mb.user_id, mb.name || mb.email] as const));
      sections = groupRows(items, f, {
        timezone: env.timezone,
        nameOf: (id) => names.get(id),
        emptyLabel: t('group.empty'),
        checkedLabel: t('group.checked'),
      }).map((b, i) => ({
        key: `${groupBy}:${b.key}`,
        title: b.label,
        color: paint(b.color) ?? (b.key === '__empty__' ? 'var(--status-empty)' : groupColorAt(board, i)),
        items: b.rows,
      }));
    }
    for (const s of sections) {
      if (!s.items.length) continue;
      if (groupBy !== TIMELINE_NO_GROUP)
        out.push({
          kind: 'section',
          key: s.key,
          title: s.title,
          color: s.color,
          count: s.items.length,
          span: spanOfAll(s.items.map((i) => effectiveSpan(i, field))),
        });
      if (collapsed.has(s.key)) continue;
      for (const it of s.items) {
        const kids = showSubs ? (children.get(it.id) ?? []) : [];
        const isOpen = expanded.has(it.id);
        const color = colorOf(it, s.color || 'var(--primary)');
        out.push({
          kind: 'item',
          key: it.id,
          item: it,
          depth: 0,
          sub: false,
          span: effectiveSpan(it, field),
          color,
          hasChildren: kids.length > 0,
          open: isOpen,
        });
        if (isOpen)
          for (const k of kids)
            out.push({
              kind: 'item',
              key: k.id,
              item: k,
              depth: 1,
              sub: true,
              span: effectiveSpan(k, subField),
              color,
              hasChildren: false,
              open: false,
            });
      }
    }
    return out;
  }, [
    cfg.group_by,
    env,
    items,
    board,
    members,
    collapsed,
    showSubs,
    children,
    expanded,
    colorOf,
    effectiveSpan,
    field,
    subField,
  ]);

  // The axis: around the items (or, on a windowed board, around the navigation anchor).
  const [anchor, setAnchor] = useState(env.today);
  const itemsRange = useMemo(
    () => (windowed ? null : spanOfAll(rows.map((r) => (r.kind === 'item' ? r.span : null)))),
    [windowed, rows],
  );
  // Prod "working days only": the axis leaves out the days that count 0 in working days (the account's
  // calendar and weekend, through the shared engine); every position, drag and arrow goes through its columns.
  const workdaysOnly = !!cfg.working_days_only;
  const axis: Axis = useMemo(() => {
    const range = spanOfAll([itemsRange, { from: anchor, to: anchor }]);
    const plain = buildAxis(zoom, range, env.today, env.firstDay);
    if (!workdaysOnly) return plain;
    const region = getRegion();
    return workdaysOnlyAxis(plain, region.calendar, region.weekend);
  }, [zoom, itemsRange, anchor, env.today, env.firstDay, workdaysOnly]);
  // Holidays on the axis: shaded behind the rows and named in a band under the header.
  const runs = useMemo(() => holidayRuns(axis), [axis]);
  const skips = useMemo(() => skipMarks(axis, env.weekend), [axis, env.weekend]);
  const headerHeight = axisHeaderHeight(runs);
  const first = axis.start;
  const last = axisEnd(axis);
  const columnId = column?.id;
  useEffect(() => {
    if (onRange && columnId) onRange(columnId, first, last);
  }, [onRange, columnId, first, last]);

  // Scroll the anchor (today at first) into view whenever it or the zoom changes.
  const scrollRef = useRef<HTMLDivElement>(null);
  const markRef = useRef<HTMLDivElement>(null);
  const [dir, setDir] = useState<'rtl' | 'ltr'>('rtl');
  useLayoutEffect(() => {
    setDir(dirOf(scrollRef.current));
  }, []);
  useEffect(() => {
    markRef.current?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
  }, [anchor, zoom, first]);

  const setZoom = (z: Zoom) =>
    update((s) =>
      gantt
        ? { ...s, gantt: { show_subitems: true, show_critical: false, ...s.gantt, zoom: z } }
        : { ...s, timeline: { ...s.timeline, zoom: z } },
    );

  // Dependencies (Gantt): the chosen column, else the board's first dependency column.
  const depColumn = gantt
    ? (board.columns.find((c) => c.id === settings.gantt?.dependency_column_id && c.type === 'dependency') ??
      board.columns.find((c) => c.type === 'dependency'))
    : undefined;
  const links = useMemo<DepLink[]>(
    () => (depColumn ? items.flatMap((it) => linksOfValue(it.id, it.cells[depColumn.id]?.value)) : []),
    [depColumn, items],
  );
  const critical = useMemo(() => {
    if (!gantt || !settings.gantt?.show_critical || !links.length) return null;
    const spans = new Map<string, Span>();
    for (const r of rows) if (r.kind === 'item' && !r.sub && r.span) spans.set(r.item.id, r.span);
    return criticalPath(spans, links);
  }, [gantt, settings.gantt?.show_critical, links, rows]);

  // Layout: each row's top (arrows need the centres).
  const layout = useMemo(() => {
    let y = 0;
    const tops = new Map<string, number>();
    for (const r of rows) {
      tops.set(r.key, y);
      y += r.kind === 'section' ? SECTION_PX : ROW_PX;
    }
    return { tops, height: y };
  }, [rows]);

  // Dragging a bar: whole bar or an edge, in whole days; a click without movement opens the item.
  const [drag, setDrag] = useState<{ id: string; edge: DragEdge; x: number; delta: number; moved: boolean } | null>(
    null,
  );
  /** A timeline column that keeps its working days on a move: the mode and calendar to count in. */
  const keepOf = (row: Extract<Row, { kind: 'item' }>): KeepDays | null => {
    const s = ((row.sub ? subColumn : column)?.settings ?? {}) as TimelineSettings;
    return s.keep_workdays
      ? { mode: durationMode(s.duration), calendar: getRegion().calendar, weekend: env.weekend }
      : null;
  };
  const commit = (row: Extract<Row, { kind: 'item' }>, edge: DragEdge, delta: number) => {
    const col = row.sub ? subColumn : column;
    if (!row.span || !col) return;
    const next = applyDrag(row.span, delta, edge, keepOf(row), axis);
    if (next.from === row.span.from && next.to === row.span.to) return;
    const value = spanToValue(col.type, next, row.item.cells[col.id]?.value);
    setPending((p) => new Map(p).set(row.item.id, next));
    const mm = row.sub ? subMutations : m;
    mm.setCell.mutate(
      { itemId: row.item.id, columnId: col.id, value },
      {
        onSuccess: (res) => {
          if (res.event_id) undoToast(t('timeline.moved', { name: row.item.name }), res.event_id);
        },
        onSettled: () =>
          setPending((p) => {
            const n = new Map(p);
            n.delete(row.item.id);
            return n;
          }),
      },
    );
  };
  /** A click on an empty row's track gives the item that day (a timeline: one day). */
  const setDateAt = (row: Extract<Row, { kind: 'item' }>, day: string) => {
    const col = row.sub ? subColumn : column;
    if (!col || row.span) return;
    const mm = row.sub ? subMutations : m;
    mm.setCell.mutate({
      itemId: row.item.id,
      columnId: col.id,
      value: spanToValue(col.type, { from: day, to: day }, null),
    });
  };

  if (!column || !field)
    return (
      <p className="py-16 text-center text-sm text-muted" data-testid="timeline-no-column">
        {t('timeline.noColumn')}
      </p>
    );

  const width = axisWidth(axis);
  const nameWidth = gantt ? 260 : 200;
  const resizable = column.type === 'timeline';
  const shownBar = (r: Extract<Row, { kind: 'item' }>) =>
    drag && drag.id === r.item.id && r.span ? applyDrag(r.span, drag.delta, drag.edge, keepOf(r), axis) : r.span;
  /** A timeline's counted length on its bar: in the label when asked, else in the tooltip. */
  const durationOf = (r: Extract<Row, { kind: 'item' }>, span: Span) => {
    const col = r.sub ? subColumn : column;
    if (col?.type !== 'timeline') return null;
    const s = col.settings as TimelineSettings;
    if (!showsDuration(s)) return null;
    return { text: spanDuration(span.from, span.to, s).text, inLabel: !!s.show_duration };
  };
  /**
   * The days of a working-day bar that count less than one: a weekend / day off is a hatched hole
   * a half day a lighter slice. Only a timeline column counting in a non-calendar mode, when a day is wide enough
   * to see; a day the collapsed axis leaves out has no column to mark.
   */
  const gapsOf = (r: Extract<Row, { kind: 'item' }>, span: Span): BarGap[] => {
    const col = r.sub ? subColumn : column;
    if (col?.type !== 'timeline' || axis.pxPerDay < 5) return [];
    const mode = durationMode((col.settings as TimelineSettings).duration);
    if (mode === 'calendar') return [];
    const region = getRegion();
    const start = spanBox(axis, span).start;
    return lightDays(span, mode, region.calendar, region.weekend, 400)
      .filter((d) => !isHiddenDay(axis, d.day))
      .map((d) => ({ day: d.day, weight: d.weight, offset: xOf(axis, d.day) - start }));
  };

  return (
    <div className="flex min-w-0 flex-col" data-testid="timeline" data-variant={variant} data-zoom={zoom}>
      <AxisControls
        zoom={zoom}
        onZoom={setZoom}
        onPrev={() => setAnchor((a) => addDays(a, -STEP_DAYS[zoom]))}
        onNext={() => setAnchor((a) => addDays(a, STEP_DAYS[zoom]))}
        onToday={() => {
          setAnchor(env.today);
          markRef.current?.scrollIntoView?.({ inline: 'center', block: 'nearest' });
        }}
      >
        {gantt && links.length ? (
          <button
            type="button"
            aria-pressed={!!settings.gantt?.show_critical}
            data-testid="gantt-critical"
            onClick={() =>
              update((s) => ({
                ...s,
                gantt: { zoom, show_subitems: true, ...s.gantt, show_critical: !s.gantt?.show_critical },
              }))
            }
            className={cn(
              'h-8 rounded-[10px] border px-2.5 text-sm',
              settings.gantt?.show_critical
                ? 'border-danger bg-[color-mix(in_srgb,var(--danger)_10%,var(--surface))] text-danger-fg'
                : 'border-line-strong bg-surface text-heading hover:bg-surface-2',
            )}
          >
            {t('gantt.critical')}
          </button>
        ) : null}
      </AxisControls>
      <div
        ref={scrollRef}
        className="relative max-h-[calc(100vh-250px)] min-h-[240px] overflow-auto rounded-[14px] border border-line bg-surface"
        data-testid="timeline-scroll"
      >
        <div className="relative" style={{ width: nameWidth + width }}>
          {/* Header: the corner (sticky both ways) and the axis. */}
          <div className="sticky top-0 z-20 flex" style={{ height: headerHeight }}>
            <div
              className="sticky start-0 z-10 flex shrink-0 items-end border-e border-b border-line bg-surface-3 px-3 pb-1.5 text-xs font-semibold text-muted"
              style={{ width: nameWidth }}
            >
              {gantt ? t('gantt.items') : column.title}
            </div>
            <div className="relative border-b border-line">
              <AxisHeader axis={axis} today={env.today} runs={runs} skips={skips} />
              <div
                ref={markRef}
                className="absolute top-0 h-px w-px"
                style={{
                  insetInlineStart: Math.max(0, Math.min(width - 1, xOf(axis, anchor) + axis.pxPerDay / 2)),
                }}
              />
            </div>
          </div>
          <div className="relative" style={{ height: Math.max(layout.height, ROW_PX * 3) }}>
            <div className="absolute top-0" style={{ insetInlineStart: nameWidth }}>
              <AxisBackground
                axis={axis}
                today={env.today}
                weekend={env.weekend}
                height={Math.max(layout.height, ROW_PX * 3)}
                runs={runs}
                skips={skips}
              />
            </div>
            {rows.map((r) =>
              r.kind === 'section' ? (
                <div
                  key={r.key}
                  className="absolute inset-x-0 flex"
                  style={{ top: layout.tops.get(r.key), height: SECTION_PX }}
                  data-testid="timeline-section"
                  data-title={r.title}
                >
                  <button
                    type="button"
                    onClick={() =>
                      setCollapsed((c) => {
                        const n = new Set(c);
                        if (n.has(r.key)) n.delete(r.key);
                        else n.add(r.key);
                        return n;
                      })
                    }
                    className="sticky start-0 z-10 flex shrink-0 items-center gap-2 border-e border-b border-line bg-surface px-3 text-start"
                    style={{ width: nameWidth }}
                    aria-expanded={!collapsed.has(r.key)}
                  >
                    <span className="h-4 w-1.5 shrink-0 rounded-[3px]" style={{ backgroundColor: r.color }} />
                    <span className="truncate font-display text-sm font-extrabold text-fg">{r.title}</span>
                    <span className="ms-auto rounded-full bg-surface-2 px-1.5 text-[0.6875rem] text-muted">
                      {r.count}
                    </span>
                  </button>
                  <div className="relative border-b border-line-soft" style={{ width }}>
                    {r.span ? (
                      <div
                        className="absolute top-[14px] h-1.5 rounded-full opacity-60"
                        style={{
                          ...boxStyle(axis, r.span),
                          backgroundColor: r.color,
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              ) : (
                <div
                  key={r.key}
                  className="group/row absolute inset-x-0 flex"
                  style={{ top: layout.tops.get(r.key), height: ROW_PX }}
                  data-testid="timeline-row"
                  data-item-name={r.item.name}
                  data-depth={r.depth}
                >
                  <div
                    className="sticky start-0 z-10 flex shrink-0 items-center gap-1 border-e border-b border-line-soft bg-surface px-2 text-sm group-hover/row:bg-surface-3"
                    style={{ width: nameWidth, paddingInlineStart: 8 + r.depth * 18 }}
                  >
                    {gantt && !r.sub ? (
                      r.hasChildren ? (
                        <button
                          type="button"
                          data-testid="gantt-toggle"
                          aria-expanded={r.open}
                          aria-label={t('gantt.subitems')}
                          onClick={() =>
                            setExpanded((e) => {
                              const n = new Set(e);
                              if (n.has(r.item.id)) n.delete(r.item.id);
                              else n.add(r.item.id);
                              return n;
                            })
                          }
                          className="grid size-5 shrink-0 place-items-center rounded text-muted hover:bg-surface-2"
                        >
                          <Icon name={r.open ? 'chevronDown' : 'chevronStart'} size={13} />
                        </button>
                      ) : (
                        <span className="w-5 shrink-0" />
                      )
                    ) : null}
                    <button
                      type="button"
                      className="min-w-0 truncate text-start hover:text-primary hover:underline"
                      onClick={() => open(r.item.id)}
                    >
                      {r.item.name}
                    </button>
                  </div>
                  <div
                    className="relative border-b border-line-soft"
                    style={{ width }}
                    onClick={(e) => {
                      if (!canMove || r.span || e.target !== e.currentTarget) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      setDateAt(r, dayAt(axis, offsetInAxis(e.clientX, rect, dirOf(e.currentTarget))));
                    }}
                    data-tip={!r.span && canMove ? t('timeline.setDate') : undefined}
                  >
                    {r.span ? (
                      <Bar
                        row={r}
                        span={shownBar(r)!}
                        duration={durationOf(r, shownBar(r)!)}
                        gaps={gapsOf(r, shownBar(r)!)}
                        axis={axis}
                        milestone={gantt && column.type === 'date'}
                        resizable={resizable && canMove}
                        canMove={canMove}
                        critical={!!critical?.has(r.item.id)}
                        dragging={drag?.id === r.item.id && drag.moved}
                        onDown={(edge, x) => setDrag({ id: r.item.id, edge, x, delta: 0, moved: false })}
                        onMove={(x, el) =>
                          setDrag((d) =>
                            d && d.id === r.item.id
                              ? {
                                  ...d,
                                  delta: dragDays(x - d.x, axis.pxPerDay, dirOf(el)),
                                  moved: d.moved || Math.abs(x - d.x) > 3,
                                }
                              : d,
                          )
                        }
                        onUp={() => {
                          const d = drag;
                          setDrag(null);
                          if (!d || d.id !== r.item.id) return;
                          if (!d.moved) open(r.item.id);
                          else if (d.delta) commit(r, d.edge, d.delta);
                        }}
                      />
                    ) : null}
                  </div>
                </div>
              ),
            )}
            {gantt && links.length ? (
              <Arrows
                axis={axis}
                dir={dir}
                links={links}
                rows={rows}
                tops={layout.tops}
                offset={nameWidth}
                height={layout.height}
                critical={critical}
              />
            ) : null}
            {!rows.length ? (
              <p className="absolute inset-x-0 top-10 text-center text-sm text-muted">{t('filter.noResults')}</p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

const groupColorAt = (board: BoardDetail, i: number) =>
  board.groups.length ? groupColor(board.groups[i % board.groups.length]!) : 'var(--primary)';

const boxStyle = (axis: Axis, span: Span) => {
  const box = spanBox(axis, span);
  return { insetInlineStart: box.start, width: box.width };
};

/** A day of a bar that counts less than one: where it sits from the bar's inline start. */
type BarGap = { day: string; weight: number; offset: number };

const Bar = ({
  row,
  span,
  duration,
  gaps = [],
  axis,
  milestone,
  resizable,
  canMove,
  critical,
  dragging,
  onDown,
  onMove,
  onUp,
}: {
  row: Extract<Row, { kind: 'item' }>;
  span: Span;
  /** The counted length (a timeline column that shows it): in the label, or only in the tooltip. */
  duration?: { text: string; inLabel: boolean } | null;
  /** Weekends / days off / half days inside a working-day bar: drawn over its fill, the outline stays one. */
  gaps?: BarGap[];
  axis: Axis;
  milestone: boolean;
  resizable: boolean;
  canMove: boolean;
  critical: boolean;
  dragging: boolean;
  onDown: (edge: DragEdge, x: number) => void;
  onMove: (x: number, el: Element) => void;
  onUp: () => void;
}) => {
  const box = spanBox(axis, span);
  const days = Math.round(box.width / axis.pxPerDay);
  const label = `${row.item.name} · ${span.from === span.to ? span.from : `${span.from} – ${span.to}`}${duration ? ` · ${duration.text}` : ''}`;
  const name = duration?.inLabel ? `${row.item.name} · ${duration.text}` : row.item.name;
  const handlers = (edge: DragEdge) => ({
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (!canMove) {
        onDown(edge, e.clientX);
        return;
      }
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      onDown(edge, e.clientX);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (!canMove) return;
      if ((e.currentTarget as Element).hasPointerCapture?.(e.pointerId)) onMove(e.clientX, e.currentTarget as Element);
    },
    onPointerUp: (e: React.PointerEvent) => {
      e.stopPropagation();
      (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
      onUp();
    },
  });
  if (milestone)
    return (
      <div
        role="button"
        tabIndex={0}
        data-testid="timeline-bar"
        data-milestone
        data-item-name={row.item.name}
        data-from={span.from}
        data-to={span.to}
        data-tip={label}
        aria-label={label}
        className={cn(
          'absolute top-[11px] size-[0.875rem] rotate-45 rounded-[3px] shadow-sm',
          canMove ? 'cursor-grab' : 'cursor-pointer',
          critical && 'ring-2 ring-danger',
        )}
        style={{ insetInlineStart: box.start + axis.pxPerDay / 2 - 7, backgroundColor: row.color }}
        {...handlers('move')}
      />
    );
  const inside = box.width >= 60;
  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="timeline-bar"
      data-item-name={row.item.name}
      data-from={span.from}
      data-to={span.to}
      data-critical={critical || undefined}
      data-tip={label}
      aria-label={label}
      className={cn(
        'absolute flex items-center rounded-[7px] text-[0.75rem] font-normal shadow-sm select-none',
        canMove ? 'cursor-grab' : 'cursor-pointer',
        dragging && 'z-10 cursor-grabbing opacity-90 shadow-[var(--shadow-pop)]',
        critical && 'ring-2 ring-danger ring-offset-1',
        row.sub && 'opacity-85',
      )}
      style={{
        top: (ROW_PX - BAR_PX) / 2,
        height: BAR_PX,
        insetInlineStart: box.start,
        width: box.width,
        backgroundColor: row.color,
        color: 'var(--on-c)',
        touchAction: 'none',
      }}
      {...handlers('move')}
      data-days={days}
    >
      {gaps.length ? (
        <span aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-[7px]">
          {gaps.map((g) => (
            <span
              key={g.day}
              data-testid="bar-gap"
              data-day={g.day}
              data-weight={g.weight}
              className="absolute inset-y-0"
              style={{ insetInlineStart: g.offset, width: axis.pxPerDay, ...gapFill(row.color, g.weight) }}
            />
          ))}
        </span>
      ) : null}
      {inside ? <span className="pointer-events-none relative truncate px-2">{name}</span> : null}
      {!inside ? (
        <span
          className="pointer-events-none absolute start-full ms-1.5 truncate whitespace-nowrap text-fg-2"
          style={{ color: 'var(--fg-2)' }}
        >
          {name}
        </span>
      ) : null}
      {resizable ? (
        <>
          <span
            data-edge="start"
            className="absolute inset-y-0 start-0 w-2 cursor-ew-resize rounded-s-[7px] hover:bg-black/15"
            {...handlers('start')}
          />
          <span
            data-edge="end"
            className="absolute inset-y-0 end-0 w-2 cursor-ew-resize rounded-e-[7px] hover:bg-black/15"
            {...handlers('end')}
          />
        </>
      ) : null}
    </div>
  );
};

/**
 * Dependency arrows (an SVG over the tracks). Positions are logical (from the inline start); SVG coordinates are
 * physical, so in RTL x = width − logical x. FS: predecessor end → dependent start; SS: start → start; FF: end →
 * end; SF: start → end.
 */
const Arrows = ({
  axis,
  dir,
  links,
  rows,
  tops,
  offset,
  height,
  critical,
}: {
  axis: Axis;
  dir: 'rtl' | 'ltr';
  links: DepLink[];
  rows: Row[];
  tops: Map<string, number>;
  offset: number;
  height: number;
  critical: Set<string> | null;
}) => {
  const width = axisWidth(axis);
  const spans = new Map(
    rows.flatMap((r) => (r.kind === 'item' && r.span ? [[r.item.id, spanBox(axis, r.span)] as const] : [])),
  );
  const px = (x: number) => (dir === 'rtl' ? width - x : x);
  const paths = links.flatMap((l) => {
    const a = spans.get(l.on);
    const b = spans.get(l.item);
    const ya = tops.get(l.on);
    const yb = tops.get(l.item);
    if (!a || !b || ya === undefined || yb === undefined) return [];
    const fromEnd = l.kind === 'FS' || l.kind === 'FF';
    const toStart = l.kind === 'FS' || l.kind === 'SS';
    const x1 = fromEnd ? a.start + a.width : a.start;
    const x2 = toStart ? b.start : b.start + b.width;
    const y1 = ya + ROW_PX / 2;
    const y2 = yb + ROW_PX / 2;
    const out1 = x1 + (fromEnd ? 8 : -8);
    const in2 = x2 + (toStart ? -8 : 8);
    const mid = y2 > y1 ? yb : yb + ROW_PX;
    const points: [number, number][] =
      (toStart ? out1 <= in2 : out1 >= in2) && y1 !== y2
        ? [
            [x1, y1],
            [out1, y1],
            [out1, y2],
            [x2, y2],
          ]
        : [
            [x1, y1],
            [out1, y1],
            [out1, mid],
            [in2, mid],
            [in2, y2],
            [x2, y2],
          ];
    const d = points.map(([x, y], i) => `${i ? 'L' : 'M'}${px(x)},${y}`).join(' ');
    const hot = !!critical?.has(l.on) && !!critical?.has(l.item);
    return [{ key: `${l.item}:${l.on}`, d, hot }];
  });
  return (
    <svg
      className="pointer-events-none absolute top-0 z-[5] overflow-visible"
      style={{ insetInlineStart: offset, width, height }}
      width={width}
      height={height}
      data-testid="gantt-arrows"
      aria-hidden
    >
      <defs>
        <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--fg-2)" />
        </marker>
        <marker id="gantt-arrow-hot" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" />
        </marker>
      </defs>
      {paths.map((p) => (
        <path
          key={p.key}
          d={p.d}
          data-testid="gantt-arrow"
          data-link={p.key}
          fill="none"
          stroke={p.hot ? 'var(--danger)' : 'var(--fg-2)'}
          strokeWidth={1.5}
          markerEnd={`url(#${p.hot ? 'gantt-arrow-hot' : 'gantt-arrow'})`}
        />
      ))}
    </svg>
  );
};
