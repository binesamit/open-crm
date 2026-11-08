// SPDX-License-Identifier: AGPL-3.0-only
import type { IsoDate } from '../calendar';
import { addDays, isWeekend, type DateEnv } from '../query/dates';
import { localDateValue, storedDateValue, type Region } from '../locale/format';
import type { CalendarMode, CalendarViewSettings } from './settings';

/**
 * the calendar by the hour — which days a range shows, when an item starts and ends (from a timeline
 * "with hours" or from a date plus hour columns), the cells a move / resize writes, and the side-by-side layout of
 * items that overlap. Pure: the view (apps/web CalendarView) renders what these return.
 *
 * Times here are minutes from midnight, wall-clock in the account's zone. A date column's own time is stored as
 * UTC (03 §2.7) and is read and written through the region; a timeline's times and hour columns are wall-clock.
 */

export const DAY_MINUTES = 24 * 60;

/** "09:30" → 570. */
export const minutesOf = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
/** 570 → "09:30" (a whole day, 1440, is "24:00"). */
export const hmOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The nearest step of `snap` minutes. */
export const snapMinutes = (minutes: number, snap: number) => Math.round(minutes / snap) * snap;

/** An hour column's value as minutes (`{hour, minute}`); anything else = none. */
const hourMinutes = (v: unknown): number | null => {
  const h = v as { hour?: unknown; minute?: unknown } | null | undefined;
  return typeof h?.hour === 'number' && typeof h.minute === 'number' ? h.hour * 60 + h.minute : null;
};
const hourValue = (minutes: number) => {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  return { hour: Math.floor(m / 60), minute: m % 60 };
};

const daysBetween = (a: IsoDate, b: IsoDate) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// ---------------------------------------------------------------------------------------------------------------
// Days on screen
// ---------------------------------------------------------------------------------------------------------------

/**
 * The days a range shows around `anchor`: a day; three days from it; its week (from the account's first weekday);
 * its work week (that week without the weekend). `showWeekends: false` drops the weekend from a week too.
 */
export const calendarRangeDays = (
  mode: Exclude<CalendarMode, 'month'>,
  anchor: IsoDate,
  env: Pick<DateEnv, 'firstDay' | 'weekend'>,
  showWeekends = true,
): IsoDate[] => {
  if (mode === 'day') return [anchor];
  if (mode === '3day') return [anchor, addDays(anchor, 1), addDays(anchor, 2)];
  const wd = new Date(`${anchor}T00:00:00Z`).getUTCDay();
  const start = addDays(anchor, -((wd - env.firstDay + 7) % 7));
  const week = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return mode === 'workweek' || !showWeekends ? week.filter((d) => !isWeekend(d, env.weekend)) : week;
};

/** How far the arrows move a range: a day, three days, a week. */
export const calendarStep = (mode: CalendarMode) => (mode === 'day' ? 1 : mode === '3day' ? 3 : 7);

// ---------------------------------------------------------------------------------------------------------------
// Reading an item's hours
// ---------------------------------------------------------------------------------------------------------------

/** Where the view reads an item's time (from its settings and the board's column types). */
export type CalendarTimeConfig = {
  source: CalendarViewSettings['time_source'];
  /** The view's date / timeline column. */
  dateColumnId: string;
  startColumnId?: string | null;
  endColumnId?: string | null;
  /** Minutes an item with a start and no end lasts. */
  defaultDuration: number;
};

/** An item in hours: its first day and start, its last day and end (minutes, wall-clock). */
export type TimedSpan = { day: IsoDate; start: number; endDay: IsoDate; end: number };

type Cells = Record<string, { value: unknown } | undefined>;
type DateLike = { date?: IsoDate; time?: string; from?: IsoDate; to?: IsoDate; from_time?: string; to_time?: string };

const valueOf = (cells: Cells, id?: string | null) => (id ? (cells[id]?.value as DateLike | null | undefined) : null);

