// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, dateInZone, localDate, type DateEnv } from '../query/dates';
import type { CalendarConfig } from '../workdays/settings';
import { addCountedDays } from '../workdays/workdays';
import { zonedToUtc } from './date-expr';
import type { Trigger } from './schema';
import { WEEKDAYS } from './schema';

/**
 * 04 §5.6 — when scheduled triggers fire. Times are wall-clock in the account timezone, stored as UTC instants
 * (DST-safe: every fire is recomputed in local time).
 */
export type DateTrigger = Extract<Trigger, { type: 'date_arrived' | 'date_arrives_before' }>;
export type PeriodTrigger = Extract<Trigger, { type: 'every_time_period' }>;

export const isDateTrigger = (t: Trigger): t is DateTrigger =>
  t.type === 'date_arrived' || t.type === 'date_arrives_before';

const offsetOf = (t: DateTrigger) => (t.type === 'date_arrives_before' ? -t.days : t.offset_days);

/** The account weekend and calendar a date trigger counts working days in. */
export type WorkCalendar = { weekend: DateEnv['weekend']; calendar: CalendarConfig };

/** The day a trigger fires on: the date moved by the offset — in working days when the trigger says so. */
const shiftDay = (t: DateTrigger, day: string, work?: WorkCalendar) =>
  t.workdays ? addCountedDays(day, offsetOf(t), 'workdays', work?.calendar, work?.weekend) : addDays(day, offsetOf(t));

/**
 * The fire instant for a stored date (`YYYY-MM-DD`, or a full ISO instant when the cell has a time): the date
 * moved by the offset, at the trigger's time — or, for a date with its own time, that moment moved by the offset.
 */
export const dateFireAt = (t: DateTrigger, stored: string, timeZone: string, work?: WorkCalendar): Date => {
  if (stored.length > 10) {
    // The same wall-clock time n days on, in the account's zone — not n × 24 h, which drifts an hour when the
    // offset crosses a DST change (audit worker #10).
    const instant = new Date(stored);
    const minute = zonedToUtc(shiftDay(t, localDate(stored, timeZone), work), clockIn(instant, timeZone), timeZone);
    // The stored moment's seconds and milliseconds are kept (a "last updated" column is such a moment; zone
    // offsets are whole minutes), so an offset of 0 is the moment itself.
    return new Date(minute.getTime() + (instant.getTime() % 60_000));
  }
  return zonedToUtc(shiftDay(t, stored, work), t.time, timeZone);
};

/** `HH:MM` of an instant in a timezone. */
const clockIn = (instant: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(instant);

/**
 * s4f: the date a trigger reads from a column computed from the item (last updated — of chosen columns too —
 * creation log): an instant, read the way the board shows it. A column that shows the time is that moment (like
 * a date cell with a time); otherwise its calendar date in the account timezone, at the trigger's time.
 */
export const computedTriggerDate = (at: string, showTime: boolean, timeZone: string): string =>
  showTime ? at : dateInZone(new Date(at), timeZone);

/** What a schedule row was computed from: a changed date or a changed recipe re-arms it. */
export const dateScheduleHash = (t: DateTrigger, stored: string) =>
  `${stored}|${offsetOf(t)}${t.workdays ? 'wd' : ''}|${t.time}`;

/** A date that is already due when it is set fires once only if it is a "day of / after" trigger and ≤24h late. */
export const firesWhenLate = (t: DateTrigger, fireAt: Date, now: Date) =>
  offsetOf(t) <= 0 && now.getTime() - fireAt.getTime() <= 86_400_000;

/** The first fire of an `every_time_period` trigger strictly after `after` (missed periods are not replayed). */
export const nextPeriodFire = (t: PeriodTrigger, after: Date, timeZone: string): Date => {
  if (t.period === 'hour') {
    // Minute 0 of the next hour (whole-hour timezones, like the account default).
    const next = new Date(after.getTime());
    next.setUTCMinutes(0, 0, 0);
    return new Date(next.getTime() + 3_600_000);
  }
  const today = dateInZone(after, timeZone);
  const at = (date: string) => zonedToUtc(date, t.time, timeZone);
  const later = (date: string) => at(date).getTime() > after.getTime();
  if (t.period === 'day') return later(today) ? at(today) : at(addDays(today, 1));
  if (t.period === 'week') {
    const want = WEEKDAYS.indexOf(t.weekday ?? 'sun');
    const [y, m, d] = today.split('-').map(Number) as [number, number, number];
    const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    let date = addDays(today, (want - dow + 7) % 7);
    if (!later(date)) date = addDays(date, 7);
    return at(date);
  }
  // The day clamped to the month's length: "on the 31st" is the last day of a shorter month. An unclamped
  // `2026-02-31` rolled over to March 3 and fired twice in March, never in February (audit 2026-10-10 A2).
  const [y, m] = today.split('-').map(Number) as [number, number];
  const inMonth = (year: number, month: number) => {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = Math.min(t.day_of_month ?? 1, last);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
  let date = inMonth(y, m);
  if (!later(date)) date = m === 12 ? inMonth(y + 1, 1) : inMonth(y, m + 1);
  return at(date);
};
