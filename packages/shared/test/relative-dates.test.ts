// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  dateInZone,
  formulaHref,
  isRelativeDateValue,
  parseRelativeDay,
  relativeDayValue,
  resolveDateValue,
  type DateEnv,
} from '../src';

/** Fix: — relative dates in filters (today, this / last / next week…, N days ago) and formula links. */
const env = (today: string, over: Partial<DateEnv> = {}): DateEnv => ({
  today,
  timezone: 'Asia/Jerusalem',
  weekend: 'fri_sat',
  firstDay: 0,
  ...over,
});
const span = (v: string, e: DateEnv) => resolveDateValue(v, e);

describe('relative date values', () => {
  it('days around today', () => {
    const e = env('2026-10-07');
    expect(span('TODAY', e)).toEqual({ from: '2026-10-07', to: '2026-10-07' });
    expect(span('YESTERDAY', e)).toEqual({ from: '2026-10-06', to: '2026-10-06' });
    expect(span('TOMORROW', e)).toEqual({ from: '2026-10-08', to: '2026-10-08' });
    expect(span('DAYS_AGO:30', e)).toEqual({ from: '2026-09-07', to: '2026-09-07' });
    expect(span('DAYS_AHEAD:0', e)).toEqual({ from: '2026-10-07', to: '2026-10-07' });
  });

  it('weeks follow the account first day of the week', () => {
    const sunday = env('2026-10-07'); // a Wednesday
    expect(span('THIS_WEEK', sunday)).toEqual({ from: '2026-10-04', to: '2026-10-10' });
    expect(span('LAST_WEEK', sunday)).toEqual({ from: '2026-09-27', to: '2026-10-03' });
    expect(span('NEXT_WEEK', sunday)).toEqual({ from: '2026-10-11', to: '2026-10-17' });
    const monday = env('2026-10-07', { firstDay: 1 });
    expect(span('THIS_WEEK', monday)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(span('LAST_WEEK', monday)).toEqual({ from: '2026-09-28', to: '2026-10-04' });
    // On the first day itself the week starts today.
    expect(span('THIS_WEEK', env('2026-10-05', { firstDay: 1 }))!.from).toBe('2026-10-05');
    expect(span('THIS_WEEK', env('2026-10-04'))!.from).toBe('2026-10-04');
    // Saturday-first (some regions).
    expect(span('THIS_WEEK', env('2026-10-07', { firstDay: 6 }))).toEqual({ from: '2026-10-03', to: '2026-10-09' });
  });

  it('months, quarters and years, across year ends', () => {
    const e = env('2026-01-15');
    expect(span('LAST_MONTH', e)).toEqual({ from: '2025-12-01', to: '2025-12-31' });
    expect(span('THIS_QUARTER', e)).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(span('LAST_QUARTER', e)).toEqual({ from: '2025-10-01', to: '2025-12-31' });
    expect(span('NEXT_QUARTER', e)).toEqual({ from: '2026-04-01', to: '2026-06-30' });
    expect(span('LAST_YEAR', e)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(span('NEXT_YEAR', e)).toEqual({ from: '2027-01-01', to: '2027-12-31' });
    expect(span('NEXT_QUARTER', env('2026-11-30'))).toEqual({ from: '2027-01-01', to: '2027-03-31' });
    expect(span('LAST_MONTH', env('2026-03-31'))).toEqual({ from: '2026-02-01', to: '2026-02-28' });
  });

  it('weeks spanning a DST change keep whole calendar days', () => {
    // Israel moves to summer time on Friday 2026-03-27; the US on Sunday 2026-03-08.
    expect(span('THIS_WEEK', env('2026-03-27'))).toEqual({ from: '2026-03-22', to: '2026-03-28' });
    expect(span('NEXT_WEEK', env('2026-03-27'))).toEqual({ from: '2026-03-29', to: '2026-04-04' });
    expect(span('DAYS_AGO:7', env('2026-03-30'))).toEqual({ from: '2026-03-23', to: '2026-03-23' });
    const ny = env('2026-03-09', { timezone: 'America/New_York', firstDay: 0, weekend: 'sat_sun' });
    expect(span('THIS_WEEK', ny)).toEqual({ from: '2026-03-08', to: '2026-03-14' });
    expect(span('YESTERDAY', ny)).toEqual({ from: '2026-03-08', to: '2026-03-08' });
  });

  it('"today" is the account timezone date, also around midnight and DST', () => {
    // 22:30 UTC on Mar 26 is 00:30 on Mar 27 in Jerusalem (still winter time, +2) — and the 26th in New York.
    const at = new Date('2026-03-26T22:30:00Z');
    expect(dateInZone(at, 'Asia/Jerusalem')).toBe('2026-03-27');
    expect(dateInZone(at, 'America/New_York')).toBe('2026-03-26');
    // 21:30 UTC on Mar 27 is 00:30 on Mar 28 in Jerusalem after the switch (+3).
    expect(dateInZone(new Date('2026-03-27T21:30:00Z'), 'Asia/Jerusalem')).toBe('2026-03-28');
  });

  it('relative days parse, clamp and stay relative', () => {
    expect(relativeDayValue('ago', 7)).toBe('DAYS_AGO:7');
    expect(relativeDayValue('ahead', 2.9)).toBe('DAYS_AHEAD:2');
    expect(relativeDayValue('ago', 99999)).toBe('DAYS_AGO:3650');
    expect(parseRelativeDay('DAYS_AGO:14')).toEqual({ dir: 'ago', n: 14 });
    expect(parseRelativeDay('DAYS_AGO:-1')).toBeNull();
    expect(parseRelativeDay('DAYS_AGO:9999')).toBeNull();
    expect(parseRelativeDay('2026-10-07')).toBeNull();
    expect(isRelativeDateValue('THIS_WEEK')).toBe(true);
    expect(isRelativeDateValue('DAYS_AHEAD:3')).toBe(true);
    expect(isRelativeDateValue('EXACT:2026-10-07')).toBe(false);
    expect(span('DAYS_AGO:x', env('2026-10-07'))).toBeNull();
  });
});

describe('formula results as links', () => {
  it('auto: only a whole http(s) address', () => {
    expect(formulaHref('https://example.com/a?b=1', {})).toBe('https://example.com/a?b=1');
    expect(formulaHref('  http://example.com  ', { show_as_link: 'auto' })).toBe('http://example.com/');
    expect(formulaHref('example.com', {})).toBeNull();
    expect(formulaHref('see https://example.com', {})).toBeNull();
    expect(formulaHref(42, {})).toBeNull();
    expect(formulaHref(null, {})).toBeNull();
  });

  it('on: bare domains too; off: never', () => {
    expect(formulaHref('example.co.il/path', { show_as_link: 'on' })).toBe('https://example.co.il/path');
    expect(formulaHref('not a domain', { show_as_link: 'on' })).toBeNull();
    expect(formulaHref('https://example.com', { show_as_link: 'off' })).toBeNull();
  });

  it('never anything but http / https', () => {
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'mailto:a@b.c', 'ftp://x.y'])
      for (const mode of ['auto', 'on'] as const) expect(formulaHref(bad, { show_as_link: mode })).toBeNull();
    expect(formulaHref('https://', {})).toBeNull();
    expect(formulaHref(`https://example.com/${'a'.repeat(2100)}`, {})).toBeNull();
  });
});