/** The item's span in hours, or null when it has none (it shows among the day's all-day items). */
export const readTimedSpan = (cells: Cells, cfg: CalendarTimeConfig, region?: Region): TimedSpan | null => {
  const v = valueOf(cells, cfg.dateColumnId);
  if (!v) return null;
  if (cfg.source === 'timeline') {
    if (!v.from || !v.to || !v.from_time || !v.to_time) return null;
    return { day: v.from, start: minutesOf(v.from_time), endDay: v.to, end: minutesOf(v.to_time) };
  }
  // A date and hour columns; a date's own time (UTC) counts as the start when there is no start column.
  const local = v.date ? localDateValue({ date: v.date, time: v.time }, region) : v.from ? { date: v.from } : null;
  if (!local) return null;
  const start =
    hourMinutes(cfg.startColumnId ? cells[cfg.startColumnId]?.value : null) ??
    (local.time ? minutesOf(local.time) : null);
  if (start === null) return null;
  const endCell = hourMinutes(cfg.endColumnId ? cells[cfg.endColumnId]?.value : null);
  let end = endCell ?? start + cfg.defaultDuration;
  let endDay = local.date;
  // An end at or before the start is the next day (22:00 – 01:00); a default length can run past midnight too.
  if (endCell !== null && end <= start) end += DAY_MINUTES;
  while (end > DAY_MINUTES) {
    end -= DAY_MINUTES;
    endDay = addDays(endDay, 1);
  }
  return { day: local.date, start, endDay, end };
};

/** A span inside one day (drawn in the hours); longer ones show among the all-day items, like most calendars. */
export const isSameDaySpan = (s: TimedSpan) => s.day === s.endDay || (addDays(s.day, 1) === s.endDay && s.end === 0);

/** Its length in minutes. */
export const spanMinutes = (s: TimedSpan) => daysBetween(s.day, s.endDay) * DAY_MINUTES + s.end - s.start;

// ---------------------------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------------------------

/**
 * The cells that put an item at `day` from `start` for `length` minutes — a move, a resize, a new item, or giving an
 * all-day item hours. `current` is the item's cells (kept where the move leaves them, e.g. a milestone mark).
 */
export const timedCells = (
  cfg: CalendarTimeConfig,
  current: Cells,
  day: IsoDate,
  start: number,
  length: number,
  region?: Region,
): Record<string, unknown> => {
  const endAbs = start + Math.max(1, length);
  const endDay = addDays(day, Math.floor((endAbs - 1) / DAY_MINUTES));
  const end = endAbs - daysBetween(day, endDay) * DAY_MINUTES;
  const v = valueOf(current, cfg.dateColumnId) ?? {};
  if (cfg.source === 'timeline') {
    const { milestone } = v as { milestone?: boolean };
    return {
      [cfg.dateColumnId]: {
        from: day,
        to: endDay,
        from_time: hmOf(start),
        to_time: hmOf(end),
        ...(milestone ? { milestone } : {}),
      },
    };
  }
  const out: Record<string, unknown> = {};
  // A timeline used as the date (date_hours source): the days move, its length in days kept.
  if (v.from && v.to && !v.date) out[cfg.dateColumnId] = { from: day, to: addDays(day, daysBetween(v.from, v.to)) };
  else if (cfg.startColumnId) {
    // The time lives in the start column; a date that also had its own time keeps that time on the new day.
    const local = v.date ? localDateValue({ date: v.date, time: v.time }, region) : null;
    out[cfg.dateColumnId] = local?.time ? storedDateValue(day, local.time, region) : { date: day };
  } else out[cfg.dateColumnId] = storedDateValue(day, hmOf(start), region);
  if (cfg.startColumnId) out[cfg.startColumnId] = hourValue(start);
  if (cfg.endColumnId) out[cfg.endColumnId] = hourValue(end);
  return out;
};

