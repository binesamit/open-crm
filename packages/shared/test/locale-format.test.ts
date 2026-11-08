// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it } from 'vitest';
import {
  columnTypes,
  DEFAULT_REGION,
  DEFAULT_CALENDAR,
  exactTime,
  formatCurrency,
  formatDate,
  formatDateRange,
  formatDateTime,
  formatDateValue,
  formatDayMonth,
  formatHour,
  formatInstantDate,
  formatLongDay,
  formatMonthYear,
  formatNumber,
  formatTime,
  formatTimeline,
  getRegion,
  isValidTimeZone,
  isWeekendDate,
  localDateOf,
  monthGrid,
  regionKey,
  relativeTime,
  renderTemplate,
  resolveRegion,
  setLocale,
  setRegion,
  subscribeRegion,
  todayIn,
  weekdayNames,
  weekendDays,
  zonedInstant,
  type Region,
} from '../src';

const region = (p: Partial<Region> = {}): Region => ({ ...DEFAULT_REGION, ...p });
const US = region({ language: 'en', date_format: 'MM/DD/YYYY', time_format: '12h', timezone: 'America/New_York' });

afterEach(() => {
  setRegion(DEFAULT_REGION);
  setLocale('he');
});

describe('resolveRegion (account defaults + the member profile)', () => {
  it('takes the account settings and falls back to the defaults', () => {
    expect(resolveRegion(null)).toEqual(DEFAULT_REGION);
    const r = resolveRegion({
      language: 'en',
      timezone: 'Europe/London',
      date_format: 'YYYY-MM-DD',
      time_format: '12h',
      first_day: 1,
      weekend: 'sat_sun',
      currency: 'USD',
    });
    expect(r).toEqual({
      language: 'en',
      timezone: 'Europe/London',
      date_format: 'YYYY-MM-DD',
      time_format: '12h',
      first_day: 1,
      weekend: 'sat_sun',
      currency: 'USD',
      calendar: DEFAULT_CALENDAR,
    });
  });

  it("the member's language and timezone win; invalid values are ignored", () => {
    const r = resolveRegion(
      { timezone: 'Europe/London', first_day: 9, weekend: 'x', currency: 'usd' },
      {
        locale: 'en',
        timezone: 'Asia/Tokyo',
      },
    );
    expect(r.language).toBe('en');
    expect(r.timezone).toBe('Asia/Tokyo');
    expect(r.first_day).toBe(0);
    expect(r.weekend).toBe('fri_sat');
    expect(r.currency).toBe('ILS');
    expect(resolveRegion({ timezone: 'Europe/London' }, { timezone: 'Mars/Base' }).timezone).toBe('Europe/London');
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('Asia/Jerusalem')).toBe(true);
  });

  it("a member without a timezone of their own (null) follows the account's", () => {
    expect(resolveRegion({ timezone: 'Asia/Tokyo' }, { locale: 'en', timezone: null }).timezone).toBe('Asia/Tokyo');
    expect(resolveRegion({ timezone: 'Asia/Tokyo' }, { timezone: undefined }).timezone).toBe('Asia/Tokyo');
    expect(resolveRegion({ timezone: 'America/New_York' }, { timezone: null }).timezone).toBe('America/New_York');
    // An explicit zone still wins; no zone anywhere → the platform default.
    expect(resolveRegion({ timezone: 'Asia/Tokyo' }, { timezone: 'Europe/London' }).timezone).toBe('Europe/London');
    expect(resolveRegion(null, { timezone: null }).timezone).toBe('Asia/Jerusalem');
  });
});

