// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  addCountedDays,
  countDays,
  dayInfo,
  dayWeight,
  DEFAULT_CALENDAR,
  endAfter,
  formatHebrewDate,
  formatHebrewSpan,
  gematria,
  hebrewDate,
  holidaysOfYear,
  holidaysOn,
  nextWorkday,
  resolveCalendar,
  ISRAEL_HOLIDAYS,
  type CalendarConfig,
} from '../src';
import he from '../src/i18n/he.json';
import en from '../src/i18n/en.json';

const datesOf = (key: string, year: number) =>
  [...holidaysOfYear('israel', year).entries()].filter(([, keys]) => keys.includes(key)).map(([iso]) => iso);

describe('Hebrew date', () => {
  it('reads the Hebrew calendar day for a Gregorian day', () => {
    expect(hebrewDate('2026-09-12')).toEqual({ day: 1, month: 'tishri', year: 5787 });
    expect(hebrewDate('2026-09-11')).toEqual({ day: 29, month: 'elul', year: 5786 });
    expect(hebrewDate('2027-03-01').month).toBe('adar1'); // 5787 is a leap year
    expect(hebrewDate('2026-03-03').month).toBe('adar'); // 5786 is not
  });

  it('writes numbers in Hebrew letters', () => {
    expect(gematria(1)).toBe('א׳');
    expect(gematria(9)).toBe('ט׳');
    expect(gematria(15)).toBe('ט״ו');
    expect(gematria(16)).toBe('ט״ז');
    expect(gematria(22)).toBe('כ״ב');
    expect(gematria(30)).toBe('ל׳');
    expect(gematria(787)).toBe('תשפ״ז');
    expect(gematria(786)).toBe('תשפ״ו');
  });

  it('formats in Hebrew and English', () => {
    expect(formatHebrewDate('2026-09-20')).toBe('ט׳ בתשרי תשפ״ז');
    expect(formatHebrewDate('2026-09-20', 'day_month')).toBe('ט׳ בתשרי');
    expect(formatHebrewDate('2026-09-20', 'day')).toBe('ט׳');
    expect(formatHebrewDate('2026-09-20', 'full', 'en')).toBe('9 Tishrei 5787');
    expect(formatHebrewSpan('2026-09-01', '2026-09-30')).toBe('אלול תשפ״ו – תשרי תשפ״ז');
    expect(formatHebrewSpan('2026-10-15', '2026-10-20')).toBe('חשוון תשפ״ז');
    expect(formatHebrewSpan('2026-10-01', '2026-10-31', 'en')).toBe('Tishrei – Cheshvan 5787');
  });
});

