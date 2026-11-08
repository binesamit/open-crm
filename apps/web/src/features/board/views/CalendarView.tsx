// SPDX-License-Identifier: AGPL-3.0-only
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Icon } from '../../../lib/icons';
import {
  addDays,
  allDayCells,
  applyDrag,
  calendarRangeDays,
  calendarSettingsOf,
  calendarStep,
  dayBars,
  dayMarkName,
  durationMode,
  formatDayMonth,
  formatHebrew,
  formatHebrewMonths,
  formatLongDay,
  formatMonthYear,
  getRegion,
  isWeekend,
  monthGrid,
  parseIso,
  readDateSpan,
  readIds,
  readTimedSpan,
  regionDay,
  shiftMonth,
  showDayMarks,
  showHebrewDates,
  t,
  timedCells,
  weekdayName,
  type CalendarMode,
  type CalendarTimeConfig,
  type CalendarViewSettings,
  type Field,
  type IsoDate,
  type QueryEnv,
  type TimelineSettings,
  type ViewSettings,
} from '@bines/shared';
import { Button, cn, DayDot, dayDotState } from '@bines/ui';
import { errorMessage } from '../../../lib/api';
import { showToast } from '../../../lib/toast';
import { useUndoToast } from '../../../lib/undo';
import { tagVars } from '../../../lib/label-color';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { type BoardDetail, type Column, type Item, type useBoardMutations, useMembers } from '../board-api';
import { safeField } from '../toolbar/filter-model';
import { useOpenItem } from '../open-item';
import { useDesktop } from '../../../lib/use-desktop';
import { CalendarPhone } from './CalendarPhone';
import { CalendarDayPanel } from './CalendarDayPanel';
import { CalendarQuickCard, quickCardFields } from './CalendarQuickCard';
import { CalendarTimeGrid, clockOf, clockRange } from './CalendarTimeGrid';
import { CalendarItemMenu, colorLabels } from './CalendarItemMenu';
import { Popover } from '../cells/Popover';
import { BoardAccountContext } from '../board-context';

/** Lanes a day of the month shows (bars and items); more = "+N". */
const MONTH_LANES = 4;

/** Date and timeline columns a calendar can use (11-UI §4). */
export const calendarColumns = (board: BoardDetail, env: QueryEnv) =>
  board.columns.filter((c) => {
    const f = safeField(c.id, env);
    return f?.source === 'column' && f.model === 'date' && f.def.storage === 'cell';
  });

/** Hour columns (a date's start and end time). */
export const hourColumns = (board: BoardDetail) => board.columns.filter((c) => c.type === 'hour');

const daysBetween = (a: string, b: string) => {
  const pa = parseIso(a);
  const pb = parseIso(b);
  return Math.round((Date.UTC(pb.year, pb.month, pb.day) - Date.UTC(pa.year, pa.month, pa.day)) / 86_400_000);
};

type Label = { id: number; color?: string };

/**
 * Where the view reads hours: a timeline "with hours", or a date with start / end hour columns (a
 * date's own time counts as the start). A timeline source on a date column reads the date's own time.
 */
export const calendarTimeConfig = (column: Column, cal: CalendarViewSettings): CalendarTimeConfig => ({
  source: cal.time_source === 'timeline' && column.type === 'timeline' ? 'timeline' : 'date_hours',
  dateColumnId: column.id,
  startColumnId: cal.time_source === 'date_hours' ? (cal.start_hour_column_id ?? null) : null,
  endColumnId: cal.time_source === 'date_hours' ? (cal.end_hour_column_id ?? null) : null,
  defaultDuration: cal.default_duration,
});

/** The title of the days on screen: "נובמבר 2026", "1–7 בנובמבר 2026", "יום שלישי, 3 בנובמבר". */
const rangeTitle = (mode: CalendarMode, days: IsoDate[], anchor: IsoDate) => {
  const p = parseIso(anchor);
  if (mode === 'month') return formatMonthYear(p.year, p.month);
  if (mode === 'day') return formatLongDay(anchor);
  const a = parseIso(days[0]!);
  const b = parseIso(days.at(-1)!);
  if (a.year === b.year && a.month === b.month) return `${a.day}–${b.day} ${formatMonthYear(a.year, a.month)}`;
  return `${formatDayMonth(days[0]!, { year: false })} – ${formatDayMonth(days.at(-1)!, { year: a.year !== b.year })} ${b.year}`;
};

/**
 * Calendar (11-UI §4): items on the days of a date / timeline column — a month, a week, and with the view's "by
 * the hour" also a day, three days and a work week laid out in hours. Items over several days run as
 * one bar across them. Dragging an item moves its date (a timeline keeps its length); in hours also its time.
 */