describe('dates in the date format', () => {
  it('every account format', () => {
    expect(formatDate('2026-10-05', {}, region())).toBe('05/10/2026');
    expect(formatDate('2026-10-05', {}, region({ date_format: 'MM/DD/YYYY' }))).toBe('10/05/2026');
    expect(formatDate('2026-10-05', {}, region({ date_format: 'YYYY-MM-DD' }))).toBe('2026-10-05');
    expect(formatDate('2026-10-05', {}, region({ date_format: 'DD.MM.YYYY' }))).toBe('05.10.2026');
  });

  it('year modes: never / short / auto', () => {
    expect(formatDate('2026-10-05', { year: 'never' }, region())).toBe('05/10');
    expect(formatDate('2026-10-05', { year: 'never' }, region({ date_format: 'YYYY-MM-DD' }))).toBe('10-05');
    expect(formatDate('2026-10-05', { year: 'short' }, region({ date_format: 'MM/DD/YYYY' }))).toBe('10/05/26');
    expect(formatDate('2026-10-05', { year: 'auto', today: '2026-01-01' }, region())).toBe('05/10');
    expect(formatDate('2026-10-05', { year: 'auto', today: '2027-01-01' }, region())).toBe('05/10/2026');
  });

  it('a weekday before the date, in the language', () => {
    expect(formatDate('2026-10-05', { weekday: 'short' }, region({ language: 'en' }))).toBe('Mon 05/10/2026');
  });

  it('timeline and ranges follow the order', () => {
    expect(formatTimeline('2026-09-25', '2026-09-26', '2026-10-02', region())).toBe('25/09 – 26/09');
    expect(formatTimeline('2026-09-25', '2026-09-26', '2026-10-02', region({ date_format: 'MM/DD/YYYY' }))).toBe(
      '09/25 – 09/26',
    );
    expect(formatTimeline('2026-09-30', '2027-10-08', '2026-10-02', region({ date_format: 'YYYY-MM-DD' }))).toBe(
      '26-09-30 – 27-10-08',
    );
    expect(formatDateRange('2026-10-05', '2026-10-05', {}, region())).toBe('05/10/2026');
    expect(formatDateRange('2026-10-05', '2026-10-07', {}, US)).toBe('10/05/2026 – 10/07/2026');
  });

  it('names: long day, month title, short day+month (Hebrew without the ב prefix)', () => {
    expect(formatLongDay('2026-10-04', region({ language: 'en' }))).toBe('Sunday, October 4');
    expect(formatLongDay('2026-10-04', region())).toBe('יום ראשון, 4 אוקטובר');
    expect(formatMonthYear(2026, 9, region({ language: 'en' }))).toBe('October 2026');
    expect(formatDayMonth('2026-09-03', { year: false }, region())).toBe('3 ספט׳');
    expect(formatDayMonth('2026-09-03', { year: true }, region({ language: 'en' }))).toBe('Sep 3, 2026');
  });
});

describe('instants in the timezone (DST-safe)', () => {
  it('time format 24h / 12h', () => {
    expect(formatTime('2026-10-05T11:30:00Z', region())).toBe('14:30');
    expect(formatTime('2026-10-05T11:30:00Z', US)).toBe('7:30 AM');
    expect(formatHour(8, region())).toBe('08:00');
    expect(formatHour(20, US)).toBe('8:00 PM');
  });

  it('the local day of an instant moves with the zone', () => {
    // 22:30Z on Oct 5 is already Oct 6 in Jerusalem, still Oct 5 in New York.
    expect(localDateOf('2026-10-05T22:30:00Z', region())).toBe('2026-10-06');
    expect(localDateOf('2026-10-05T22:30:00Z', US)).toBe('2026-10-05');
    expect(formatInstantDate('2026-10-05T22:30:00Z', {}, region())).toBe('06/10/2026');
    expect(formatDateTime('2026-10-05T22:30:00Z', {}, US)).toBe('10/05/2026 6:30 PM');
    expect(todayIn(region({ timezone: 'Pacific/Kiritimati' }), new Date('2026-10-05T12:00:00Z'))).toBe('2026-10-06');
  });

  it('Jerusalem DST: the same UTC hour is 2 or 3 hours ahead', () => {
    expect(formatTime('2026-03-26T10:00:00Z', region())).toBe('12:00'); // winter, +2
    expect(formatTime('2026-03-28T10:00:00Z', region())).toBe('13:00'); // summer (from Mar 27), +3
    expect(formatTime('2026-10-24T10:00:00Z', region())).toBe('13:00');
    expect(formatTime('2026-10-26T10:00:00Z', region())).toBe('12:00'); // back to winter on Oct 25
  });

  it('wall-clock → instant: normal, spring gap, autumn repeat', () => {
    expect(zonedInstant('2026-10-05', '14:30', region()).toISOString()).toBe('2026-10-05T11:30:00.000Z');
    expect(zonedInstant('2026-01-05', '14:30', region()).toISOString()).toBe('2026-01-05T12:30:00.000Z');
    expect(zonedInstant('2026-07-04', '09:00', US).toISOString()).toBe('2026-07-04T13:00:00.000Z');
    // 02:30 does not exist on 2026-03-27 in Jerusalem (02:00 → 03:00): lands after the jump (03:30 IDT).
    const gap = zonedInstant('2026-03-27', '02:30', region());
    expect(formatTime(gap, region())).toBe('03:30');
    // 01:30 happens twice on 2026-10-25 (02:00 → 01:00): the first one (IDT, +3).
    expect(zonedInstant('2026-10-25', '01:30', region()).toISOString()).toBe('2026-10-24T22:30:00.000Z');
    // Round trip on every hour of a DST day.
    for (let h = 0; h < 24; h++) {
      if (h === 2) continue;
      const hm = `${String(h).padStart(2, '0')}:15`;
      const at = zonedInstant('2026-03-27', hm, region());
      expect(formatTime(at, region())).toBe(hm);
      expect(localDateOf(at, region())).toBe('2026-03-27');
    }
  });

  it('a date column value: a plain date never moves, a UTC time moves into the zone', () => {
    expect(formatDateValue({ date: '2026-10-05' }, US)).toBe('10/05/2026');
    expect(formatDateValue({ date: '2026-10-05', time: '22:30' }, region())).toBe('06/10/2026 01:30');
    expect(formatDateValue({ date: '2026-10-05', time: '02:00:00' }, US)).toBe('10/04/2026 10:00 PM');
    expect(formatDateValue({ date: '2026-10-05' }, region(), { show_weekday: true })).toMatch(/05\/10\/2026$/);
  });
});

