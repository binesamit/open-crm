// SPDX-License-Identifier: AGPL-3.0-only
import { dynamicKey, hasMessage, t } from '../i18n';
import type { IsoDate } from '../calendar';
import { formatHebrewDate, formatHebrewSpan, type HebrewDateStyle } from '../workdays/hebrew';
import { countDays, dayInfo, type DayInfo } from '../workdays/workdays';
import type { DurationMode } from '../workdays/settings';
import { getRegion, type Region } from './format';

/**
 * The account calendar in the UI: Hebrew dates, holidays and working days through the region, like
 * the other formatters — components call these without passing the calendar.
 */

/** Whether Hebrew dates show in calendars (pickers, calendar view, timeline axis) or also in table cells. */
export const showHebrewDates = (where: 'calendars' | 'cells', r: Region = getRegion()) =>
  where === 'cells' ? r.calendar.hebrew_dates === 'cells' : r.calendar.hebrew_dates !== 'off';

/**
 * Whether a date picker marks days off and half days with a dot: a column's own choice ('on' / 'off'), else the
 * account's (`picker_marks`).
 */
export const showDayMarks = (own?: 'account' | 'on' | 'off' | null, r: Region = getRegion()) =>
  own === 'on' ? true : own === 'off' ? false : r.calendar.picker_marks === 'dot';

/** A Hebrew date in the region's language ("ט׳ בתשרי תשפ״ז" / "9 Tishrei 5787"). */
export const formatHebrew = (iso: IsoDate, style: HebrewDateStyle = 'full', r: Region = getRegion()) =>
  formatHebrewDate(iso, style, r.language === 'he' ? 'he' : 'en');

/** The Hebrew months under a month title ("אלול – תשרי תשפ״ז"). */
export const formatHebrewMonths = (from: IsoDate, to: IsoDate, r: Region = getRegion()) =>
  formatHebrewSpan(from, to, r.language === 'he' ? 'he' : 'en');

/** A day's weekend flag, holidays and state in the account's calendar. */
export const regionDay = (iso: IsoDate, r: Region = getRegion()): DayInfo => dayInfo(iso, r.calendar, r.weekend);

/** A holiday's or an account day's name, in the region's language. */
export const dayMarkName = (m: DayInfo['marks'][number], r: Region = getRegion()): string => {
  if (m.name) return m.name;
  const key = `holiday.${m.key}`;
  return hasMessage(key) ? t(dynamicKey(key), undefined, r.language) : (m.key ?? '');
};

/** The names of a day's holidays, joined ("ערב יום כיפור"); '' = an ordinary day. */
export const dayMarksText = (iso: IsoDate, r: Region = getRegion()) =>
  regionDay(iso, r)
    .marks.map((m) => dayMarkName(m, r))
    .join(' · ');

/** The duration mode a column uses: its own, else the account's. */
export const durationMode = (own?: DurationMode | 'account' | null, r: Region = getRegion()): DurationMode =>
  own && own !== 'account' ? own : r.calendar.duration;

/** Counted days of an inclusive span in the account calendar. */
export const regionCountDays = (from: IsoDate, to: IsoDate, mode: DurationMode, r: Region = getRegion()) =>
  countDays(from, to, mode, r.calendar, r.weekend);
