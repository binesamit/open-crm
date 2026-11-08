// SPDX-License-Identifier: AGPL-3.0-only
import { isoOf, parseIso, type IsoDate } from '../calendar';
import { isWeekend, type DateEnv } from '../query/dates';
import { holidaysOn, type DayState } from './holidays';
import { DEFAULT_CALENDAR, type CalendarConfig, type DurationMode } from './settings';

/**
 * Working days — THE one place that decides whether a day counts. A timeline's duration, "+N
 * working days" in automations and "N working days before", a dependency lag, the WORKDAYS formula, the "next N
 * working days" filter and the workload view all go through these functions. Plain 'YYYY-MM-DD' math (no Date
 * objects across boundaries), so no timezone can move a day.
 */
type Weekend = DateEnv['weekend'];

/** A day as calendars show it: its holidays (and the account's own days) with their states. */
export type DayInfo = {
  weekend: boolean;
  /** Holiday keys and custom-day names on this day, each with its state ('ignore' ones left out). */
  marks: { key?: string; name?: string; state: Exclude<DayState, 'ignore'> }[];
  /** The day's state: an account's own day wins, then the strongest holiday (off > half > work); null = ordinary. */
  state: Exclude<DayState, 'ignore'> | null;
};

const RANK = { off: 3, half: 2, work: 1 } as const;

const addDays = (iso: IsoDate, n: number): IsoDate => {
  const p = parseIso(iso);
  return isoOf(p.year, p.month, p.day + n);
};

export const dayInfo = (
  iso: IsoDate,
  cfg: CalendarConfig = DEFAULT_CALENDAR,
  weekend: Weekend = 'fri_sat',
): DayInfo => {
  const marks: DayInfo['marks'] = [];
  let state: DayInfo['state'] = null;
  for (const key of holidaysOn(cfg.holiday_set, iso)) {
    const s = cfg.holidays[key] ?? 'ignore';
    if (s === 'ignore') continue;
    marks.push({ key, state: s });
    if (!state || RANK[s] > RANK[state]) state = s;
  }
  for (const c of cfg.custom_days) {
    if (iso < c.date || iso > (c.to && c.to >= c.date ? c.to : c.date)) continue;
    marks.push({ name: c.name, state: c.state });
    state = c.state;
  }
  return { weekend: isWeekend(iso, weekend), marks, state };
};

/** How much one day counts in a mode: 1, ½ (a half day, if the account counts it so) or 0. */
export const dayWeight = (
  iso: IsoDate,
  mode: DurationMode,
  cfg: CalendarConfig = DEFAULT_CALENDAR,
  weekend: Weekend = 'fri_sat',
): number => {
  if (mode === 'calendar') return 1;
  if (isWeekend(iso, weekend)) return 0;
  if (mode === 'weekdays') return 1;
  const { state } = dayInfo(iso, cfg, weekend);
  if (state === 'off') return 0;
  if (state === 'half') return cfg.half_day === 'half' ? 0.5 : cfg.half_day === 'work' ? 1 : 0;
  return 1;
};

/** Whether a day is a working day (counts at all) in a mode. */
export const isWorkday = (iso: IsoDate, mode: DurationMode, cfg?: CalendarConfig, weekend?: Weekend) =>
  dayWeight(iso, mode, cfg, weekend) > 0;

/** Longest span walked day by day (about 27 years): a guard against a runaway loop on bad input. */
const MAX_STEPS = 10_000;

/**
 * The days counted in an inclusive span (from ≤ to; reversed = the negative count). Calendar mode is the plain
 * day count (25/09–26/09 = 2).
 */
export const countDays = (
  from: IsoDate,
  to: IsoDate,
  mode: DurationMode,
  cfg: CalendarConfig = DEFAULT_CALENDAR,
  weekend: Weekend = 'fri_sat',
): number => {
  if (to < from) return -countDays(to, from, mode, cfg, weekend);
  let n = 0;
  let steps = 0;
  for (let d = from; d <= to && steps < MAX_STEPS; d = addDays(d, 1), steps++) n += dayWeight(d, mode, cfg, weekend);
  return n;
};

/**
 * The day `n` counted days after `iso` (n < 0 = before); `iso` itself is not counted. Calendar mode = plain days.
 * Lands only on a day that counts (a half day counts as its weight; landing needs the whole amount).
 */
export const addCountedDays = (
  iso: IsoDate,
  n: number,
  mode: DurationMode,
  cfg: CalendarConfig = DEFAULT_CALENDAR,
  weekend: Weekend = 'fri_sat',
): IsoDate => {
  if (mode === 'calendar' || !n) return addDays(iso, Math.trunc(n));
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  let d = iso;
  for (let steps = 0; left > 1e-9 && steps < MAX_STEPS; steps++) {
    d = addDays(d, step);
    left -= dayWeight(d, mode, cfg, weekend);
  }
  return d;
};

/**
 * The end of a span that starts on `from` and lasts `count` counted days (the start counts if it is a working
 * day): moving a timeline bar keeps its working days. A span shorter than one day ends on its start.
 */
export const endAfter = (
  from: IsoDate,
  count: number,
  mode: DurationMode,
  cfg: CalendarConfig = DEFAULT_CALENDAR,
  weekend: Weekend = 'fri_sat',
): IsoDate => {
  if (mode === 'calendar') return addDays(from, Math.max(0, Math.ceil(count) - 1));
  let d = from;
  let acc = dayWeight(d, mode, cfg, weekend);
  for (let steps = 0; acc < count - 1e-9 && steps < MAX_STEPS; steps++) {
    d = addDays(d, 1);
    acc += dayWeight(d, mode, cfg, weekend);
  }
  return d;
};

/** The next day on or after `iso` that counts (a start that falls on a day off moves forward). */
export const nextWorkday = (iso: IsoDate, mode: DurationMode, cfg?: CalendarConfig, weekend?: Weekend): IsoDate => {
  let d = iso;
  for (let steps = 0; !isWorkday(d, mode, cfg, weekend) && steps < MAX_STEPS; steps++) d = addDays(d, 1);
  return d;
};
