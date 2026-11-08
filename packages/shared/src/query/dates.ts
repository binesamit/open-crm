// SPDX-License-Identifier: AGPL-3.0-only
import { isoOf, parseIso, type IsoDate } from '../calendar';
import type { CalendarConfig } from '../workdays/settings';
import { addCountedDays } from '../workdays/workdays';

/**
 * Dynamic date values for filters (13-FILTERS §2): TODAY, THIS_WEEK, … resolve to inclusive date ranges
 * in the account's timezone. An open end is null (PAST = everything before today).
 */
export type DateSpan = { from: IsoDate | null; to: IsoDate | null };

export type DateEnv = {
  /** "Today" in the account timezone. */
  today: IsoDate;
  timezone: string;
  /** Account weekend (08 §2): Israeli Friday+Saturday by default. */
  weekend: 'fri_sat' | 'sat_sun';
  /** First day of the week, 0 = Sunday. */
  firstDay: number;
  /**
   * The account's calendar: with it, "working days" also skip the account's holidays and days off
   * without it, only the weekend.
   */
  calendar?: CalendarConfig;
};

export const DATE_TOKENS = [
  'TODAY',
  'TOMORROW',
  'YESTERDAY',
  'THIS_WEEK',
  'NEXT_WEEK',
  'LAST_WEEK',
  'THIS_MONTH',
  'NEXT_MONTH',
  'LAST_MONTH',
  'THIS_QUARTER',
  'LAST_QUARTER',
  'NEXT_QUARTER',
  'THIS_YEAR',
  'LAST_YEAR',
  'NEXT_YEAR',
  'PAST',
  'FUTURE',
  'OVERDUE',
] as const;
export type DateToken = (typeof DATE_TOKENS)[number];
export const MAX_RELATIVE_DAYS = 3650;
export const relativeDayValue = (dir: 'ago' | 'ahead', n: number) =>
  `${dir === 'ago' ? 'DAYS_AGO' : 'DAYS_AHEAD'}:${Math.min(MAX_RELATIVE_DAYS, Math.max(0, Math.floor(n)))}`;
/** `DAYS_AGO:7` → { dir: 'ago', n: 7 }; null when the value is not one. */
export const parseRelativeDay = (v: unknown): { dir: 'ago' | 'ahead'; n: number } | null => {
  if (typeof v !== 'string') return null;
  const m = /^(DAYS_AGO|DAYS_AHEAD):(\d{1,4})$/.exec(v);
  if (!m) return null;
  const n = Number(m[2]);
  return n <= MAX_RELATIVE_DAYS ? { dir: m[1] === 'DAYS_AGO' ? 'ago' : 'ahead', n } : null;
};
/** A stored filter date value that moves with today (a token or a relative day), as opposed to a fixed date. */
export const isRelativeDateValue = (v: unknown) =>
  (typeof v === 'string' && (DATE_TOKENS as readonly string[]).includes(v)) || parseRelativeDay(v) !== null;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const fmtCache = new Map<string, Intl.DateTimeFormat>();
const formatter = (timeZone: string) => {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    fmtCache.set(timeZone, f);
  }
  return f;
};

/** The calendar date of an instant in a timezone ('YYYY-MM-DD'). */
export const dateInZone = (instant: Date, timeZone: string): IsoDate => formatter(timeZone).format(instant);

/**
 * The local calendar date of a stored date: a plain 'YYYY-MM-DD' is already a calendar date (never shifted);
 * a full ISO instant (date with time, created_at) is converted to the account timezone.
 */
export const localDate = (iso: string, timeZone: string): IsoDate =>
  ISO_RE.test(iso) ? iso : dateInZone(new Date(iso), timeZone);

export const addDays = (iso: IsoDate, n: number): IsoDate => {
  const p = parseIso(iso);
  return isoOf(p.year, p.month, p.day + n);
};

/** Adds months, clamping to the month's last day (Jan 31 + 1 = Feb 28/29). */
export const addMonths = (iso: IsoDate, n: number): IsoDate => {
  const p = parseIso(iso);
  const last = new Date(Date.UTC(p.year, p.month + n + 1, 0)).getUTCDate();
  return isoOf(p.year, p.month + n, Math.min(p.day, last));
};

const weekday = (iso: IsoDate) => {
  const p = parseIso(iso);
  return new Date(Date.UTC(p.year, p.month, p.day)).getUTCDay();
};

export const isWeekend = (iso: IsoDate, weekend: DateEnv['weekend']) => {
  const d = weekday(iso);
  return weekend === 'fri_sat' ? d === 5 || d === 6 : d === 6 || d === 0;
};

/**
 * Moves n working days (n may be negative), skipping the account weekend — and, given the account calendar, its
 * holidays and days off too (the shared working-days engine, mode 'workdays'; without it, mode 'weekdays').
 */