describe('Israeli holidays', () => {
  it('finds the fixed holidays of 5787', () => {
    expect(datesOf('rosh_hashana', 2026)).toEqual(['2026-09-12', '2026-09-13']);
    expect(datesOf('erev_rosh_hashana', 2026)).toEqual(['2026-09-11']);
    expect(datesOf('yom_kippur', 2026)).toEqual(['2026-09-21']);
    expect(datesOf('sukkot', 2026)).toEqual(['2026-09-26']);
    expect(datesOf('shmini_atzeret', 2026)).toEqual(['2026-10-03']);
    expect(datesOf('pesach', 2027)).toEqual(['2027-04-22']);
    expect(datesOf('pesach_7', 2027)).toEqual(['2027-04-28']);
    expect(datesOf('shavuot', 2027)).toEqual(['2027-06-11']);
  });

  it('puts Purim in Adar II of a leap year and in Adar of a common year', () => {
    expect(datesOf('purim', 2027)).toEqual(['2027-03-23']);
    expect(datesOf('purim', 2026)).toEqual(['2026-03-03']);
  });

  it('runs Hanukkah eight days across Kislev and Tevet (and across the Gregorian year)', () => {
    expect(datesOf('hanukkah', 2026)).toEqual([
      '2026-12-05',
      '2026-12-06',
      '2026-12-07',
      '2026-12-08',
      '2026-12-09',
      '2026-12-10',
      '2026-12-11',
      '2026-12-12',
    ]);
    // Hanukkah 5785 began 2024-12-26 and ended 2025-01-02.
    expect(datesOf('hanukkah', 2024)).toHaveLength(6);
    expect(datesOf('hanukkah', 2025).slice(0, 2)).toEqual(['2025-01-01', '2025-01-02']);
  });

  it('moves Independence Day and Memorial Day by the weekday', () => {
    expect(datesOf('yom_haatzmaut', 2023)).toEqual(['2023-04-26']); // Wednesday, as is
    expect(datesOf('yom_haatzmaut', 2024)).toEqual(['2024-05-14']); // Monday → Tuesday
    expect(datesOf('yom_hazikaron', 2024)).toEqual(['2024-05-13']);
    expect(datesOf('yom_haatzmaut', 2025)).toEqual(['2025-05-01']); // Shabbat → Thursday
    expect(datesOf('yom_hazikaron', 2025)).toEqual(['2025-04-30']);
    expect(datesOf('yom_haatzmaut', 2026)).toEqual(['2026-04-22']);
  });

  it('moves Yom HaShoah off Friday and Sunday, and fasts off Shabbat', () => {
    expect(datesOf('yom_hashoah', 2025)).toEqual(['2025-04-24']); // Friday → Thursday
    expect(datesOf('tisha_bav', 2025)).toEqual(['2025-08-03']); // Shabbat → Sunday
    expect(datesOf('fast_esther', 2024)).toEqual(['2024-03-21']); // Shabbat → Thursday
  });

  it('finds every holiday in every Gregorian year (10 Tevet may fall in neither January nor December)', () => {
    for (const year of [2025, 2026, 2027, 2028, 2029, 2030]) {
      const all = [...holidaysOfYear('israel', year).values()].flat();
      for (const def of ISRAEL_HOLIDAYS)
        if (def.key !== 'fast_tevet') expect(all.includes(def.key), `${def.key} ${year}`).toBe(true);
    }
  });

  it('has a name for every holiday in both languages', () => {
    for (const def of ISRAEL_HOLIDAYS) {
      expect(he).toHaveProperty(`holiday.${def.key}`);
      expect(en).toHaveProperty(`holiday.${def.key}`);
    }
  });

  it('has no holidays in the empty set', () => {
    expect(holidaysOn('none', '2026-09-21')).toEqual([]);
  });
});

describe('settings', () => {
  it('follows the platform until the account chooses, and keeps locked holidays', () => {
    const cfg = resolveCalendar(
      { hebrew_dates: 'calendars', holidays: { purim: { state: 'off' }, yom_kippur: { state: 'off', locked: true } } },
      { duration: 'workdays', holidays: { yom_kippur: 'work', hanukkah: 'ignore' } },
    );
    expect(cfg.hebrew_dates).toBe('calendars');
    expect(cfg.duration).toBe('workdays');
    expect(cfg.holidays.purim).toBe('off');
    expect(cfg.holidays.yom_kippur).toBe('off');
    expect(cfg.locked).toEqual(['yom_kippur']);
    expect(cfg.holidays.hanukkah).toBe('ignore');
  });

  it('falls back to the defaults on invalid input', () => {
    expect(resolveCalendar({ hebrew_dates: 'sometimes' }, 42)).toEqual(DEFAULT_CALENDAR);
    expect(DEFAULT_CALENDAR.hebrew_dates).toBe('off');
    expect(DEFAULT_CALENDAR.duration).toBe('calendar');
    expect(DEFAULT_CALENDAR.holidays.yom_kippur).toBe('off');
    expect(DEFAULT_CALENDAR.holidays.erev_yom_kippur).toBe('half');
  });

  it('marks days off in pickers by the platform until the account chooses', () => {
    expect(DEFAULT_CALENDAR.picker_marks).toBe('dot');
    expect(resolveCalendar({ picker_marks: 'none' }).picker_marks).toBe('none');
    expect(resolveCalendar({ picker_marks: 'none' }, { picker_marks: 'dot' }).picker_marks).toBe('dot');
    expect(resolveCalendar({}, { picker_marks: 'none' }).picker_marks).toBe('none');
    // An unset (or invalid) account field follows the platform.
    expect(resolveCalendar({ picker_marks: 'none' }, { picker_marks: undefined }).picker_marks).toBe('none');
    expect(resolveCalendar({ picker_marks: 'stars' }).picker_marks).toBe('dot');
  });
});

