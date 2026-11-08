// SPDX-License-Identifier: AGPL-3.0-only
import { isoOf, parseIso, type IsoDate } from '../calendar';
import { addDays, type DateEnv } from '../query/dates';
import type { CalendarConfig, DurationMode } from '../workdays/settings';
import { countDays, dayWeight, endAfter } from '../workdays/workdays';

/**
 * The shared time axis (M8 ד6): one model for Timeline, Gantt, Workload and (later) dashboard widgets. Dates are
 * plain 'YYYY-MM-DD' strings; positions are offsets from the axis' **inline start** in px — the UI places bars with
 * logical CSS (`inset-inline-start`), so in RTL time flows from right to left by itself. Only pointer math needs the
 * direction (`offsetInAxis`, `dragDays`).
 */

export const ZOOMS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export type Zoom = (typeof ZOOMS)[number];

export type AxisUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Pixels per day at each zoom. */
export const PX_PER_DAY: Record<Zoom, number> = { day: 40, week: 16, month: 5, quarter: 2, year: 0.8 };

/** The two header rows at each zoom: a major unit above, a minor unit below. */
export const HEADER_UNITS: Record<Zoom, { major: AxisUnit; minor: AxisUnit }> = {
  day: { major: 'month', minor: 'day' },
  week: { major: 'month', minor: 'week' },
  month: { major: 'year', minor: 'month' },
  quarter: { major: 'year', minor: 'quarter' },
  year: { major: 'year', minor: 'quarter' },
};

/** How much empty time the axis keeps around the items (in minor units at least this many days). */
const PADDING_DAYS: Record<Zoom, number> = { day: 7, week: 21, month: 60, quarter: 120, year: 365 };
/** The shortest axis at each zoom (an empty board still shows a useful stretch around today). */
const MIN_DAYS: Record<Zoom, number> = { day: 42, week: 112, month: 365, quarter: 730, year: 1460 };
/** The longest axis (a stray date in 1990 must not make a million-pixel canvas). */
export const MAX_AXIS_DAYS = 3660 * 2;

export type Span = { from: IsoDate; to: IsoDate };
/**
 * The columns of a collapsed axis ("working days only"): the days it shows, in order, and each one's
 * column. `start` / `days` still describe the whole calendar stretch (loading, navigation); every position goes
 * through the visible columns.
 */
export type AxisColumns = { list: IsoDate[]; index: Map<IsoDate, number> };
export type Axis = {
  start: IsoDate;
  days: number;
  pxPerDay: number;
  zoom: Zoom;
  firstDay: number;
  /** Set on a collapsed axis only: the visible days. Unset = every day is a column (the plain axis). */
  visible?: AxisColumns;
};

const utc = (iso: IsoDate) => {
  const p = parseIso(iso);
  return Date.UTC(p.year, p.month, p.day);
};

/** Whole days from `a` to `b` (negative when `b` is earlier). */
export const daysBetween = (a: IsoDate, b: IsoDate) => Math.round((utc(b) - utc(a)) / 86_400_000);

/** The first day of the unit that contains `iso` (`firstDay`: the account's week start, 0 = Sunday). */
export const startOfUnit = (iso: IsoDate, unit: AxisUnit, firstDay = 0): IsoDate => {
  const p = parseIso(iso);
  switch (unit) {
    case 'day':
      return iso;
    case 'week': {
      const wd = new Date(utc(iso)).getUTCDay();
      return addDays(iso, -((wd - firstDay + 7) % 7));
    }
    case 'month':
      return isoOf(p.year, p.month, 1);
    case 'quarter':
      return isoOf(p.year, p.month - (p.month % 3), 1);
    case 'year':
      return isoOf(p.year, 0, 1);
  }
};

/** The first day of the next unit after the one containing `iso`. */
export const nextUnit = (iso: IsoDate, unit: AxisUnit, firstDay = 0): IsoDate => {
  const s = parseIso(startOfUnit(iso, unit, firstDay));
  switch (unit) {
    case 'day':
      return addDays(iso, 1);
    case 'week':
      return addDays(startOfUnit(iso, 'week', firstDay), 7);
    case 'month':
      return isoOf(s.year, s.month + 1, 1);
    case 'quarter':
      return isoOf(s.year, s.month + 3, 1);
    case 'year':
      return isoOf(s.year + 1, 0, 1);
  }
};

