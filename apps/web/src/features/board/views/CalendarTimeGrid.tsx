// SPDX-License-Identifier: AGPL-3.0-only
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  addDays,
  dayBars,
  DAY_MINUTES,
  dayMarkName,
  formatHebrew,
  formatHour,
  formatHourValue,
  getRegion,
  isSameDaySpan,
  isWeekend,
  layoutOverlaps,
  localTimeOf,
  minutesOf,
  parseIso,
  readDateSpan,
  readTimedSpan,
  regionDay,
  showDayMarks,
  snapMinutes,
  spanMinutes,
  t,
  weekdayName,
  type CalendarTimeConfig,
  type CalendarViewSettings,
  type Field,
  type IsoDate,
  type QueryEnv,
  type TimedSpan,
} from '@bines/shared';
import { cn, DayDot, dayDotState } from '@bines/ui';
import { tagVars } from '../../../lib/label-color';
import type { Item } from '../board-api';

/** Pixels per hour of each "hour height" (view setting). */
export const HOUR_PX = { small: 36, normal: 48, large: 64 } as const;

/** A press must travel this far (px) before it is a drag, not a click. */
const DRAG_PX = 4;
/** A finger holds this long (ms) on an item before it can be dragged (a quick swipe scrolls). */
const LONG_PRESS_MS = 400;

/** "09:00" in the region's clock (24h / 12h), from minutes after midnight. */
export const clockOf = (minutes: number) => {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return formatHourValue(
    { hour: Math.floor(m / 60), minute: m % 60 },
    getRegion().time_format === '12h' ? '12h' : '24h',
  );
};
/**
 * "09:00–10:30" (end at midnight = "24:00" in 24h), isolated left-to-right so a Hebrew sentence around it never turns it
 * into "10:30–09:00".
 */
export const clockRange = (start: number, end: number) =>
  `\u2066${clockOf(start)}–${end === DAY_MINUTES && getRegion().time_format !== '12h' ? '24:00' : clockOf(end)}\u2069`;

type Placed = { item: Item; day: IsoDate; start: number; end: number };
type Drag =
  | { kind: 'move'; item: Item; span: TimedSpan; grab: number; x: number; y: number; active: boolean }
  | { kind: 'resize'; item: Item; span: TimedSpan; grab: number; x: number; y: number; active: boolean }
  | { kind: 'bar'; item: Item; from: IsoDate; to: IsoDate; grabDay: number; x: number; y: number; active: boolean }
  | { kind: 'create'; day: IsoDate; a: number };
/** Where a drag would put the item now: in the hours of a day, or on a day of the all-day strip. */
type Target = { day: IsoDate; start: number; end: number } | { day: IsoDate; allDay: true };

/**
 * day / 3 days / week by the hour (the approved canvas, board 1). Items with hours sit in their
 * hours — sized by their length, overlapping ones side by side; items without hours (and spans over several days)
 * run along the all-day strip at the top. Drag to move (days and hours, snapped), drag the bottom edge to change the
 * end, drag an empty stretch to make a new item there; all-day ↔ hours by dropping across the strip's edge.
 * Writes go out through `onWrite` (one PATCH per gesture, one undo).
 */