/** The cells that make an item all-day on `day` (dropped on the all-day strip): no hours left. */
export const allDayCells = (cfg: CalendarTimeConfig, current: Cells, day: IsoDate): Record<string, unknown> => {
  const v = valueOf(current, cfg.dateColumnId) ?? {};
  if (cfg.source === 'timeline') {
    const len = v.from && v.to ? daysBetween(v.from, v.to) : 0;
    return { [cfg.dateColumnId]: { from: day, to: addDays(day, len) } };
  }
  const out: Record<string, unknown> = {
    [cfg.dateColumnId]:
      v.from && v.to && !v.date ? { from: day, to: addDays(day, daysBetween(v.from, v.to)) } : { date: day },
  };
  if (cfg.startColumnId) out[cfg.startColumnId] = null;
  if (cfg.endColumnId) out[cfg.endColumnId] = null;
  return out;
};

// ---------------------------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------------------------

/**
 * Items that overlap stand side by side: each cluster of touching items is split into as many columns as it needs at
 * its busiest, and each item takes the first column free at its start.
 */
export const layoutOverlaps = <T extends { id: string; start: number; end: number }>(
  list: T[],
): Map<string, { col: number; cols: number }> => {
  const sorted = [...list].sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));
  const out = new Map<string, { col: number; cols: number }>();
  let cluster: { id: string; col: number }[] = [];
  let ends: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const x of cluster) out.set(x.id, { col: x.col, cols: ends.length });
    cluster = [];
    ends = [];
  };
  for (const ev of sorted) {
    if (ev.start >= clusterEnd) {
      flush();
      clusterEnd = -1;
    }
    let col = ends.findIndex((end) => end <= ev.start);
    if (col < 0) {
      col = ends.length;
      ends.push(ev.end);
    } else ends[col] = ev.end;
    cluster.push({ id: ev.id, col });
    clusterEnd = Math.max(clusterEnd, ev.end);
  }
  flush();
  return out;
};

/**
 * Items over several days as bars across a row of days (a week of the month, the all-day strip): the first and last
 * day each covers in the row (indexes), the lane it sits in, and whether it carries on before / after the row.
 */
export const dayBars = <T extends { id: string; from: IsoDate; to: IsoDate }>(
  list: T[],
  days: IsoDate[],
  /** How items that start and end on the same days are ordered (e.g. by their time). */
  tie?: (a: T, b: T) => number,
): { item: T; first: number; last: number; lane: number; before: boolean; after: boolean }[] => {
  if (!days.length) return [];
  const rowFirst = days[0]!;
  const rowLast = days.at(-1)!;
  const index = (d: IsoDate, edge: 'first' | 'last') => {
    const i = days.indexOf(d);
    if (i >= 0) return i;
    // A day the row skips (a hidden weekend): the next shown day for a start, the one before for an end.
    if (edge === 'first') return days.findIndex((x) => x > d);
    for (let k = days.length - 1; k >= 0; k--) if (days[k]! < d) return k;
    return -1;
  };
  const shown = list
    .filter((x) => x.to >= rowFirst && x.from <= rowLast)
    .sort(
      (a, b) => a.from.localeCompare(b.from) || b.to.localeCompare(a.to) || tie?.(a, b) || a.id.localeCompare(b.id),
    );
  const lanes: number[] = [];
  const out: ReturnType<typeof dayBars<T>> = [];
  for (const item of shown) {
    const first = index(item.from < rowFirst ? rowFirst : item.from, 'first');
    const last = index(item.to > rowLast ? rowLast : item.to, 'last');
    if (first < 0 || last < first) continue;
    let lane = lanes.findIndex((end) => end < first);
    if (lane < 0) {
      lane = lanes.length;
      lanes.push(last);
    } else lanes[lane] = last;
    out.push({ item, first, last, lane, before: item.from < rowFirst, after: item.to > rowLast });
  }
  return out;
};