/**
 * An axis covering `range` (whole major units, with some padding, never shorter than the zoom's minimum nor
 * longer than `MAX_AXIS_DAYS`), centred on `today` when there is nothing to show.
 */
export const buildAxis = (zoom: Zoom, range: Span | null, today: IsoDate, firstDay = 0): Axis => {
  const pad = PADDING_DAYS[zoom];
  let from = range ? (range.from < today ? range.from : today) : today;
  let to = range ? (range.to > today ? range.to : today) : today;
  from = addDays(from, -pad);
  to = addDays(to, pad);
  const missing = MIN_DAYS[zoom] - (daysBetween(from, to) + 1);
  if (missing > 0) {
    from = addDays(from, -Math.floor(missing / 2));
    to = addDays(to, Math.ceil(missing / 2));
  }
  if (daysBetween(from, to) + 1 > MAX_AXIS_DAYS) {
    // Keep today inside: clamp around it.
    const half = Math.floor(MAX_AXIS_DAYS / 2);
    if (daysBetween(from, today) > half) from = addDays(today, -half);
    if (daysBetween(from, to) + 1 > MAX_AXIS_DAYS) to = addDays(from, MAX_AXIS_DAYS - 1);
  }
  const { major } = HEADER_UNITS[zoom];
  const start = startOfUnit(from, major, firstDay);
  const end = nextUnit(to, major, firstDay); // exclusive
  return { start, days: daysBetween(start, end), pxPerDay: PX_PER_DAY[zoom], zoom, firstDay };
};

/** The axis' last day (inclusive). */
export const axisEnd = (axis: Axis) => addDays(axis.start, axis.days - 1);

/**
 * Collapse an axis: leave out every day `hidden` says (a "working days only" view). An axis with nothing left to
 * show (or nothing to leave out) stays as it was.
 */
export const collapseAxis = (axis: Axis, hidden: (iso: IsoDate) => boolean): Axis => {
  const list: IsoDate[] = [];
  for (let i = 0; i < axis.days; i++) {
    const d = addDays(axis.start, i);
    if (!hidden(d)) list.push(d);
  }
  if (!list.length || list.length === axis.days) return axis;
  return { ...axis, visible: { list, index: new Map(list.map((d, i) => [d, i])) } };
};

/**
 * The axis of a "working days only" view: days that count 0 in working days (the weekend, a day off — the shared
 * engine's `dayWeight` in the account calendar) are left out; half days stay.
 */
export const workdaysOnlyAxis = (axis: Axis, calendar: CalendarConfig, weekend: DateEnv['weekend']): Axis =>
  collapseAxis(axis, (d) => dayWeight(d, 'workdays', calendar, weekend) === 0);

/** Whether a day has no column of its own (a collapsed axis leaves it out). */
export const isHiddenDay = (axis: Axis, iso: IsoDate) =>
  !!axis.visible && iso >= axis.start && iso <= axisEnd(axis) && !axis.visible.index.has(iso);

/** How many columns the axis has (its days, or its visible days when collapsed). */
export const axisColumns = (axis: Axis) => axis.visible?.list.length ?? axis.days;

/** The day of column `col` (outside the axis: counted on in calendar days from its first / last column). */
export const dayOfColumn = (axis: Axis, col: number): IsoDate => {
  const v = axis.visible;
  if (!v) return addDays(axis.start, col);
  if (col < 0) return addDays(v.list[0]!, col);
  if (col >= v.list.length) return addDays(v.list.at(-1)!, col - v.list.length + 1);
  return v.list[col]!;
};

/**
 * The column a day begins at. On a collapsed axis a hidden day takes the next visible column (a start on a day
 * off is drawn from the next working day); outside the axis it counts on in calendar days.
 */