export const CalendarTimeGrid = ({
  days,
  items,
  field,
  cfg,
  cal,
  env,
  colorOf,
  canMove,
  canCreate,
  hebrew,
  phone,
  pending,
  panel,
  card,
  onWrite,
  onMoveDays,
  onCreate,
  onOpenCard,
  onItemMenu,
  onDayClick,
  onSwipe,
}: {
  days: IsoDate[];
  items: Item[];
  /** The view's date / timeline column (all-day spans). */
  field: Field;
  cfg: CalendarTimeConfig;
  cal: CalendarViewSettings;
  env: QueryEnv;
  colorOf: (it: Item) => string | null;
  canMove: boolean;
  canCreate: boolean;
  hebrew: boolean;
  phone?: boolean;
  /** The stretch being made into a new item (its panel is open). */
  pending: { day: IsoDate; start: number; end: number } | null;
  panel: ReactNode;
  /** The item whose quick card is open, and the card. */
  card: { itemId: string; node: ReactNode } | null;
  /** An item placed in hours (`start`/`length` in minutes) or made all-day on `day`. */
  onWrite: (item: Item, to: { day: IsoDate; start: number; length: number } | { day: IsoDate; allDay: true }) => void;
  /** An all-day item moved by whole days. */
  onMoveDays: (item: Item, delta: number) => void;
  onCreate: (day: IsoDate, start: number, end: number) => void;
  onOpenCard: (item: Item) => void;
  /** The item menu at a point: right click, Shift+F10 / the menu key, or a long press let go in place. */
  onItemMenu?: (item: Item, at: { x: number; y: number }) => void;
  onDayClick?: (day: IsoDate) => void;
  /** Phones: a sideways swipe — the next (1) or previous (-1) day. */
  onSwipe?: (dir: 1 | -1) => void;
}) => {
  const hourPx = HOUR_PX[cal.hour_height] ?? HOUR_PX.normal;
  const pxPerMin = hourPx / 60;
  const region = getRegion();
  const marksOn = showDayMarks();
  const colRefs = useRef<(HTMLDivElement | null)[]>([]);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The press in progress, where it would land and a stretch being drawn: state for the render, and refs for the
  // window listeners (set together, so a pointerup right after a move reads the latest).
  const [drag, setDragState] = useState<Drag | null>(null);
  const [target, setTargetState] = useState<Target | null>(null);
  const [sel, setSelState] = useState<{ day: IsoDate; start: number; end: number } | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const targetRef = useRef<Target | null>(null);
  const selRef = useRef<{ day: IsoDate; start: number; end: number } | null>(null);
  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };
  const setTarget = (tg: Target | null) => {
    targetRef.current = tg;
    setTargetState(tg);
  };
  const setSel = (x: { day: IsoDate; start: number; end: number } | null) => {
    selRef.current = x;
    setSelState(x);
  };

  // The current minute in the viewer's zone (the red line), once a minute.
  const [now, setNow] = useState(() => minutesOf(localTimeOf(new Date(), region)));
  useEffect(() => {
    const id = window.setInterval(() => setNow(minutesOf(localTimeOf(new Date(), getRegion()))), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Opens on the shown hours: the day's start at the top.
  useLayoutEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = cal.day_start * hourPx;
  }, [cal.day_start, hourPx]);

  const { timed, allDay } = useMemo(() => {
    const timedOut: Placed[] = [];
    const allOut: { id: string; from: IsoDate; to: IsoDate; item: Item; span: TimedSpan | null }[] = [];
    const first = days[0]!;
    const last = days.at(-1)!;
    for (const it of items) {
      const span = readTimedSpan(it.cells, cfg, region);
      if (span && isSameDaySpan(span)) {
        if (span.day >= first && span.day <= last && days.includes(span.day))
          timedOut.push({
            item: it,
            day: span.day,
            start: span.start,
            end: span.day === span.endDay ? span.end : DAY_MINUTES,
          });
        continue;
      }
      const d = span ? { from: span.day, to: span.endDay } : readDateSpan(it, field, env.timezone);
      if (d?.from && d.to && d.to >= first && d.from <= last)
        allOut.push({ id: it.id, from: d.from, to: d.to, item: it, span });
    }
    return { timed: timedOut, allDay: allOut };
  }, [items, cfg, region, days, field, env.timezone]);

  const bars = useMemo(() => dayBars(allDay, days), [allDay, days]);
  /** The last day an all-day drop covers: a moved bar keeps its days. */
  const stripEnd = (from: IsoDate) =>
    drag?.kind === 'bar' ? addDays(from, Math.round((Date.parse(drag.to) - Date.parse(drag.from)) / 86_400_000)) : from;
  const lanes = bars.reduce((n, b) => Math.max(n, b.lane + 1), 0);

  // ---- pointer → place ----
  const dayIndexAt = (x: number) =>
    colRefs.current.findIndex((c) => {
      const r = c?.getBoundingClientRect();
      return !!r && x >= r.left && x < r.right;
    });
  /** The day under x, or the nearest one when the pointer is past the first / last day. */
  const nearestDay = (x: number) => {
    const at = dayIndexAt(x);
    if (at >= 0) return at;
    let best = 0;
    let dist = Infinity;
    colRefs.current.forEach((c, i) => {
      const r = c?.getBoundingClientRect();
      if (!r) return;
      const dd = Math.abs(x - (r.left + r.right) / 2);
      if (dd < dist) {
        dist = dd;
        best = i;
      }
    });
    return best;
  };
  const minuteAt = (y: number, index: number) => {
    const c = colRefs.current[index] ?? colRefs.current[0];
    return c ? (y - c.getBoundingClientRect().top) / pxPerMin : 0;
  };
  const overStrip = (y: number) => {
    const r = stripRef.current?.getBoundingClientRect();
    return !!r && y <= r.bottom;
  };

  const targetOf = (d: Drag, x: number, y: number): Target | null => {
    const index = nearestDay(x);
    const day = days[index]!;
    if (d.kind === 'create') return null;
    if (d.kind === 'resize') {
      // The end moves by as much as the pointer did (wherever on the edge it was grabbed).
      const was = d.span.day === d.span.endDay ? d.span.end : DAY_MINUTES;
      const end = Math.min(
        DAY_MINUTES,
        Math.max(d.span.start + cal.snap, snapMinutes(was + minuteAt(y, index) - d.grab, cal.snap)),
      );
      return { day: d.span.day, start: d.span.start, end };
    }
    if (overStrip(y)) {
      if (d.kind === 'bar') return { day: addDays(day, -d.grabDay), allDay: true };
      return { day, allDay: true };
    }
    const len = d.kind === 'move' ? Math.min(spanMinutes(d.span), DAY_MINUTES) : cal.default_duration;
    const grab = d.kind === 'move' ? d.grab : 0;
    const start = Math.max(0, Math.min(DAY_MINUTES - len, snapMinutes(minuteAt(y, index) - grab, cal.snap)));
    return { day, start, end: start + len };
  };

  // Window listeners while a press is down (the item may re-render under the pointer).
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'create') {
        const index = days.indexOf(d.day);
        const b = snapMinutes(minuteAt(e.clientY, index), cal.snap);
        setSel({
          day: d.day,
          start: Math.max(0, Math.min(d.a, b)),
          end: Math.min(DAY_MINUTES, Math.max(d.a + cal.snap, b)),
        });
        return;
      }
      if (!d.active) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
        setDrag({ ...d, active: true });
      }
      setTarget(targetOf(d, e.clientX, e.clientY));
    };
    const up = () => {
      const d = dragRef.current;
      const tg = targetRef.current;
      setDrag(null);
      setTarget(null);
      if (!d) return;
      if (d.kind === 'create') {
        const s = selRef.current;
        setSel(null);
        if (!s) return;
        // A click (no stretch) = the view's default length from there.
        const end = s.end - s.start <= cal.snap ? Math.min(DAY_MINUTES, s.start + cal.default_duration) : s.end;
        onCreate(s.day, s.start, end);
        return;
      }
      const held = heldByTouch.current === d.item.id;
      heldByTouch.current = null;
      if (!d.active || !tg) {
        if (!d.active) onOpenCard(d.item);
        return;
      }
      if ('allDay' in tg) {
        if (d.kind === 'bar') {
          const delta = Math.round((Date.parse(tg.day) - Date.parse(d.from)) / 86_400_000);
          if (delta) onMoveDays(d.item, delta);
          else if (held) onItemMenu?.(d.item, { x: d.x, y: d.y });
        } else onWrite(d.item, tg);
        return;
      }
      if (
        d.kind !== 'bar' &&
        tg.day === d.span.day &&
        tg.start === d.span.start &&
        tg.end - tg.start === spanMinutes(d.span)
      ) {
        if (held) onItemMenu?.(d.item, { x: d.x, y: d.y });
        return;
      }
      onWrite(d.item, { day: tg.day, start: tg.start, length: tg.end - tg.start });
    };
    const cancel = () => {
      setDrag(null);
      setTarget(null);
      setSel(null);
    };
    // A finger dragging an item must not scroll the page under it.
    const noScroll = (e: TouchEvent) => {
      if (dragRef.current && (dragRef.current.kind === 'create' || dragRef.current.active)) e.preventDefault();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('touchmove', noScroll, { passive: false });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('touchmove', noScroll);
    };
    // Re-bound when a press starts or ends; the handlers read the live drag through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!drag, days, cal.snap, cal.default_duration]);

  // A finger: an item becomes draggable after a long press; moving first lets the page scroll.
  const pressTimer = useRef<number | null>(null);
  /** A long press picked this item up: let go in place, it opens the item menu instead (a phone's right click). */
  const heldByTouch = useRef<string | null>(null);
  const openMenu = (e: ReactMouseEvent, item: Item) => {
    if (!onItemMenu) return;
    e.preventDefault();
    e.stopPropagation();
    onItemMenu(item, { x: e.clientX, y: e.clientY });
  };
  /** Enter opens the quick card; Shift+F10 / the menu key the item menu, under the item. */
  const eventKey = (e: ReactKeyboardEvent<HTMLElement>, item: Item) => {
    if (e.key === 'Enter') return onOpenCard(item);
    if (onItemMenu && (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey))) {
      e.preventDefault();
      const r = e.currentTarget.getBoundingClientRect();
      onItemMenu(item, { x: r.left + 8, y: r.bottom });
    }
  };

  const startPress = (e: ReactPointerEvent, d: Exclude<Drag, { kind: 'create' }>) => {
    // The quick card sits in a portal: its own presses reach the item through React, never as a drag.
    if (e.button !== 0 || !e.currentTarget.contains(e.target as Node)) return;
    e.stopPropagation();
    if (!canMove) {
      if (e.pointerType !== 'touch') setDrag({ ...d, active: false });
      else onOpenCard(d.item);
      return;
    }
    if (e.pointerType === 'touch') {
      const x = e.clientX;
      const y = e.clientY;
      const cancel = (ev: PointerEvent) => {
        if (Math.hypot(ev.clientX - x, ev.clientY - y) > 8) clear();
      };
      const clear = () => {
        if (pressTimer.current) window.clearTimeout(pressTimer.current);
        pressTimer.current = null;
        window.removeEventListener('pointermove', cancel);
        window.removeEventListener('pointerup', tap);
      };
      const tap = () => {
        clear();
        onOpenCard(d.item);
      };
      window.addEventListener('pointermove', cancel);
      window.addEventListener('pointerup', tap, { once: true });
      pressTimer.current = window.setTimeout(() => {
        clear();
        navigator.vibrate?.(15);
        heldByTouch.current = d.item.id;
        setDrag({ ...d, active: true });
        setTarget(targetOf(d, x, y));
      }, LONG_PRESS_MS);
      return;
    }
    e.preventDefault();
    setDrag(d);
  };

  const pressEmpty = (e: ReactPointerEvent, index: number) => {
    if (!canCreate || e.button !== 0 || e.pointerType === 'touch' || !e.currentTarget.contains(e.target as Node))
      return;
    if ((e.target as HTMLElement).closest('[data-calendar-event],button')) return;
    e.preventDefault();
    const day = days[index]!;
    const a = Math.max(
      0,
      Math.min(DAY_MINUTES - cal.snap, snapMinutes(minuteAt(e.clientY, index) - cal.snap / 2, cal.snap)),
    );
    setSel({ day, start: a, end: a + cal.snap });
    setDrag({ kind: 'create', day, a });
  };
  // Phones: a tap on an empty hour makes an item there; a sideways swipe changes the day.
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const touchStart = (e: React.TouchEvent) => {
    const tch = e.touches[0];
    swipe.current = tch && e.touches.length === 1 ? { x: tch.clientX, y: tch.clientY } : null;
  };
  const touchEnd = (e: React.TouchEvent, index: number) => {
    const s = swipe.current;
    swipe.current = null;
    const tch = e.changedTouches[0];
    if (!s || !tch || dragRef.current || !e.currentTarget.contains(e.target as Node)) return;
    const dx = tch.clientX - s.x;
    const dy = tch.clientY - s.y;
    if (onSwipe && Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      // RTL: a swipe to the left brings the next day (it comes in from the left edge).
      const rtl = document.dir === 'rtl';
      onSwipe(dx < 0 === rtl ? -1 : 1);
      return;
    }
    if (Math.hypot(dx, dy) < 8 && canCreate && !(e.target as HTMLElement).closest('[data-calendar-event],button')) {
      const start = Math.max(0, snapMinutes(minuteAt(tch.clientY, index) - cal.snap / 2, cal.snap));
      onCreate(days[index]!, start, Math.min(DAY_MINUTES, start + cal.default_duration));
    }
  };

  const viewHeight = `min(${Math.max(4, cal.day_end - cal.day_start) * hourPx + 1}px, calc(100dvh - ${phone ? 13 : 16}rem))`;
  const draggingId = drag && drag.kind !== 'create' && drag.active ? drag.item.id : null;
  const grid: CSSProperties = { gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` };
  const blockStyle = (color: string | null): CSSProperties =>
    color ? { ...tagVars(color), backgroundColor: 'var(--tag-soft)', color: 'var(--tag-ink)' } : {};

  return (
    <div
      className="overflow-hidden rounded-[14px] border border-line bg-surface select-none"
      data-testid="calendar-time-grid"
      data-days={days.length}
    >
      {phone ? null : (
        <div className="grid border-b border-line bg-surface-3" style={grid}>
          <div />
          {days.map((d) => {
            const info = regionDay(d);
            const dot = marksOn ? dayDotState(info.state) : null;
            const today = d === env.today;
            return (
              <button
                key={d}
                type="button"
                data-testid="calendar-grid-day"
                data-day={d}
                onClick={() => onDayClick?.(d)}
                className="flex min-w-0 flex-col items-center gap-0.5 px-1 pt-1.5 pb-2 text-center hover:bg-surface-2"
              >
                <span className="text-xs font-medium text-muted">{weekdayName(d, 'long').replace(/^יום\s+/, '')}</span>
                <span
                  className={cn(
                    'grid size-8 place-items-center rounded-full font-display text-xl text-fg-2',
                    today && 'bg-accent text-on-accent',
                  )}
                >
                  {parseIso(d).day}
                </span>
                <span className="flex max-w-full items-center gap-1 text-[0.6875rem] text-muted">
                  {dot ? <DayDot state={dot} /> : null}
                  {hebrew ? <span data-testid="calendar-day-hebrew">{formatHebrew(d, 'day_month')}</span> : null}
                  {marksOn && info.marks.length ? (
                    <span className="truncate" title={info.marks.map((mk) => dayMarkName(mk)).join(' · ')}>
                      {dayMarkName(info.marks[0]!)}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* The all-day strip: items without hours and spans over several days, as bars across the days. */}
      <div
        ref={stripRef}
        data-testid="calendar-allday"
        className="relative grid border-b border-line"
        style={{ ...grid, minHeight: `${Math.max(1, lanes) * 1.5625 + 0.5}rem` }}
      >
        <div className="grid place-items-center text-[0.6875rem] text-muted">{t('calendar.allDay')}</div>
        {days.map((d) => (
          <div
            key={d}
            className={cn(
              'border-s border-line-soft',
              target && 'allDay' in target && d >= target.day && d <= stripEnd(target.day) && 'bg-primary-soft',
            )}
          />
        ))}
        <div
          className="pointer-events-none absolute inset-y-1 grid auto-rows-[1.375rem] gap-y-[0.1875rem]"
          style={{
            insetInlineStart: '3.5rem',
            insetInlineEnd: 0,
            gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))`,
          }}
        >
          {bars.map((b) => {
            const moving = drag?.kind === 'bar' && drag.active && drag.item.id === b.item.id;
            const color = colorOf(b.item.item);
            return (
              <div
                key={b.item.id}
                data-calendar-event
                data-testid="calendar-item"
                data-item-name={b.item.item.name}
                data-day={days[b.first]}
                data-last-day={days[b.last]}
                role="link"
                tabIndex={0}
                title={b.item.item.name}
                onPointerDown={(e) =>
                  startPress(e, {
                    kind: 'bar',
                    item: b.item.item,
                    from: b.item.from,
                    to: b.item.to,
                    grabDay: Math.max(0, dayIndexAt(e.clientX) - b.first),
                    x: e.clientX,
                    y: e.clientY,
                    active: false,
                  })
                }
                onKeyDown={(e) => eventKey(e, b.item.item)}
                onContextMenu={(e) => openMenu(e, b.item.item)}
                className={cn(
                  'pointer-events-auto relative mx-[0.1875rem] truncate rounded-[6px] px-1.5 text-[0.6875rem] leading-[1.375rem]',
                  color ? '' : 'bg-surface-2 text-fg',
                  b.before && 'ms-0 rounded-s-none',
                  b.after && 'me-0 rounded-e-none',
                  canMove && 'cursor-grab',
                  moving && 'opacity-40',
                )}
                style={{ ...blockStyle(color), gridColumn: `${b.first + 1} / ${b.last + 2}`, gridRow: b.lane + 1 }}
              >
                {b.item.span ? `${clockOf(b.item.span.start)} ` : ''}
                {b.item.item.name}
                {card?.itemId === b.item.item.id ? card.node : null}
              </div>
            );
          })}
        </div>
      </div>

      <div ref={scrollRef} className="relative overflow-y-auto overscroll-contain" style={{ maxHeight: viewHeight }}>
        <div className="grid" style={grid}>
          <div className="relative" style={{ height: 24 * hourPx }} aria-hidden>
            {Array.from({ length: 23 }, (_, i) => i + 1).map((h) => (
              <span
                key={h}
                className="absolute -translate-y-1/2 text-[0.6875rem] text-muted tabular-nums"
                style={{ top: h * hourPx, insetInlineEnd: '0.5rem' }}
              >
                {formatHour(h, region)}
              </span>
            ))}
          </div>
          {days.map((d, index) => {
            const dayItems = timed.filter((p) => p.day === d);
            const lay = layoutOverlaps(dayItems.map((p) => ({ id: p.item.id, start: p.start, end: p.end })));
            const weekend = isWeekend(d, env.weekend);
            const ghost = target && !('allDay' in target) && target.day === d && draggingId ? target : null;
            const draggedItem = drag && drag.kind !== 'create' ? drag.item : null;
            return (
              <div
                key={d}
                ref={(el) => {
                  colRefs.current[index] = el;
                }}
                data-testid="calendar-hours"
                data-day={d}
                onPointerDown={(e) => pressEmpty(e, index)}
                onTouchStart={touchStart}
                onTouchEnd={(e) => touchEnd(e, index)}
                className={cn('relative border-s border-line-soft', canCreate && 'cursor-cell')}
                style={{
                  height: 24 * hourPx,
                  backgroundImage: `linear-gradient(to bottom, var(--line-soft) 1px, transparent 1px)`,
                  backgroundSize: `100% ${hourPx}px`,
                  backgroundColor: weekend ? 'color-mix(in srgb, var(--surface-3) 55%, var(--surface))' : undefined,
                }}
              >
                {/* Outside the shown hours: a quiet shade (still there, scrolled to). */}
                <div
                  className="pointer-events-none absolute inset-x-0 top-0 bg-surface-3/60"
                  style={{ height: cal.day_start * hourPx }}
                />
                <div
                  className="pointer-events-none absolute inset-x-0 bottom-0 bg-surface-3/60"
                  style={{ height: Math.max(0, 24 - cal.day_end) * hourPx }}
                />
                {dayItems.map((p) => {
                  const L = lay.get(p.item.id) ?? { col: 0, cols: 1 };
                  const w = 100 / L.cols;
                  const short = p.end - p.start <= 30;
                  const color = colorOf(p.item);
                  const moving = draggingId === p.item.id;
                  return (
                    <div
                      key={p.item.id}
                      data-calendar-event
                      data-testid="calendar-item"
                      data-item-name={p.item.name}
                      data-day={p.day}
                      data-start={p.start}
                      data-end={p.end}
                      role="link"
                      tabIndex={0}
                      title={`${clockRange(p.start, p.end)} ${p.item.name}`}
                      onPointerDown={(e) => {
                        const span = readTimedSpan(p.item.cells, cfg, region)!;
                        const resize = !!(e.target as HTMLElement).closest('[data-resize]');
                        startPress(
                          e,
                          resize
                            ? {
                                kind: 'resize',
                                item: p.item,
                                span,
                                grab: minuteAt(e.clientY, index),
                                x: e.clientX,
                                y: e.clientY,
                                active: false,
                              }
                            : {
                                kind: 'move',
                                item: p.item,
                                span,
                                grab: minuteAt(e.clientY, index) - p.start,
                                x: e.clientX,
                                y: e.clientY,
                                active: false,
                              },
                        );
                      }}
                      onKeyDown={(e) => eventKey(e, p.item)}
                      onContextMenu={(e) => openMenu(e, p.item)}
                      className={cn(
                        'absolute overflow-hidden rounded-[6px] border border-surface px-1.5 py-0.5 text-xs leading-tight',
                        color ? '' : 'bg-surface-2 text-fg',
                        short && 'flex items-center gap-1.5 whitespace-nowrap',
                        canMove ? 'cursor-grab' : 'cursor-pointer',
                        moving && 'opacity-40',
                      )}
                      style={{
                        ...blockStyle(color),
                        top: p.start * pxPerMin,
                        height: Math.max((p.end - p.start) * pxPerMin - 2, 18),
                        insetInlineStart: `calc(${L.col * w}% + 2px)`,
                        width: `calc(${w}% - 6px)`,
                      }}
                    >
                      <bdi
                        dir="ltr"
                        className={cn('text-[0.6875rem] opacity-85 tabular-nums', short ? 'shrink-0' : 'block')}
                      >
                        {/* Half an hour or less: one line, the start only (the name gets the room). */}
                        {short ? clockOf(p.start) : clockRange(p.start, p.end)}
                      </bdi>
                      <span className={cn(short ? 'truncate' : 'block')}>{p.item.name}</span>
                      {canMove && !phone ? (
                        <span
                          data-resize
                          data-testid="calendar-item-resize"
                          className="absolute inset-x-0 bottom-0 h-[0.4375rem] cursor-ns-resize"
                        />
                      ) : null}
                      {card?.itemId === p.item.id ? card.node : null}
                    </div>
                  );
                })}
                {ghost && draggedItem ? (
                  <div
                    data-testid="calendar-drag-preview"
                    className={cn(
                      'pointer-events-none absolute inset-x-[2px] z-10 overflow-hidden rounded-[6px] px-1.5 py-0.5 text-xs leading-tight shadow-[var(--shadow-pop)]',
                      colorOf(draggedItem) ? '' : 'bg-surface-2 text-fg',
                    )}
                    style={{
                      ...blockStyle(colorOf(draggedItem)),
                      top: ghost.start * pxPerMin,
                      height: Math.max((ghost.end - ghost.start) * pxPerMin - 2, 18),
                    }}
                  >
                    <bdi dir="ltr" className="block text-[0.6875rem] tabular-nums">
                      {clockRange(ghost.start, ghost.end)}
                    </bdi>
                    <span className="block truncate">{draggedItem.name}</span>
                  </div>
                ) : null}
                {(sel && sel.day === d) || (pending && pending.day === d) ? (
                  <PendingBlock
                    range={(sel && sel.day === d ? sel : pending)!}
                    pxPerMin={pxPerMin}
                    panel={sel ? null : panel}
                  />
                ) : null}
                {d === env.today ? (
                  <div
                    className="pointer-events-none absolute inset-x-0 z-[5] border-t-2 border-danger"
                    style={{ top: now * pxPerMin }}
                    data-testid="calendar-now"
                  >
                    <span className="absolute -top-[0.375rem] -start-[0.3125rem] size-2.5 rounded-full bg-danger" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

/** The stretch being made into a new item: its hours, and the panel that names it. */
const PendingBlock = ({
  range,
  pxPerMin,
  panel,
}: {
  range: { start: number; end: number };
  pxPerMin: number;
  panel: ReactNode;
}) => (
  <div
    data-testid="calendar-new-range"
    className="absolute inset-x-[2px] z-[7] rounded-[6px] border-[1.5px] border-primary bg-primary-soft px-1.5 py-0.5 text-xs text-heading"
    style={{ top: range.start * pxPerMin, height: Math.max((range.end - range.start) * pxPerMin - 2, 18) }}
  >
    {t('calendar.newItem')} ·{' '}
    <bdi dir="ltr" className="tabular-nums">
      {clockRange(range.start, range.end)}
    </bdi>
    {panel}
  </div>
);