describe('working days', () => {
  const cfg = DEFAULT_CALENDAR;

  it('tells a day off, a half day and a weekend', () => {
    expect(dayInfo('2026-09-21', cfg).state).toBe('off');
    expect(dayInfo('2026-09-20', cfg).state).toBe('half');
    expect(dayInfo('2026-09-19', cfg).weekend).toBe(true);
    expect(dayInfo('2026-09-28', cfg).state).toBe('work');
    expect(dayInfo('2026-09-08', cfg)).toEqual({ weekend: false, marks: [], state: null });
  });

  it('weighs days by mode', () => {
    expect(dayWeight('2026-09-21', 'calendar', cfg)).toBe(1);
    expect(dayWeight('2026-09-21', 'weekdays', cfg)).toBe(1);
    expect(dayWeight('2026-09-21', 'workdays', cfg)).toBe(0);
    expect(dayWeight('2026-09-20', 'workdays', cfg)).toBe(0.5);
    expect(dayWeight('2026-09-20', 'workdays', { ...cfg, half_day: 'work' })).toBe(1);
    expect(dayWeight('2026-09-20', 'workdays', { ...cfg, half_day: 'off' })).toBe(0);
    expect(dayWeight('2026-09-19', 'weekdays', cfg)).toBe(0);
    expect(dayWeight('2026-09-20', 'weekdays', cfg, 'sat_sun')).toBe(0);
  });

  it('counts an inclusive span (the canvas example)', () => {
    expect(countDays('2026-09-17', '2026-09-30', 'calendar', cfg)).toBe(14);
    expect(countDays('2026-09-17', '2026-09-30', 'weekdays', cfg)).toBe(10);
    expect(countDays('2026-09-17', '2026-09-30', 'workdays', cfg)).toBe(8.5);
    expect(countDays('2026-09-30', '2026-09-17', 'workdays', cfg)).toBe(-8.5);
  });

  it('counts across a year boundary', () => {
    expect(countDays('2026-12-28', '2027-01-03', 'weekdays', cfg)).toBe(5);
    expect(countDays('2026-12-31', '2027-01-01', 'calendar', cfg)).toBe(2);
  });

  it('adds working days, skipping weekends and days off', () => {
    // Thu 2026-09-17 + 1 working day: Fri/Sat weekend, Sun 20 is half (½), Mon 21 Yom Kippur (0), Tue 22 → done.
    expect(addCountedDays('2026-09-17', 1, 'workdays', cfg)).toBe('2026-09-22');
    expect(addCountedDays('2026-09-17', 1, 'weekdays', cfg)).toBe('2026-09-20');
    expect(addCountedDays('2026-09-17', 3, 'calendar', cfg)).toBe('2026-09-20');
    // Back from Tue 22: Yom Kippur 0, Sun 20 ½, weekend, Thu 17 → a whole day reached.
    expect(addCountedDays('2026-09-22', -1, 'workdays', cfg)).toBe('2026-09-17');
    expect(addCountedDays('2026-12-31', 1, 'weekdays', cfg)).toBe('2027-01-03');
  });

  it('keeps a span’s working days when it moves', () => {
    const n = countDays('2026-09-06', '2026-09-08', 'workdays', cfg); // Sun–Tue, ordinary = 3
    expect(n).toBe(3);
    // Starting Thu 10/09: Thu 1, Fri–Sat weekend, Sun 13/09 Rosh Hashanah (off) → Mon 14, Tue 15.
    expect(endAfter('2026-09-10', n, 'workdays', cfg)).toBe('2026-09-15');
    expect(endAfter('2026-09-10', 3, 'calendar', cfg)).toBe('2026-09-12');
  });

  it('moves a start off a day off', () => {
    expect(nextWorkday('2026-09-21', 'workdays', cfg)).toBe('2026-09-22');
    expect(nextWorkday('2026-09-21', 'weekdays', cfg)).toBe('2026-09-21');
  });

  it('applies the account’s own days over holidays', () => {
    const own: CalendarConfig = {
      ...cfg,
      custom_days: [
        { date: '2026-09-14', to: '2026-09-15', name: 'Team days', state: 'off' },
        { date: '2026-09-21', name: 'We work', state: 'work' },
      ],
    };
    expect(dayInfo('2026-09-15', own).marks).toEqual([{ name: 'Team days', state: 'off' }]);
    expect(dayWeight('2026-09-14', 'workdays', own)).toBe(0);
    expect(dayWeight('2026-09-21', 'workdays', own)).toBe(1);
  });

  it('ignores the holidays an account hides', () => {
    const hidden: CalendarConfig = { ...cfg, holidays: { ...cfg.holidays, yom_kippur: 'ignore' } };
    expect(dayInfo('2026-09-21', hidden)).toEqual({ weekend: false, marks: [], state: null });
    expect(dayWeight('2026-09-21', 'workdays', hidden)).toBe(1);
  });
});