describe('the week: first day and weekend', () => {
  it('weekday order starts on the first day', () => {
    expect(weekdayNames('short', region({ language: 'en', first_day: 1 }))[0]).toBe('Mon');
    expect(weekdayNames('short', region({ language: 'en', first_day: 0 }))[0]).toBe('Sun');
    expect(weekdayNames('short', region({ language: 'en', first_day: 6 }))[6]).toBe('Fri');
    expect(monthGrid(2026, 9, 1)[0]!.iso).toBe('2026-09-28'); // a Monday
  });

  it('weekend days', () => {
    expect(weekendDays(region())).toEqual([5, 6]);
    expect(weekendDays(region({ weekend: 'sat_sun' }))).toEqual([6, 0]);
    expect(isWeekendDate('2026-10-09', region())).toBe(true); // Friday
    expect(isWeekendDate('2026-10-11', region())).toBe(false); // Sunday
    expect(isWeekendDate('2026-10-11', region({ weekend: 'sat_sun' }))).toBe(true);
  });
});

describe('numbers and money', () => {
  it('grouping in the language, money in the region currency', () => {
    expect(formatNumber(12345.5, {}, region({ language: 'en' }))).toBe('12,345.5');
    expect(formatCurrency(1234.5, null, region({ language: 'en', currency: 'USD' }))).toBe('$1,234.50');
    expect(formatCurrency(10, 'EUR', region({ language: 'en' }))).toBe('€10.00');
    expect(formatCurrency(10, null, region())).toContain('₪');
    expect(formatCurrency(10, 'NOPE', region({ language: 'en' }))).toBe('10 NOPE');
  });
});

describe('the runtime region (web)', () => {
  it('setRegion notifies once per change; the language follows the UI language', () => {
    let calls = 0;
    const off = subscribeRegion(() => calls++);
    setRegion(US);
    setRegion({ ...US });
    expect(calls).toBe(1);
    expect(getRegion().language).toBe('he');
    setLocale('en');
    expect(getRegion().language).toBe('en');
    expect(getRegion().timezone).toBe('America/New_York');
    expect(regionKey(getRegion())).toBe(regionKey(US));
    // Default arguments read the runtime region.
    expect(formatDate('2026-10-05')).toBe('10/05/2026');
    off();
  });

  it('relative and exact times follow the region', () => {
    setRegion(US);
    const now = Date.parse('2026-10-05T16:00:00Z'); // noon in New York
    expect(exactTime('2026-10-05T11:30:00Z')).toBe('10/05/2026 7:30 AM');
    // 03:00Z on Oct 5 is Oct 4 (11 PM) in New York: "yesterday", with its 12h time.
    expect(relativeTime('2026-10-05T03:00:00Z', now)).toMatch(/11:00 PM/);
    expect(relativeTime('2026-08-01T12:00:00Z', now, region({ language: 'en' }))).toBe('Aug 1');
  });
});

describe('column texts and templates', () => {
  it('date and timeline texts: canonical without a region, localized with one', () => {
    const date = columnTypes.get('date')!;
    expect(date.localizedText).toBe(true);
    expect(date.toText({ date: '2026-10-05', time: '22:30' }, {}, {})).toBe('05/10/2026 22:30');
    expect(date.toText({ date: '2026-10-05', time: '22:30' }, {}, { region: region() })).toBe('06/10/2026 01:30');
    expect(date.toText({ date: '2026-10-05' }, {}, { region: US })).toBe('10/05/2026');
    const timeline = columnTypes.get('timeline')!;
    expect(timeline.toText({ from: '2026-10-05', to: '2026-10-07' }, {}, { region: US })).toBe(
      '10/05/2026 – 10/07/2026',
    );
    const created = columnTypes.get('creation_log')!;
    expect(created.toText({ at: '2026-10-05T22:30:00Z', by: null }, { mode: 'date' }, { region: region() })).toBe(
      '06/10/2026',
    );
  });

  it('|date without a pattern and |currency use the account region', () => {
    const lookup = (p: string) =>
      ({ due: '2026-10-15', at: '2026-10-05T22:30:00Z', amount: 1234.5 })[p as 'due' | 'at' | 'amount'];
    const r = region({ date_format: 'MM/DD/YYYY', currency: 'USD', language: 'en' });
    expect(renderTemplate('{due|date}', lookup, { region: r }).text).toBe('10/15/2026');
    expect(renderTemplate('{at|date:DD/MM/YYYY HH:mm}', lookup, { region: region() }).text).toBe('06/10/2026 01:30');
    expect(renderTemplate('{amount|currency}', lookup, { region: r }).text).toBe('$1,234.50');
    // Without a region (old callers): unchanged.
    expect(renderTemplate('{due|date}', lookup).text).toBe('15/10/2026');
  });
});