export const addWorkdays = (iso: IsoDate, n: number, weekend: DateEnv['weekend'], calendar?: CalendarConfig): IsoDate =>
  addCountedDays(iso, Math.trunc(n), calendar ? 'workdays' : 'weekdays', calendar, weekend);

const weekStart = (iso: IsoDate, firstDay: number) => addDays(iso, -((weekday(iso) - firstDay + 7) % 7));
const monthStart = (iso: IsoDate) => `${iso.slice(0, 8)}01`;
const monthEnd = (iso: IsoDate) => addDays(addMonths(monthStart(iso), 1), -1);

/** Resolves one filter value (token, `EXACT:<date>` or a plain date) to a span; null = not a date value. */
export const resolveDateValue = (v: unknown, env: DateEnv): DateSpan | null => {
  if (typeof v !== 'string') return null;
  const t = env.today;
  if (ISO_RE.test(v)) return { from: v, to: v };
  if (v.startsWith('EXACT:') && ISO_RE.test(v.slice(6))) return { from: v.slice(6), to: v.slice(6) };
  const rel = parseRelativeDay(v);
  if (rel) {
    const d = addDays(t, rel.dir === 'ago' ? -rel.n : rel.n);
    return { from: d, to: d };
  }
  switch (v as DateToken) {
    case 'TODAY':
      return { from: t, to: t };
    case 'TOMORROW':
      return { from: addDays(t, 1), to: addDays(t, 1) };
    case 'YESTERDAY':
      return { from: addDays(t, -1), to: addDays(t, -1) };
    case 'THIS_WEEK': {
      const s = weekStart(t, env.firstDay);
      return { from: s, to: addDays(s, 6) };
    }
    case 'NEXT_WEEK': {
      const s = addDays(weekStart(t, env.firstDay), 7);
      return { from: s, to: addDays(s, 6) };
    }
    case 'LAST_WEEK': {
      const s = addDays(weekStart(t, env.firstDay), -7);
      return { from: s, to: addDays(s, 6) };
    }
    case 'THIS_MONTH':
      return { from: monthStart(t), to: monthEnd(t) };
    case 'NEXT_MONTH': {
      const s = addMonths(monthStart(t), 1);
      return { from: s, to: monthEnd(s) };
    }
    case 'LAST_MONTH': {
      const s = addMonths(monthStart(t), -1);
      return { from: s, to: monthEnd(s) };
    }
    case 'THIS_QUARTER': {
      const p = parseIso(t);
      const s = isoOf(p.year, p.month - (p.month % 3), 1);
      return { from: s, to: addDays(addMonths(s, 3), -1) };
    }
    case 'LAST_QUARTER':
    case 'NEXT_QUARTER': {
      const p = parseIso(t);
      const s = addMonths(isoOf(p.year, p.month - (p.month % 3), 1), v === 'LAST_QUARTER' ? -3 : 3);
      return { from: s, to: addDays(addMonths(s, 3), -1) };
    }
    case 'THIS_YEAR':
      return { from: `${t.slice(0, 4)}-01-01`, to: `${t.slice(0, 4)}-12-31` };
    case 'LAST_YEAR':
    case 'NEXT_YEAR': {
      const y = String(Number(t.slice(0, 4)) + (v === 'LAST_YEAR' ? -1 : 1)).padStart(4, '0');
      return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    case 'PAST':
    case 'OVERDUE': // the "not done" half is checked by the engine against the deadline's status column
      return { from: null, to: addDays(t, -1) };
    case 'FUTURE':
      return { from: addDays(t, 1), to: null };
    default:
      return null;
  }
};

export const DATE_UNITS = ['days', 'workdays', 'weeks', 'months'] as const;

/** `within_the_last/next: [n, unit]` → the span from n units ago (or ahead) through today. */
export const relativeSpan = (values: unknown[], dir: 'last' | 'next', env: DateEnv): DateSpan | null => {
  const n = Number(values[0]);
  const unit = (values[1] ?? 'days') as (typeof DATE_UNITS)[number];
  if (!Number.isFinite(n) || n < 0 || !DATE_UNITS.includes(unit)) return null;
  const k = dir === 'last' ? -Math.floor(n) : Math.floor(n);
  const t = env.today;
  const other =
    unit === 'days'
      ? addDays(t, k)
      : unit === 'workdays'
        ? addWorkdays(t, k, env.weekend, env.calendar)
        : unit === 'weeks'
          ? addDays(t, k * 7)
          : addMonths(t, k);
  return dir === 'last' ? { from: other, to: t } : { from: t, to: other };
};

/** Whether [a.from, a.to] and [b.from, b.to] share a day (null ends are open). */
export const overlaps = (a: DateSpan, b: DateSpan) =>
  (a.to === null || b.from === null || a.to >= b.from) && (a.from === null || b.to === null || a.from <= b.to);

/**
 * Relative date buckets (13 §4.1 group by date, My Work 07 §9.2) — one definition everywhere: a date is placed
 * relative to today in the account's calendar (week start, month). Chronological order.
 */
export const RELATIVE_BUCKETS = [
  'older',
  'last_month',
  'earlier_this_month',
  'last_week',
  'earlier_this_week',
  'today',
  'this_week',
  'next_week',
  'this_month',
  'next_month',
  'later',
] as const;
export type RelativeBucket = (typeof RELATIVE_BUCKETS)[number];

export const relativeDateBucket = (date: IsoDate, env: DateEnv): RelativeBucket => {
  const span = (token: DateToken) => resolveDateValue(token, env)!;
  if (date === env.today) return 'today';
  if (date < env.today) {
    // The week first: it can start in the previous month.
    if (date >= span('THIS_WEEK').from!) return 'earlier_this_week';
    if (date >= span('LAST_WEEK').from!) return 'last_week';
    if (date >= span('THIS_MONTH').from!) return 'earlier_this_month';
    if (date >= span('LAST_MONTH').from!) return 'last_month';
    return 'older';
  }
  if (date <= span('THIS_WEEK').to!) return 'this_week';
  if (date <= span('NEXT_WEEK').to!) return 'next_week';
  if (date <= span('THIS_MONTH').to!) return 'this_month';
  if (date <= span('NEXT_MONTH').to!) return 'next_month';
  return 'later';
};

/**
 * "When" buckets (grouping by a date — the default): the past is one "overdue" bucket, the near future
 * day by day, then the week, next week, the month, next month and later. Chronological order.
 */
export const WHEN_BUCKETS = [
  'overdue',
  'today',
  'tomorrow',
  'this_week',
  'next_week',
  'this_month',
  'next_month',
  'later',
] as const;
export type WhenBucket = (typeof WHEN_BUCKETS)[number];

export const whenBucket = (date: IsoDate, env: DateEnv): WhenBucket => {
  const span = (token: DateToken) => resolveDateValue(token, env)!;
  if (date < env.today) return 'overdue';
  if (date === env.today) return 'today';
  if (date === addDays(env.today, 1)) return 'tomorrow';
  if (date <= span('THIS_WEEK').to!) return 'this_week';
  if (date <= span('NEXT_WEEK').to!) return 'next_week';
  if (date <= span('THIS_MONTH').to!) return 'this_month';
  if (date <= span('NEXT_MONTH').to!) return 'next_month';
  return 'later';
};

/** A date inside a "when" bucket (a new item added under it, a drag into it); null when the bucket is empty now. */
export const whenBucketDate = (bucket: WhenBucket, env: DateEnv): IsoDate | null => {
  const span = (token: DateToken) => resolveDateValue(token, env)!;
  const after = (d: IsoDate) => addDays(d, 1);
  const tries: Record<WhenBucket, IsoDate[]> = {
    overdue: [addDays(env.today, -1)],
    today: [env.today],
    tomorrow: [after(env.today)],
    this_week: [addDays(env.today, 2)],
    next_week: [span('NEXT_WEEK').from!, after(span('NEXT_WEEK').from!)],
    this_month: [after(span('NEXT_WEEK').to!), addDays(env.today, 2)],
    next_month: [span('NEXT_MONTH').from!, after(span('NEXT_MONTH').from!)],
    later: [after(span('NEXT_MONTH').to!)],
  };
  return tries[bucket].find((d) => whenBucket(d, env) === bucket) ?? null;
};

/** A date inside a bucket (a new item added under it); null when the bucket is empty right now. */
export const relativeBucketDate = (bucket: RelativeBucket, env: DateEnv): IsoDate | null => {
  const span = (token: DateToken) => resolveDateValue(token, env)!;
  const candidate: Record<RelativeBucket, IsoDate> = {
    older: addDays(span('LAST_MONTH').from!, -1),
    last_month: span('LAST_MONTH').from!,
    earlier_this_month: span('THIS_MONTH').from!,
    last_week: span('LAST_WEEK').from!,
    earlier_this_week: span('THIS_WEEK').from!,
    today: env.today,
    this_week: addDays(env.today, 1),
    next_week: span('NEXT_WEEK').from!,
    this_month: addDays(span('NEXT_WEEK').to!, 1),
    next_month: span('NEXT_MONTH').from!,
    later: addDays(span('NEXT_MONTH').to!, 1),
  };
  const d = candidate[bucket];
  return relativeDateBucket(d, env) === bucket ? d : null;
};