export const columnOf = (axis: Axis, iso: IsoDate): number => {
  const v = axis.visible;
  if (!v) return daysBetween(axis.start, iso);
  if (iso < axis.start) return daysBetween(axis.start, iso);
  const at = v.index.get(iso);
  if (at !== undefined) return at;
  const end = axisEnd(axis);
  if (iso > end) return v.list.length + daysBetween(end, iso) - 1;
  // The first visible day after `iso` (binary search; ISO strings sort as dates).
  let lo = 0;
  let hi = v.list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (v.list[mid]! < iso) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/**
 * The day `n` columns after `iso` (n < 0 = before): plain days on a plain axis; visible days on a collapsed one
 * (a drag of three columns over a weekend moves three working days). From a hidden day the first step lands on
 * the next (or the previous) visible day.
 */
export const shiftByColumns = (axis: Axis, iso: IsoDate, n: number): IsoDate => {
  if (!axis.visible || !n) return addDays(iso, n);
  const col = columnOf(axis, iso);
  if (!isHiddenDay(axis, iso)) return dayOfColumn(axis, col + n);
  // `col` is the next visible day: forward it is the first step; backward, the step before it is.
  return dayOfColumn(axis, n > 0 ? col + n - 1 : col + n);
};

/** Total width of the axis in px. */
export const axisWidth = (axis: Axis) => axisColumns(axis) * axis.pxPerDay;

/** Offset (px from the inline start) where a day begins (a hidden day: where the next visible one does). */
export const xOf = (axis: Axis, iso: IsoDate) =>
  axis.visible ? columnOf(axis, iso) * axis.pxPerDay : daysBetween(axis.start, iso) * axis.pxPerDay;

/**
 * A bar's box for an inclusive span: offset from the inline start and width (at least `minWidth`). On a collapsed
 * axis a span starting on a hidden day is drawn from the next visible one, and one ending on a hidden day up to
 * the previous visible one.
 */
export const spanBox = (axis: Axis, span: Span, minWidth = 4) => {
  if (!axis.visible)
    return {
      start: xOf(axis, span.from),
      width: Math.max(minWidth, (daysBetween(span.from, span.to) + 1) * axis.pxPerDay),
    };
  const first = columnOf(axis, span.from);
  const after = columnOf(axis, addDays(span.to, 1)); // the column after the span's last visible day
  return { start: first * axis.pxPerDay, width: Math.max(minWidth, (after - first) * axis.pxPerDay) };
};

/** The day under an offset from the inline start. */
export const dayAt = (axis: Axis, offset: number): IsoDate =>
  axis.visible
    ? dayOfColumn(axis, Math.floor(offset / axis.pxPerDay))
    : addDays(axis.start, Math.floor(offset / axis.pxPerDay));

/** A day inside a span that counts less than a whole day in its column's mode: 0 (a weekend, a day off) or ½. */
export type LightDay = { day: IsoDate; index: number; weight: number };

/**
 * The days of an inclusive span that count less than 1 in `mode` (the gaps drawn in a working-day
 * bar / pill), with their place in the span (`index` 0 = `from`). Weights come from the shared engine
 * (`dayWeight`); calendar mode has none. At most `max` days are walked (a longer span is not drawn day by day).
 */
export const lightDays = (
  span: Span,
  mode: DurationMode,
  calendar: CalendarConfig,
  weekend: DateEnv['weekend'],
  max = 400,
): LightDay[] => {
  if (mode === 'calendar') return [];
  const n = daysBetween(span.from, span.to) + 1;
  if (n <= 0 || n > max) return [];
  const out: LightDay[] = [];
  for (let i = 0; i < n; i++) {
    const day = addDays(span.from, i);
    const weight = dayWeight(day, mode, calendar, weekend);
    if (weight < 1) out.push({ day, index: i, weight });
  }
  return out;
};

/** Days a collapsed axis leaves out: before column `col` (the one after the gap). */
export type AxisSkip = { col: number; days: IsoDate[] };

/** Where a collapsed axis leaves days out, and which (the "skipped" markers); [] on a plain axis. */
export const axisSkips = (axis: Axis): AxisSkip[] => {
  const v = axis.visible;
  if (!v) return [];
  const out: AxisSkip[] = [];
  const run = (after: IsoDate, n: number) => Array.from({ length: n }, (_, i) => addDays(after, i + 1));
  let prev = addDays(axis.start, -1);
  v.list.forEach((d, col) => {
    const gap = daysBetween(prev, d) - 1;
    if (gap > 0) out.push({ col, days: run(prev, gap) });
    prev = d;
  });
  const tail = daysBetween(prev, axisEnd(axis));
  if (tail > 0) out.push({ col: v.list.length, days: run(prev, tail) });
  return out;
};

/**
 * A pointer's offset from the axis' inline start: in RTL the inline start is the box's right edge, so the offset
 * grows to the left.
 */
export const offsetInAxis = (clientX: number, rect: { left: number; right: number }, dir: 'rtl' | 'ltr') =>
  dir === 'rtl' ? rect.right - clientX : clientX - rect.left;

/** Whole days a horizontal drag of `dxClient` screen px moves a bar (RTL: dragging left = later). */
export const dragDays = (dxClient: number, pxPerDay: number, dir: 'rtl' | 'ltr') => {
  const d = Math.round((dir === 'rtl' ? -dxClient : dxClient) / pxPerDay);
  return d === 0 ? 0 : d; // no -0
};

export type DragEdge = 'move' | 'start' | 'end';

/**
 * Keep a moved span's counted length (a timeline column's "keep working days on move"): the
 * mode it counts in and the account's calendar.
 */
export type KeepDays = { mode: DurationMode; calendar: CalendarConfig; weekend: DateEnv['weekend'] };

/**
 * A span after dragging `delta` days: the whole bar, or one edge (resize). An edge never crosses the other —
 * the shortest span is one day. With `keep`, a moved bar keeps its counted days (5 working days stay 5 across a
 * weekend or a holiday) — its end follows from the new start; a span with no counted day moves as is.
 */
export const applyDrag = (
  span: Span,
  delta: number,
  edge: DragEdge,
  keep?: KeepDays | null,
  /** A collapsed axis: `delta` counts its visible columns, mapped back to real dates through them. */
  axis?: Axis | null,
): Span => {
  if (!delta) return span;
  const shift = (iso: IsoDate) => (axis?.visible ? shiftByColumns(axis, iso, delta) : addDays(iso, delta));
  if (edge === 'move') {
    const from = shift(span.from);
    if (keep && keep.mode !== 'calendar') {
      const n = countDays(span.from, span.to, keep.mode, keep.calendar, keep.weekend);
      if (n > 0) return { from, to: endAfter(from, n, keep.mode, keep.calendar, keep.weekend) };
    }
    return { from, to: shift(span.to) };
  }
  if (edge === 'start') {
    const from = shift(span.from);
    return { from: from > span.to ? span.to : from, to: span.to };
  }
  const to = shift(span.to);
  return { from: span.from, to: to < span.from ? span.from : to };
};

export type Tick = { start: IsoDate; days: number; offset: number; width: number };

/** The header cells of one unit across the axis (the first and last are clipped to it). */
export const ticks = (axis: Axis, unit: AxisUnit): Tick[] => {
  const out: Tick[] = [];
  const end = addDays(axis.start, axis.days);
  let cur = startOfUnit(axis.start, unit, axis.firstDay);
  // Guard: never more than one tick per day.
  for (let i = 0; cur < end && i <= axis.days; i++) {
    const next = nextUnit(cur, unit, axis.firstDay);
    const from = cur < axis.start ? axis.start : cur;
    const to = next > end ? end : next;
    if (axis.visible) {
      // Collapsed: the unit's visible columns, starting (and labelled) at its first visible day; a unit with none
      // (a hidden day) has no cell.
      const a = columnOf(axis, from);
      const days = columnOf(axis, to) - a;
      if (days > 0)
        out.push({ start: dayOfColumn(axis, a), days, offset: a * axis.pxPerDay, width: days * axis.pxPerDay });
    } else {
      const days = daysBetween(from, to);
      out.push({ start: from, days, offset: xOf(axis, from), width: days * axis.pxPerDay });
    }
    cur = next;
  }
  return out;
};

/** The quarter (1–4) of a day. */
export const quarterOf = (iso: IsoDate) => Math.floor(parseIso(iso).month / 3) + 1;

/** The smallest span covering all of these (null when none). */
export const spanOfAll = (spans: Iterable<Span | null | undefined>): Span | null => {
  let out: Span | null = null;
  for (const s of spans) {
    if (!s) continue;
    if (!out) out = { ...s };
    else {
      if (s.from < out.from) out.from = s.from;
      if (s.to > out.to) out.to = s.to;
    }
  }
  return out;
};

/**
 * The value written back to a date / timeline cell for a new span: a date keeps its time (one day — `from`); a
 * timeline gets `{from, to}`. `previous` is the stored value (its other keys are kept).
 */
export const spanToValue = (columnType: string, span: Span, previous: unknown): Record<string, unknown> => {
  const prev = (previous && typeof previous === 'object' ? previous : {}) as Record<string, unknown>;
  if (columnType === 'timeline') return { ...prev, from: span.from, to: span.to };
  return { ...prev, date: span.from };
};