export const CalendarView = ({
  board,
  items,
  settings,
  env,
  mutations: m,
  onRange,
  update,
}: {
  board: BoardDetail;
  items: Item[];
  settings: ViewSettings;
  env: QueryEnv;
  mutations: ReturnType<typeof useBoardMutations>;
  /**
   * A windowed board (perf review §7.1): the date column and the days on screen, whenever they change — the page
   * then loads the items of that range only.
   */
  onRange?: (columnId: string, first: string, last: string) => void;
  /** The view's settings (a draft until saved): the column an empty day's panel picks. */
  update?: (fn: (s: ViewSettings) => ViewSettings) => void;
}) => {
  const account = useContext(BoardAccountContext);
  const members = useMembers(account.id).data?.data ?? [];
  const cal = useMemo(() => calendarSettingsOf(settings.calendar), [settings.calendar]);
  const choices = calendarColumns(board, env);
  const column = choices.find((c) => c.id === cal.date_column_id) ?? choices[0];
  const field = column ? safeField(column.id, env) : null;
  const colorField = useMemo(() => {
    const id = cal.color_by ?? board.columns.find((c) => safeField(c.id, env)?.model === 'label')?.id;
    return id ? safeField(id, env) : null;
  }, [cal.color_by, board.columns, env]);
  const undoToast = useUndoToast(account.id);
  const openItem = useOpenItem(board.id);

  const hours = cal.show_hours;
  const modes: CalendarMode[] = hours ? ['day', '3day', 'week', 'workweek', 'month'] : ['week', 'month'];
  const [chosenMode, setMode] = useState<CalendarMode>(cal.default);
  // A range that needs hours falls back to the month when the view turns them off.
  const mode: CalendarMode = modes.includes(chosenMode) ? chosenMode : 'month';
  const [anchor, setAnchor] = useState(env.today);
  // N8: phones show a compact month with dots and the chosen day's items (today until a day is tapped); with
  // hours, a day by the hour (canvas board 5).
  const desktop = useDesktop();
  const [phoneMode, setPhoneMode] = useState<'day' | 'month'>('day');
  const [selected, setSelected] = useState(env.today);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  // an empty spot of a day pressed (and dragged across days): the days, then the panel on release.
  const [sel, setSel] = useState<{ start: string; end: string; open: boolean } | null>(null);
  useEffect(() => {
    if (!sel || sel.open) return;
    const up = () => setSel((x) => (x ? { ...x, open: true } : x));
    window.addEventListener('pointerup', up, { once: true });
    return () => window.removeEventListener('pointerup', up);
  }, [sel]);
  // Hours: the stretch being made into an item, and the item whose quick card is open.
  const [pending, setPending] = useState<{ day: IsoDate; start: number; end: number } | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  // the item whose menu is open (right click …); `at` null = closed, its dialogs may stay.
  const [menuFor, setMenuFor] = useState<{ item: Item; at: { x: number; y: number } | null } | null>(null);
  const openMenu = (item: Item, at: { x: number; y: number }) => setMenuFor({ item, at });

  const timeMode = hours && mode !== 'month';
  const phoneHours = !desktop && hours && phoneMode === 'day';
  // Phones without the day by the hour: the month (or the week) of dots, as before.
  const shownMode: CalendarMode = desktop ? mode : phoneHours ? 'day' : mode === 'week' && !hours ? 'week' : 'month';
  const days = phoneHours
    ? [{ iso: selected, inMonth: true }]
    : shownMode === 'month'
      ? monthGrid(parseIso(anchor).year, parseIso(anchor).month, env.firstDay)
      : // Without hours a week stays seven days (a month's row).
        calendarRangeDays(shownMode, anchor, env, cal.show_weekends || !hours).map((iso) => ({ iso, inMonth: true }));

  const rangeFirst = days[0]!.iso;
  const rangeLast = days.at(-1)!.iso;
  const columnId = column?.id;
  useEffect(() => {
    if (onRange && columnId) onRange(columnId, rangeFirst, rangeLast);
  }, [onRange, columnId, rangeFirst, rangeLast]);

  const byDay = new Map<string, Item[]>();
  if (field) {
    const first = days[0]!.iso;
    const last = days.at(-1)!.iso;
    for (const it of items) {
      const span = readDateSpan(it, field, env.timezone);
      if (!span || span.to! < first || span.from! > last) continue;
      for (let d = span.from! < first ? first : span.from!; d <= span.to! && d <= last; d = addDays(d, 1)) {
        byDay.set(d, [...(byDay.get(d) ?? []), it]);
      }
    }
  }

  // A bar over several days moves by the day it was grabbed on (dnd-kit knows only the bar).
  const grabDay = useRef<string | null>(null);

  if (!column || !field)
    return (
      <NoDateColumn
        canAdd={!!board.capabilities['column.create']}
        add={async (type) => {
          const c = await m.createColumn.mutateAsync({ title: t(`calendar.addColumn.title.${type}`), type });
          update?.((s) => ({ ...s, calendar: { ...calendarSettingsOf(s.calendar), date_column_id: c.id } }));
        }}
      />
    );

  const cfg = calendarTimeConfig(column, cal);
  const region = getRegion();

  /** The chip's fill: the item's label colour; none (no colour column, empty label) = a neutral chip. */
  const colorOf = (it: Item): string | null => {
    if (!colorField || colorField.source !== 'column') return null;
    const id = readIds(it, colorField)[0];
    const labels = (colorField.settings.labels ?? []) as Label[];
    return labels.find((l) => String(l.id) === id)?.color ?? null;
  };

  /** One write for a gesture (date and hours together), with "undo" in its toast. */
  const write = (item: Item, cells: Record<string, unknown>, message: string) => {
    m.setCells
      .mutateAsync({ itemId: item.id, cells })
      .then((res) => (res.event_id ? undoToast(message, res.event_id) : undefined))
      .catch((err: unknown) => showToast({ message: errorMessage(err), tone: 'error' }));
  };
  /** An all-day item (or the days of a timeline) moved by whole days — a timeline keeps its length. */
  const moveDays = (item: Item, delta: number) => {
    const value = item.cells[column.id]?.value as { date?: string; from?: string; to?: string } | undefined;
    if (!value || !delta) return;
    // A timeline that keeps its working days re-counts its end from the new start.
    const ts = column.settings as TimelineSettings;
    const keep = ts.keep_workdays
      ? { mode: durationMode(ts.duration), calendar: region.calendar, weekend: env.weekend }
      : null;
    const next = value.from
      ? { ...value, ...applyDrag({ from: value.from, to: value.to! }, delta, 'move', keep) }
      : { ...value, date: addDays(value.date!, delta) };
    const first = 'from' in next && next.from ? next.from : (next as { date: string }).date;
    write(item, { [column.id]: next }, t('calendar.moved', { name: item.name, when: formatLongDay(first) }));
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const [itemId, from] = String(active.id).split('|') as [string, string];
    // A bar over several days moves by the day it was grabbed on.
    const grabbed = grabDay.current ?? from;
    grabDay.current = null;
    const delta = daysBetween(grabbed, String(over.id));
    const item = items.find((i) => i.id === itemId);
    if (item && delta) moveDays(item, delta);
  };

  // what an empty day offers — a new item (needs item.create), a date for an existing one (the column
  // must be editable), both, or nothing.
  const writable = !!board.capabilities['item.update'] && !column.read_only && !column.restricted_edit;
  const wanted = cal.empty_click;
  const canNew = !!board.capabilities['item.create'] && !column.restricted_edit && !column.read_only;
  const offer =
    wanted === 'off'
      ? null
      : wanted === 'new'
        ? canNew
          ? 'new'
          : null
        : wanted === 'existing'
          ? writable
            ? 'existing'
            : null
          : canNew && writable
            ? 'both'
            : canNew
              ? 'new'
              : writable
                ? 'existing'
                : null;
  const selFrom = sel ? (sel.start < sel.end ? sel.start : sel.end) : null;
  const selTo = sel ? (sel.start < sel.end ? sel.end : sel.start) : null;
  const pressDay = (iso: string, e: ReactPointerEvent) => {
    // Only the day's own empty space (not an item, a button or "+N more"); the main button.
    // The panel sits in a portal: its own clicks reach the day through React, never as a new press.
    if (!offer || e.button !== 0 || !e.currentTarget.contains(e.target as Node)) return;
    if ((e.target as HTMLElement).closest('button,[data-testid="calendar-item"]')) return;
    e.preventDefault();
    setSel({ start: iso, end: iso, open: false });
  };
  const enterDay = (iso: string) => setSel((x) => (x && !x.open ? { ...x, end: iso } : x));
  const pickColumn = (id: string) =>
    update?.((s) => ({ ...s, calendar: { ...calendarSettingsOf(s.calendar), date_column_id: id } }));
  // One panel at a time, anchored to the day the press ended on.
  const panelDay = sel?.open && selFrom && selTo && offer ? sel.end : null;
  const dayPanel =
    panelDay && selFrom && selTo && offer ? (
      <Popover open onClose={() => setSel(null)} className="p-3">
        <CalendarDayPanel
          accountId={account.id}
          board={board}
          column={column}
          choices={choices}
          askColumn={!cal.date_column_id && !!update}
          from={selFrom}
          to={selTo}
          firstDay={env.firstDay}
          offer={offer}
          mutations={m}
          onPickColumn={pickColumn}
          onDone={() => setSel(null)}
        />
      </Popover>
    ) : null;
  // Hours: the panel of a stretch of hours, writing the date and its hours.
  const hoursPanel =
    pending && offer ? (
      <Popover open onClose={() => setPending(null)} className="p-3">
        <CalendarDayPanel
          accountId={account.id}
          board={board}
          column={column}
          choices={choices}
          askColumn={false}
          from={pending.day}
          to={pending.day}
          firstDay={env.firstDay}
          offer={offer}
          mutations={m}
          onPickColumn={pickColumn}
          onDone={() => setPending(null)}
          cells={timedCells(cfg, {}, pending.day, pending.start, pending.end - pending.start, region)}
          when={`${formatLongDay(pending.day)} · ${clockRange(pending.start, pending.end)}`}
        />
      </Popover>
    ) : null;

  const cardItem = cardId ? items.find((i) => i.id === cardId) : null;
  const whenOf = (it: Item) => {
    const span = readTimedSpan(it.cells, cfg, region);
    if (span)
      return span.day === span.endDay
        ? `${formatLongDay(span.day)} · ${clockRange(span.start, span.end)}`
        : `${formatLongDay(span.day)} ${clockOf(span.start)} – ${formatLongDay(span.endDay)} ${clockOf(span.end)}`;
    const d = readDateSpan(it, field, env.timezone);
    if (!d?.from) return '';
    return d.from === d.to ? formatLongDay(d.from) : `${formatLongDay(d.from)} – ${formatLongDay(d.to!)}`;
  };
  const cardNode = cardItem ? (
    <CalendarQuickCard
      board={board}
      item={cardItem}
      members={members}
      accountId={account.id}
      fields={quickCardFields(board, cal.card_fields, [
        column.id,
        cfg.startColumnId ?? undefined,
        cfg.endColumnId ?? undefined,
      ])}
      when={whenOf(cardItem)}
      onCell={(c, value, opts) =>
        m.setCell.mutate({
          itemId: cardItem.id,
          columnId: c.id,
          value,
          ...(opts?.workflowOverride ? { workflowOverride: true } : {}),
        })
      }
      onOpen={() => {
        setCardId(null);
        openItem(cardItem.id);
      }}
      onDelete={
        board.capabilities['item.delete']
          ? () => {
              setCardId(null);
              m.deleteItem.mutate({ id: cardItem.id, name: cardItem.name });
            }
          : undefined
      }
      onClose={() => setCardId(null)}
    />
  ) : null;

  const hebrew = showHebrewDates('calendars');
  const own = days.filter((d) => d.inMonth);
  const hebrewTitle = hebrew && own.length ? formatHebrewMonths(own[0]!.iso, own.at(-1)!.iso) : '';
  const title = rangeTitle(
    shownMode,
    own.map((d) => d.iso),
    phoneHours ? selected : anchor,
  );
  // "יום ראשון" -> "ראשון" (F4 headers); phones: one letter, "א׳" -> "א". Names in the region's language (A3).
  const isoOf = (d: Date) => d.toISOString().slice(0, 10);
  const weekday = (d: Date) => weekdayName(isoOf(d), 'long').replace(/^יום\s+/, '');
  const weekdayLetter = (d: Date) => weekdayName(isoOf(d), 'narrow').replace(/[׳'"]/g, '');
  const move = (dir: 1 | -1) => {
    setCardId(null);
    setPending(null);
    if (phoneHours) {
      setSelected(addDays(selected, dir));
      return;
    }
    if (shownMode !== 'month') {
      const step = calendarStep(shownMode) * dir;
      setAnchor(addDays(anchor, step));
      setSelected(addDays(selected, step));
      return;
    }
    const p = parseIso(anchor);
    const s = shiftMonth(p.year, p.month, dir);
    const first = `${s.year}-${String(s.month + 1).padStart(2, '0')}-01`;
    setAnchor(first);
    // The chosen day follows to the new month: today when it is in it, otherwise the 1st.
    setSelected(env.today.slice(0, 7) === first.slice(0, 7) ? env.today : first);
  };
  const goToday = () => {
    setAnchor(env.today);
    setSelected(env.today);
  };
  const openDay = (iso: IsoDate) => {
    if (!hours) return;
    setAnchor(iso);
    setMode('day');
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const el = e.target as HTMLElement;
    if (el.closest('input,textarea,select,[contenteditable="true"],[role="dialog"]')) return;
    const rtl = document.dir === 'rtl';
    const key = e.key.toLowerCase();
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') move((e.key === 'ArrowLeft') === rtl ? 1 : -1);
    else if (key === 't') goToday();
    else if (key === 'd' && modes.includes('day')) setMode('day');
    else if (key === 'w') setMode('week');
    else if (key === 'm') setMode('month');
    else return;
    e.preventDefault();
  };

  /** A drop in the grid: into hours (from where it is put, for its length) or onto the all-day strip. */
  const writeTo = (
    item: Item,
    to: { day: IsoDate; start: number; length: number } | { day: IsoDate; allDay: true },
  ) => {
    if ('allDay' in to) {
      write(
        item,
        allDayCells(cfg, item.cells, to.day),
        t('calendar.moved', { name: item.name, when: formatLongDay(to.day) }),
      );
      return;
    }
    write(
      item,
      timedCells(cfg, item.cells, to.day, to.start, to.length, region),
      t('calendar.movedAt', {
        name: item.name,
        when: `${formatLongDay(to.day)} ${clockRange(to.start, Math.min(24 * 60, to.start + to.length))}`,
      }),
    );
  };

  /** "Colour ▸" with no colour column yet: a status column of colours, the view's colour from now, the item painted. */
  const addColorColumn = async (item: Item, labels: { color: string; label: string }[], pick: number) => {
    try {
      const col = await m.createColumn.mutateAsync({
        title: t('calendar.menu.color'),
        type: 'status',
        settings: { labels: colorLabels(labels) },
      });
      update?.((s) => ({ ...s, calendar: { ...calendarSettingsOf(s.calendar), color_by: col.id } }));
      write(
        item,
        { [col.id]: { index: pick + 1 } },
        t('calendar.menu.set', { name: item.name, value: labels[pick]!.label }),
      );
    } catch (err) {
      showToast({ message: errorMessage(err), tone: 'error' });
    }
  };

  const canMove = writable;
  const navButton =
    'grid size-8 place-items-center rounded-[10px] border border-line-strong bg-surface text-heading hover:bg-surface-2';
  const toggle = (value: string, on: boolean, onClick: () => void, label: string) => (
    <button
      key={value}
      type="button"
      aria-pressed={on}
      data-testid={`calendar-mode-${value}`}
      onClick={onClick}
      className={cn(
        'h-[1.875rem] rounded-[9px] px-3.5 whitespace-nowrap max-md:h-[1.625rem] max-md:px-2.5',
        on ? 'bg-primary font-medium text-on-primary' : 'text-fg-2 hover:text-fg',
      )}
    >
      {label}
    </button>
  );
  return (
    <div className="flex flex-col outline-none" data-testid="calendar" tabIndex={-1} onKeyDown={onKeyDown}>
      {/* F4: [prev][today][next] then the range; the range toggle at the end (beside it on phones). */}
      <div className="mb-3 flex flex-wrap items-center gap-2 max-md:gap-1.5">
        <button type="button" aria-label={t('calendar.prev')} onClick={() => move(-1)} className={navButton}>
          <Icon name="chevronStart" size={15} />
        </button>
        <button
          type="button"
          onClick={goToday}
          className="h-8 rounded-[10px] border border-line-strong bg-surface px-2.5 text-sm text-heading hover:bg-surface-2"
        >
          {t('calendar.today')}
        </button>
        <button type="button" aria-label={t('calendar.next')} onClick={() => move(1)} className={navButton}>
          <Icon name="chevronEnd" size={15} />
        </button>
        <h2
          className="ms-2 font-display text-[1.1875rem] leading-tight font-extrabold text-heading max-md:ms-1 max-md:text-base"
          data-testid="calendar-title"
        >
          {title}
          {hebrewTitle ? (
            <span data-testid="calendar-hebrew-title" className="ms-2 font-sans text-sm font-normal text-muted">
              {hebrewTitle}
            </span>
          ) : null}
        </h2>
        <div className="ms-auto flex gap-0.5 overflow-x-auto rounded-[12px] bg-surface-2 p-[0.1875rem] text-sm max-md:text-xs">
          {desktop || !hours
            ? (desktop ? modes : (['month', 'week'] as CalendarMode[])).map((md) =>
                toggle(md, mode === md, () => setMode(md), t(`calendar.mode.${md}`)),
              )
            : (['day', 'month'] as const).map((md) =>
                toggle(md, phoneMode === md, () => setPhoneMode(md), t(`calendar.mode.${md}`)),
              )}
        </div>
      </div>
      {!desktop && !phoneHours ? (
        <CalendarPhone
          board={board}
          env={env}
          // Phones: no week made only of the next month's days (F4 .m shows the month's own weeks).
          days={days.filter((_, i) => days.slice(i - (i % 7), i - (i % 7) + 7).some((d) => d.inMonth))}
          byDay={byDay}
          colorOf={colorOf}
          selected={selected}
          onSelect={setSelected}
          weekdayLetter={weekdayLetter}
          onAdd={offer ? () => setSel({ start: selected, end: selected, open: true }) : undefined}
          addPanel={selected === panelDay ? dayPanel : null}
        />
      ) : null}
      {phoneHours ? (
        <div className="flex flex-col gap-2">
          <WeekStrip selected={selected} env={env} onSelect={setSelected} weekdayLetter={weekdayLetter} />
          <CalendarTimeGrid
            days={[selected]}
            items={items}
            field={field}
            cfg={cfg}
            cal={cal}
            env={env}
            colorOf={colorOf}
            canMove={canMove}
            canCreate={!!offer}
            hebrew={hebrew}
            phone
            pending={pending}
            panel={hoursPanel}
            card={cardNode && cardId ? { itemId: cardId, node: cardNode } : null}
            onWrite={(item, to) => writeTo(item, to)}
            onMoveDays={moveDays}
            onCreate={(day, start, end) => setPending({ day, start, end })}
            onOpenCard={(it) => setCardId(it.id)}
            onItemMenu={openMenu}
            onSwipe={(dir) => move(dir)}
          />
          {/* Canvas board 5: "+" makes an item at the next whole hour of the shown day. */}
          {offer ? (
            <button
              type="button"
              aria-label={t('calendar.newItem')}
              data-testid="calendar-phone-add"
              onClick={() => {
                const now = new Date();
                const next = Math.min(23, (selected === env.today ? now.getHours() : cal.day_start) + 1) * 60;
                setPending({ day: selected, start: next, end: Math.min(24 * 60, next + cal.default_duration) });
              }}
              className="fixed end-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-[5] grid size-[3.25rem] place-items-center rounded-[16px] bg-accent text-on-accent shadow-[var(--shadow-pop)]"
            >
              <Icon name="plus" size={22} />
            </button>
          ) : null}
        </div>
      ) : null}
      {desktop && timeMode ? (
        <CalendarTimeGrid
          days={days.map((d) => d.iso)}
          items={items}
          field={field}
          cfg={cfg}
          cal={cal}
          env={env}
          colorOf={colorOf}
          canMove={canMove}
          canCreate={!!offer}
          hebrew={hebrew}
          pending={pending}
          panel={hoursPanel}
          card={cardNode && cardId ? { itemId: cardId, node: cardNode } : null}
          onWrite={(item, to) => writeTo(item, to)}
          onMoveDays={moveDays}
          onCreate={(day, start, end) => setPending({ day, start, end })}
          onOpenCard={(it) => setCardId(it.id)}
          onItemMenu={openMenu}
          onDayClick={openDay}
        />
      ) : null}
      {/* One rounded box: weekday names, then the weeks with soft inner lines; rows keep a fixed height. */}
      {desktop && !timeMode ? (
        <div className="overflow-hidden rounded-[14px] border border-line bg-surface">
          <div className="grid grid-cols-7 bg-surface-3 text-center text-xs font-semibold text-muted">
            {days.slice(0, 7).map((d) => {
              const date = new Date(`${d.iso}T00:00:00Z`);
              return (
                <div key={d.iso} className="grid h-8 place-items-center truncate px-1">
                  <span className="max-md:hidden">{weekday(date)}</span>
                  <span className="md:hidden">{weekdayLetter(date)}</span>
                </div>
              );
            })}
          </div>
          <DndContext sensors={sensors} onDragEnd={onDragEnd} onDragCancel={() => (grabDay.current = null)}>
            {Array.from({ length: Math.ceil(days.length / 7) }, (_, w) => days.slice(w * 7, w * 7 + 7)).map((week) => (
              <MonthWeek
                key={week[0]!.iso}
                week={week}
                tall={shownMode !== 'month'}
                items={items}
                field={field}
                cfg={cfg}
                env={env}
                boardId={board.id}
                colorOf={colorOf}
                canMove={canMove}
                hebrew={hebrew}
                selFrom={selFrom}
                selTo={selTo}
                onPress={pressDay}
                onEnter={enterDay}
                panelDay={panelDay}
                panel={dayPanel}
                onGrab={(day) => (grabDay.current = day)}
                onDayOpen={hours ? openDay : undefined}
                onItemMenu={openMenu}
              />
            ))}
          </DndContext>
        </div>
      ) : null}
      {menuFor ? (
        <CalendarItemMenu
          key={menuFor.item.id}
          board={board}
          item={items.find((it) => it.id === menuFor.item.id) ?? menuFor.item}
          at={menuFor.at}
          mutations={m}
          colorColumnId={cal.color_by ?? null}
          onClose={() => setMenuFor((x) => (x ? { ...x, at: null } : x))}
          onQuickEdit={() => (timeMode || phoneHours ? setCardId(menuFor.item.id) : openItem(menuFor.item.id))}
          write={write}
          onCreateColorColumn={update ? (labels, pick) => void addColorColumn(menuFor.item, labels, pick) : undefined}
        />
      ) : null}
    </div>
  );
};

/** Phones with hours (canvas board 5): the week's days over the day grid; tap one to show it. */
const WeekStrip = ({
  selected,
  env,
  onSelect,
  weekdayLetter,
}: {
  selected: IsoDate;
  env: QueryEnv;
  onSelect: (iso: IsoDate) => void;
  weekdayLetter: (d: Date) => string;
}) => {
  const week = calendarRangeDays('week', selected, env);
  return (
    <div className="grid grid-cols-7 text-center" data-testid="calendar-week-strip">
      {week.map((d) => (
        <button
          key={d}
          type="button"
          aria-pressed={d === selected}
          onClick={() => onSelect(d)}
          className="flex flex-col items-center gap-0.5 text-[0.6875rem] text-muted"
        >
          {weekdayLetter(new Date(`${d}T00:00:00Z`))}
          <span
            className={cn(
              'grid size-[1.875rem] place-items-center rounded-full text-sm text-fg-2',
              d === selected && 'bg-primary text-on-primary',
              d === env.today && 'ring-2 ring-accent ring-inset',
            )}
          >
            {parseIso(d).day}
          </span>
        </button>
      ))}
    </div>
  );
};

/**
 * A week of the month (or the week without hours): seven day cells (number, Hebrew date, holidays, a drop target,
 * an empty spot to press), and over them the week's items in lanes — an item over several days as one bar across
 * them (canvas board 4), an item with a time as a dot, the time and its name. A day with more shows "+N".
 */
const MonthWeek = ({
  week,
  tall,
  items,
  field,
  cfg,
  env,
  boardId,
  colorOf,
  canMove,
  hebrew,
  selFrom,
  selTo,
  onPress,
  onEnter,
  panelDay,
  panel,
  onGrab,
  onDayOpen,
  onItemMenu,
}: {
  week: { iso: string; inMonth: boolean }[];
  tall: boolean;
  items: Item[];
  field: Field;
  cfg: CalendarTimeConfig;
  env: QueryEnv;
  boardId: string;
  colorOf: (it: Item) => string | null;
  canMove: boolean;
  hebrew: boolean;
  selFrom: string | null;
  selTo: string | null;
  onPress: (iso: string, e: ReactPointerEvent) => void;
  onEnter: (iso: string) => void;
  panelDay: string | null;
  panel: ReactNode;
  onGrab: (day: string) => void;
  onDayOpen?: (iso: string) => void;
  onItemMenu?: (item: Item, at: { x: number; y: number }) => void;
}) => {
  const isos = week.map((d) => d.iso);
  const region = getRegion();
  const lanesMax = tall ? 40 : MONTH_LANES;
  const [moreDay, setMoreDay] = useState<string | null>(null);
  const placed = useMemo(() => {
    const spans: { id: string; from: string; to: string; item: Item; time: number | null }[] = [];
    for (const it of items) {
      const d = readDateSpan(it, field, env.timezone);
      if (!d?.from || !d.to || d.to < isos[0]! || d.from > isos.at(-1)!) continue;
      const span = readTimedSpan(it.cells, cfg, region);
      spans.push({
        id: it.id,
        from: d.from,
        to: d.to,
        item: it,
        time: span && span.day === d.from ? span.start : null,
      });
    }
    // Within a day: all-day first, then by the time of day.
    return dayBars(spans, isos, (a, b) => (a.time ?? -1) - (b.time ?? -1));
  }, [items, field, env.timezone, isos, cfg, region]);
  // A lane per bar; the last free lane of a crowded day says "+N".
  const hidden = new Map<number, number>();
  const shown = placed.filter((b) => {
    if (
      b.lane < lanesMax - 1 ||
      (b.lane === lanesMax - 1 && !placed.some((x) => x.lane >= lanesMax && x.first <= b.last && x.last >= b.first))
    )
      return true;
    for (let k = b.first; k <= b.last; k++) hidden.set(k, (hidden.get(k) ?? 0) + 1);
    return false;
  });
  return (
    <div className={cn('relative grid grid-cols-7', tall ? 'min-h-[26.25rem]' : 'h-[7rem] max-md:h-[4.75rem]')}>
      {week.map((d) => (
        <Day
          key={d.iso}
          iso={d.iso}
          inMonth={d.inMonth}
          weekend={isWeekend(d.iso, env.weekend)}
          today={d.iso === env.today}
          hebrew={hebrew}
          selected={!!selFrom && d.iso >= selFrom && d.iso <= selTo!}
          onPress={(e) => onPress(d.iso, e)}
          onEnter={() => onEnter(d.iso)}
          panel={d.iso === panelDay ? panel : null}
          onOpen={onDayOpen ? () => onDayOpen(d.iso) : undefined}
        />
      ))}
      <div
        className="pointer-events-none absolute inset-x-0 top-7 bottom-1 grid auto-rows-[1.25rem] grid-cols-7 gap-y-[0.1875rem]"
        data-testid="calendar-week-lanes"
      >
        {shown.map((b) => (
          <CalendarChip
            key={b.item.id}
            item={b.item.item}
            day={isos[b.first]!}
            lastDay={isos[b.last]!}
            boardId={boardId}
            color={colorOf(b.item.item)}
            canMove={canMove}
            time={b.item.time}
            bar={b.last > b.first || b.before || b.after}
            before={b.before}
            after={b.after}
            onGrab={(x, rect) => {
              // The day under the pointer, inside the bar (RTL: days run from the right).
              const n = b.last - b.first + 1;
              const offset = document.dir === 'rtl' ? rect.right - x : x - rect.left;
              const k = Math.min(n - 1, Math.max(0, Math.floor((offset / Math.max(1, rect.width)) * n)));
              onGrab(isos[b.first + k]!);
            }}
            style={{ gridColumn: `${b.first + 1} / ${b.last + 2}`, gridRow: b.lane + 1 }}
            onMenu={onItemMenu}
          />
        ))}
        {[...hidden.entries()].map(([k, n]) => (
          <button
            key={`more-${k}`}
            type="button"
            className="pointer-events-auto relative px-1.5 text-start text-xs text-muted hover:text-fg"
            style={{ gridColumn: k + 1, gridRow: lanesMax }}
            data-testid="calendar-more"
            onClick={() => setMoreDay(isos[k]!)}
          >
            {t('calendar.more', { n })}
            {moreDay === isos[k] ? (
              <Popover open onClose={() => setMoreDay(null)} className="w-64 p-2">
                <div className="flex flex-col gap-1" onPointerDown={(e) => e.stopPropagation()}>
                  <p className="px-1 pb-1 text-sm text-heading">{formatLongDay(isos[k]!)}</p>
                  {placed
                    .filter((x) => x.first <= k && x.last >= k)
                    .map((x) => (
                      <CalendarChip
                        key={x.item.id}
                        item={x.item.item}
                        day={isos[k]!}
                        boardId={boardId}
                        color={colorOf(x.item.item)}
                        canMove={false}
                        time={x.item.time}
                        bar={false}
                        onMenu={onItemMenu}
                      />
                    ))}
                </div>
              </Popover>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
};

const Day = ({
  iso,
  inMonth,
  weekend,
  today,
  hebrew,
  selected,
  onPress,
  onEnter,
  panel,
  onOpen,
}: {
  iso: string;
  inMonth: boolean;
  /** The account's weekend (A3): a quiet shade. */
  weekend: boolean;
  today: boolean;
  /** Show the Hebrew date in the corner (the account's calendar setting). */
  hebrew: boolean;
  /** in the days being picked (an empty spot pressed, dragged across days). */
  selected?: boolean;
  onPress?: (e: ReactPointerEvent) => void;
  onEnter?: () => void;
  /** The empty-day panel, anchored to this day. */
  panel?: ReactNode;
  /** With hours: the day's number opens that day. */
  onOpen?: () => void;
}) => {
  const { setNodeRef, isOver } = useDroppable({ id: iso });
  // Holidays and the account's own days: a dot by the number and the name in quiet text — no fill
  // like the date picker. The account's "none" hides both.
  const info = regionDay(iso);
  const marksOn = showDayMarks();
  const dot = marksOn ? dayDotState(info.state) : null;
  const number = (
    <span
      className={cn(
        // Days of the month in the body colour, the days around it muted; phones centre the number.
        'shrink-0 px-1 text-xs max-md:text-center',
        inMonth ? 'font-normal text-fg-2' : 'text-muted',
        today && 'inline-grid size-[1.375rem] place-items-center rounded-full bg-accent px-0 text-on-accent',
      )}
    >
      {parseIso(iso).day}
    </span>
  );
  return (
    <div
      ref={setNodeRef}
      data-testid="calendar-day"
      data-day={iso}
      data-weekend={weekend || undefined}
      data-day-state={info.state ?? undefined}
      className={cn(
        'flex min-w-0 flex-col gap-1 overflow-hidden border-t border-s border-line-soft p-1.5 max-md:p-1 [&:nth-child(7n+1)]:border-s-0',
        !inMonth
          ? 'bg-surface-3'
          : weekend
            ? 'bg-[color-mix(in_srgb,var(--surface-3)_55%,var(--surface))]'
            : 'bg-surface',
        (isOver || selected) && 'bg-primary-soft',
      )}
      onPointerDown={onPress}
      onPointerEnter={onEnter}
    >
      {panel}
      <div className="flex min-w-0 items-center gap-1 max-md:justify-center">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="rounded-full hover:bg-surface-2"
            data-testid="calendar-day-open"
          >
            {number}
          </button>
        ) : (
          number
        )}
        {dot ? <DayDot state={dot} /> : null}
        {hebrew ? (
          <span
            data-testid="calendar-day-hebrew"
            className="shrink-0 text-[0.6875rem] font-normal text-muted max-md:hidden"
          >
            {formatHebrew(iso, 'day_month')}
          </span>
        ) : null}
        {marksOn && info.marks.length ? (
          <span className="ms-auto flex min-w-0 gap-1.5 max-md:hidden">
            {info.marks.map((mk, k) => {
              const name = dayMarkName(mk);
              return (
                <span
                  key={k}
                  data-testid="calendar-holiday"
                  title={name}
                  className="truncate text-[0.6875rem] leading-[1.125rem] font-normal text-muted"
                >
                  {name}
                </span>
              );
            })}
          </span>
        ) : null}
      </div>
    </div>
  );
};

/**
 * An item in the month: a bar in its label colour across its days, or — one day with a time — a dot in its colour,
 * the time and the name (canvas board 4). Drag it to another day.
 */
const CalendarChip = ({
  item,
  day,
  boardId,
  color,
  canMove,
  time,
  bar,
  before,
  after,
  onGrab,
  lastDay,
  style,
  onMenu,
}: {
  item: Item;
  day: string;
  boardId: string;
  color: string | null;
  canMove: boolean;
  /** Minutes after midnight when it has a time on its first day. */
  time: number | null;
  bar: boolean;
  before?: boolean;
  after?: boolean;
  onGrab?: (x: number, rect: DOMRect) => void;
  /** The last day of the row it covers (a bar). */
  lastDay?: string;
  style?: React.CSSProperties;
  /** The item menu at a point (right click, Shift+F10 / the menu key). */
  onMenu?: (item: Item, at: { x: number; y: number }) => void;
}) => {
  const open = useOpenItem(boardId);
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${item.id}|${day}`,
    disabled: !canMove,
  });
  const timed = time !== null && !bar;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onPointerDown={(e) => {
        onGrab?.(e.clientX, e.currentTarget.getBoundingClientRect());
        listeners?.onPointerDown?.(e);
      }}
      style={{
        // The board's chip in the item's label colour (its tint, its ink, regular weight); no colour = a neutral chip.
        ...(color && !timed ? tagVars(color) : {}),
        ...style,
        ...(transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : {}),
      }}
      className={cn(
        'pointer-events-auto mx-[0.1875rem] flex h-5 min-w-0 shrink-0 cursor-pointer items-center gap-1 truncate rounded-[6px] px-1.5 text-[0.6875rem] hover:opacity-90',
        timed ? 'text-fg' : color ? 'label-tag justify-start rounded-[6px]' : 'bg-surface-2 text-fg',
        before && 'ms-0 rounded-s-none',
        after && 'me-0 rounded-e-none',
        isDragging && 'relative z-20 opacity-90 shadow-[var(--shadow-pop)]',
        canMove && 'cursor-grab',
      )}
      data-testid="calendar-item"
      data-item-name={item.name}
      data-day={day}
      data-last-day={lastDay ?? day}
      role="link"
      title={item.name}
      onClick={() => open(item.id)}
      onContextMenu={(e) => {
        if (!onMenu) return;
        e.preventDefault();
        e.stopPropagation();
        onMenu(item, { x: e.clientX, y: e.clientY });
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') open(item.id);
        else if (onMenu && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(item, { x: r.left + 8, y: r.bottom });
        }
      }}
    >
      {timed ? (
        <>
          <i
            className="size-[0.4375rem] shrink-0 rounded-full"
            style={{ backgroundColor: color ? `var(--c-${color})` : 'var(--muted)' }}
          />
          <bdi dir="ltr" className="shrink-0 text-muted tabular-nums">
            {clockOf(time)}
          </bdi>
        </>
      ) : time !== null ? (
        <bdi dir="ltr" className="shrink-0 opacity-80 tabular-nums">
          {clockOf(time)}
        </bdi>
      ) : null}
      <span className="truncate">{item.name}</span>
    </div>
  );
};

/**
 * a board with no date or timeline column — the calendar says so and, for whoever may add columns
 * adds one (the view then shows it).
 */
const NoDateColumn = ({ canAdd, add }: { canAdd: boolean; add: (type: 'date' | 'timeline') => Promise<void> }) => {
  const [busy, setBusy] = useState(false);
  const run = (type: 'date' | 'timeline') => {
    setBusy(true);
    add(type)
      .catch((err: unknown) => showToast({ message: errorMessage(err), tone: 'error' }))
      .finally(() => setBusy(false));
  };
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center" data-testid="calendar-no-column">
      <p className="text-sm text-muted">{t('calendar.noColumn')}</p>
      {canAdd ? (
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" busy={busy} onClick={() => run('date')} data-testid="calendar-add-date">
            {t('calendar.addColumn.date')}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            busy={busy}
            onClick={() => run('timeline')}
            data-testid="calendar-add-timeline"
          >
            {t('calendar.addColumn.timeline')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
