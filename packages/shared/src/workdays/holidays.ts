// SPDX-License-Identifier: AGPL-3.0-only
import { isoOf, parseIso, type IsoDate } from '../calendar';
import { hebrewDate, type HebrewDate } from './hebrew';

/**
 * Holiday sets: a holiday set is data, a list of named days each with a default state. The Israeli
 * set is the first; a set is chosen per account (owner console default), every day's state can be changed, and
 * an account adds its own days on top (company days). Nothing outside this file knows which holidays exist.
 *
 * Day states:
 * - off: a day off (not a working day);
 * - half: a half day (an eve of a holiday) — counted as the account's `half_day` setting says;
 * - work: a working day that is marked on calendars;
 * - ignore: not shown and not counted.
 */
export const DAY_STATES = ['off', 'half', 'work', 'ignore'] as const;
export type DayState = (typeof DAY_STATES)[number];

type Rule = (h: HebrewDate, weekday: number, iso: IsoDate) => boolean;
export type HolidayDef = { key: string; state: DayState; rule: Rule };

const on =
  (month: HebrewDate['month'] | HebrewDate['month'][], ...days: number[]): Rule =>
  (h) =>
    (Array.isArray(month) ? month.includes(h.month) : h.month === month) && days.includes(h.day);
/** A fast moved off Shabbat to Sunday (Gedaliah, 17 Tammuz, 9 Av). */
const fastSunday =
  (month: HebrewDate['month'], day: number): Rule =>
  (h, wd) =>
    h.month === month && ((h.day === day && wd !== 6) || (h.day === day + 1 && wd === 0));
const ADAR: HebrewDate['month'][] = ['adar', 'adar2'];

const addDays = (iso: IsoDate, n: number) => {
  const p = parseIso(iso);
  return isoOf(p.year, p.month, p.day + n);
};

/** The Israeli holidays, in the year's order (Tishrei first). Default states as approved on the item. */
export const ISRAEL_HOLIDAYS: HolidayDef[] = [
  { key: 'erev_rosh_hashana', state: 'half', rule: on('elul', 29) },
  { key: 'rosh_hashana', state: 'off', rule: on('tishri', 1, 2) },
  { key: 'fast_gedaliah', state: 'work', rule: fastSunday('tishri', 3) },
  { key: 'erev_yom_kippur', state: 'half', rule: on('tishri', 9) },
  { key: 'yom_kippur', state: 'off', rule: on('tishri', 10) },
  { key: 'erev_sukkot', state: 'half', rule: on('tishri', 14) },
  { key: 'sukkot', state: 'off', rule: on('tishri', 15) },
  { key: 'chol_hamoed_sukkot', state: 'work', rule: on('tishri', 16, 17, 18, 19, 20) },
  { key: 'hoshana_raba', state: 'half', rule: on('tishri', 21) },
  { key: 'shmini_atzeret', state: 'off', rule: on('tishri', 22) },
  {
    key: 'hanukkah',
    state: 'work',
    // 25 Kislev for eight days; Kislev has 29 or 30 days, so it ends on 2 or 3 Tevet.
    rule: (h, _wd, iso) => {
      if (h.month === 'kislev') return h.day >= 25;
      if (h.month !== 'tevet' || h.day > 3) return false;
      const kislevLength = hebrewDate(addDays(iso, -h.day)).day;
      return h.day <= 8 - (kislevLength - 24);
    },
  },
  { key: 'fast_tevet', state: 'work', rule: on('tevet', 10) },
  { key: 'tu_bishvat', state: 'work', rule: on('shevat', 15) },
  {
    key: 'fast_esther',
    state: 'work',
    // 13 Adar; on Shabbat it moves back to Thursday.
    rule: (h, wd) => ADAR.includes(h.month) && ((h.day === 13 && wd !== 6) || (h.day === 11 && wd === 4)),
  },
  { key: 'purim', state: 'work', rule: on(ADAR, 14) },
  { key: 'erev_pesach', state: 'half', rule: on('nisan', 14) },
  { key: 'pesach', state: 'off', rule: on('nisan', 15) },
  { key: 'chol_hamoed_pesach', state: 'work', rule: on('nisan', 16, 17, 18, 19) },
  { key: 'erev_pesach_7', state: 'half', rule: on('nisan', 20) },
  { key: 'pesach_7', state: 'off', rule: on('nisan', 21) },
  {
    key: 'yom_hashoah',
    state: 'work',
    // 27 Nisan; on Friday it moves to Thursday, on Sunday to Monday.
    rule: (h, wd) =>
      h.month === 'nisan' &&
      ((h.day === 27 && wd !== 5 && wd !== 0) || (h.day === 26 && wd === 4) || (h.day === 28 && wd === 1)),
  },
  {
    key: 'yom_hazikaron',
    state: 'work',
    // The day before Independence Day (see below).
    rule: (h, wd) =>
      h.month === 'iyar' &&
      ((h.day === 4 && wd === 2) ||
        (h.day === 3 && wd === 3) ||
        (h.day === 2 && wd === 3) ||
        (h.day === 5 && wd === 1)),
  },
  {
    key: 'yom_haatzmaut',
    state: 'off',
    // 5 Iyar on a Wednesday; on Friday or Shabbat it moves back to Thursday, on Monday forward to Tuesday.
    rule: (h, wd) =>
      h.month === 'iyar' &&
      ((h.day === 5 && wd === 3) ||
        (h.day === 4 && wd === 4) ||
        (h.day === 3 && wd === 4) ||
        (h.day === 6 && wd === 2)),
  },
  { key: 'lag_baomer', state: 'work', rule: on('iyar', 18) },
  { key: 'yom_yerushalayim', state: 'work', rule: on('iyar', 28) },
  { key: 'erev_shavuot', state: 'half', rule: on('sivan', 5) },
  { key: 'shavuot', state: 'off', rule: on('sivan', 6) },
  { key: 'fast_tammuz', state: 'work', rule: fastSunday('tamuz', 17) },
  { key: 'tisha_bav', state: 'work', rule: fastSunday('av', 9) },
];

