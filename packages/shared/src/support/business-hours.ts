// SPDX-License-Identifier: AGPL-3.0-only
import { zonedToUtc } from '../automations/date-expr';

/**
 * Business hours for support SLA timers (stage 5): the platform's working days and hours in one
 * timezone, and its holidays. Everything is a setting (owner console → Support → Settings); nothing is fixed here.
 */
export type BusinessHours = {
  timezone: string;
  /** Working windows; `day` 0 = Sunday. Several windows on one day are allowed (e.g. a lunch break). */
  days: { day: number; start: string; end: string }[];
  /** Local dates (YYYY-MM-DD) with no working hours. */
  holidays: string[];
};

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** The local calendar date (YYYY-MM-DD) of an instant in a timezone. */
export const localDateIn = (at: Date, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
};

const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

const safeZoned = (date: string, time: string, timeZone: string) => {
  try {
    return zonedToUtc(date, time, timeZone);
  } catch {
    return new Date(`${date}T${time}:00Z`);
  }
};

/** The windows of one local date as UTC instants, earliest first (none on a holiday or a day off). */
const windowsOf = (date: string, hours: BusinessHours) => {
  if (hours.holidays.includes(date)) return [];
  const day = weekday(date);
  return hours.days
    .filter((w) => w.day === day && w.end > w.start)
    .map((w) => ({ start: safeZoned(date, w.start, hours.timezone), end: safeZoned(date, w.end, hours.timezone) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
};

/** Are there any working hours at all (else the timers run on the wall clock)? */
export const hasBusinessHours = (hours: BusinessHours | null | undefined): hours is BusinessHours =>
  !!hours && hours.days.some((w) => w.end > w.start);

/**
 * The instant `minutes` working minutes after `start`. Without business hours (or `useHours` false) it is plain
 * wall-clock time. Looks at most two years ahead (a calendar of holidays only falls back to the wall clock).
 */
export const addBusinessMinutes = (
  start: Date,
  minutes: number,
  hours: BusinessHours | null | undefined,
  useHours = true,
): Date => {
  if (!useHours || !hasBusinessHours(hours) || minutes <= 0) return new Date(start.getTime() + minutes * MINUTE_MS);
  let remaining = minutes * MINUTE_MS;
  let date = localDateIn(start, hours.timezone);
  for (let i = 0; i < 730; i++) {
    for (const w of windowsOf(date, hours)) {
      const from = Math.max(start.getTime(), w.start.getTime());
      if (from >= w.end.getTime()) continue;
      const available = w.end.getTime() - from;
      if (remaining <= available) return new Date(from + remaining);
      remaining -= available;
    }
    date = nextDate(date);
  }
  return new Date(start.getTime() + minutes * MINUTE_MS);
};

/** Working minutes between two instants (0 when `to` is not after `from`). */
export const businessMinutesBetween = (
  from: Date,
  to: Date,
  hours: BusinessHours | null | undefined,
  useHours = true,
): number => {
  if (to <= from) return 0;
  if (!useHours || !hasBusinessHours(hours)) return Math.round((to.getTime() - from.getTime()) / MINUTE_MS);
  let total = 0;
  let date = localDateIn(from, hours.timezone);
  const last = localDateIn(to, hours.timezone);
  for (let i = 0; i < 730; i++) {
    for (const w of windowsOf(date, hours)) {
      const a = Math.max(from.getTime(), w.start.getTime());
      const b = Math.min(to.getTime(), w.end.getTime());
      if (b > a) total += b - a;
    }
    if (date >= last) break;
    date = nextDate(date);
  }
  return Math.round(total / MINUTE_MS);
};
