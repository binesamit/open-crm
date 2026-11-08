// SPDX-License-Identifier: AGPL-3.0-only
import { addDays, addMonths, localDate, type DateEnv } from '../query/dates';
import type { CalendarConfig } from '../workdays/settings';
import { addCountedDays } from '../workdays/workdays';
import { DATE_EXPR_RE, dateExprShift } from './schema';

/**
 * `set_date` expressions (04 §4.2): `today`, `now`, `clear`, `column:<key>`, then `±N(h|d|wd|w|m)` and `@HH:MM`.
 * Calendar units in the account timezone; `wd` = working days of the account calendar (the shared engine). `now` keeps the current UTC time (date cells store UTC time, 03 §2.7).
 * Hours (`now+4h`, an SLA) move the instant; on a date without a time they count whole days only.
 */
export type DateExprEnv = {
  /** "Today" in the account timezone. */
  today: string;
  timezone: string;
  now: Date;
  /** The stored date of a column on the item (`YYYY-MM-DD` or a full ISO instant); null = empty. */
  columnDate: (key: string) => string | null;
  /** The account weekend and calendar, for `wd` (working days); Friday+Saturday and the defaults when absent. */
  weekend?: DateEnv['weekend'];
  calendar?: CalendarConfig;
};

/** A date cell value, `null` = clear, `undefined` = the expression cannot be evaluated (empty source column). */
export type DateExprValue = { date: string; time?: string } | null | undefined;

const hhmm = (d: Date) => d.toISOString().slice(11, 16);

export const evaluateDateExpr = (expr: string, env: DateExprEnv): DateExprValue => {
  const m = DATE_EXPR_RE.exec(expr);
  if (!m) return undefined;
  const [, base, shift, at] = m;
  if (base === 'clear') return null;
  let date: string;
  let time: string | undefined;
  if (base === 'today') date = env.today;
  else if (base === 'now') {
    date = env.now.toISOString().slice(0, 10);
    time = hhmm(env.now);
  } else {
    const raw = env.columnDate(base!.slice('column:'.length));
    if (!raw) return undefined;
    // A cell with a time is an instant: its calendar day is the account's local day when the expression goes on
    // to a wall-clock time (`@HH:MM`) or moves by days / weeks / months. The UTC day was taken before (audit
    // 2026-10-10, automations #9): `column:x@09:00` on 22:30Z in Israel gave the day before.
    const byLocalDay = raw.length > 10 && (!!at || (!!shift && shift.slice(-1) !== 'h'));
    date = raw.length > 10 ? (byLocalDay ? localDay(raw, env.timezone) : raw.slice(0, 10)) : raw;
    if (raw.length > 10) time = raw.slice(11, 16);
  }
  if (shift) {
    const { n, unit } = dateExprShift(shift);
    if (unit === 'h') {
      if (time) {
        const moved = new Date(new Date(`${date}T${time}:00Z`).getTime() + n * 3_600_000);
        date = moved.toISOString().slice(0, 10);
        time = hhmm(moved);
      } else date = addDays(date, Math.trunc(n / 24));
    } else if (unit === 'wd') date = addCountedDays(date, n, 'workdays', env.calendar, env.weekend);
    else date = unit === 'd' ? addDays(date, n) : unit === 'w' ? addDays(date, n * 7) : addMonths(date, n);
  }
  if (at) {
    // `@HH:MM` is local time in the account timezone → stored as UTC.
    const local = at.slice(1);
    const utc = zonedToUtc(date, local, env.timezone);
    return { date: utc.toISOString().slice(0, 10), time: hhmm(utc) };
  }
  return time ? { date, time } : { date };
};

/** The UTC instant of a local wall-clock time in a timezone (DST-safe: corrects by the zone offset twice). */
export const zonedToUtc = (date: string, time: string, timeZone: string): Date => {
  const guess = new Date(`${date}T${time}:00Z`);
  const offset = (d: Date) => {
    const local = new Date(d.toLocaleString('en-US', { timeZone }));
    const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    return local.getTime() - utc.getTime();
  };
  const first = new Date(guess.getTime() - offset(guess));
  return new Date(guess.getTime() - offset(first));
};

/** The local calendar day of a stored date (plain dates are never shifted). */
export const localDay = (iso: string, timeZone: string) => localDate(iso, timeZone);