/** Every holiday set, by key. 'none' = no holidays. */
export const HOLIDAY_SETS = {
  israel: ISRAEL_HOLIDAYS,
  none: [] as HolidayDef[],
} as const satisfies Record<string, HolidayDef[]>;
export type HolidaySetKey = keyof typeof HOLIDAY_SETS;
export const HOLIDAY_SET_KEYS = Object.keys(HOLIDAY_SETS) as HolidaySetKey[];

const weekdayOf = (iso: IsoDate) => {
  const p = parseIso(iso);
  return new Date(Date.UTC(p.year, p.month, p.day)).getUTCDay();
};

const yearCache = new Map<string, Map<IsoDate, string[]>>();

/** The holidays of a set in one Gregorian year: date → holiday keys (one date may carry two, e.g. a fast). */
export const holidaysOfYear = (set: HolidaySetKey, year: number): Map<IsoDate, string[]> => {
  const cacheKey = `${set}|${year}`;
  let out = yearCache.get(cacheKey);
  if (out) return out;
  out = new Map();
  const defs = HOLIDAY_SETS[set] ?? [];
  if (defs.length) {
    for (let iso = isoOf(year, 0, 1); iso.startsWith(String(year)); iso = addDays(iso, 1)) {
      const h = hebrewDate(iso);
      const wd = weekdayOf(iso);
      const keys = defs.filter((d) => d.rule(h, wd, iso)).map((d) => d.key);
      if (keys.length) out.set(iso, keys);
    }
  }
  if (yearCache.size > 60) yearCache.clear();
  yearCache.set(cacheKey, out);
  return out;
};

/** The holiday keys of one day in a set ([] = none). */
export const holidaysOn = (set: HolidaySetKey, iso: IsoDate): string[] =>
  holidaysOfYear(set, Number(iso.slice(0, 4))).get(iso) ?? [];
