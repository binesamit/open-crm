// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  allDayCells,
  calendarRangeDays,
  calendarSettingsOf,
  dayBars,
  DEFAULT_REGION,
  columnTypes,
  hmOf,
  isSameDaySpan,
  layoutOverlaps,
  minutesOf,
  parseCellValue,
  readTimedSpan,
  snapMinutes,
  spanMinutes,
  timedCells,
  type CalendarTimeConfig,
  type Region,
} from '../src';

const il: Region = { ...DEFAULT_REGION, timezone: 'Asia/Jerusalem' };
const env = { firstDay: 0, weekend: 'fri_sat' as const };
const tl: CalendarTimeConfig = { source: 'timeline', dateColumnId: 'tl', defaultDuration: 60 };
const dh: CalendarTimeConfig = {
  source: 'date_hours',
  dateColumnId: 'd',
  startColumnId: 's',
  endColumnId: 'e',
  defaultDuration: 60,
};
const c = (value: unknown) => ({ value });

describe('calendar by the hour', () => {
  it('minutes and HH:MM', () => {
    expect(minutesOf('09:30')).toBe(570);
    expect(hmOf(570)).toBe('09:30');
    expect(hmOf(1440)).toBe('24:00');
    expect(snapMinutes(577, 15)).toBe(570);
    expect(snapMinutes(578, 15)).toBe(585);
  });

  it('range days: day, 3 days, week from the first weekday, work week without the weekend', () => {
    // 2026-11-03 is a Tuesday.
    expect(calendarRangeDays('day', '2026-11-03', env)).toEqual(['2026-11-03']);
    expect(calendarRangeDays('3day', '2026-11-03', env)).toEqual(['2026-11-03', '2026-11-04', '2026-11-05']);
    const week = calendarRangeDays('week', '2026-11-03', env);
    expect(week[0]).toBe('2026-11-01');
    expect(week).toHaveLength(7);
    expect(calendarRangeDays('workweek', '2026-11-03', env)).toEqual([
      '2026-11-01',
      '2026-11-02',
      '2026-11-03',
      '2026-11-04',
      '2026-11-05',
    ]);
    expect(calendarRangeDays('week', '2026-11-03', { firstDay: 1, weekend: 'sat_sun' }, false)[0]).toBe('2026-11-02');
    expect(calendarRangeDays('week', '2026-11-03', env, false)).toHaveLength(5);
  });

  it('reads a timeline with hours; without hours it is all-day', () => {
    const span = readTimedSpan(
      { tl: c({ from: '2026-11-03', to: '2026-11-03', from_time: '13:30', to_time: '15:00' }) },
      tl,
    );
    expect(span).toEqual({ day: '2026-11-03', start: 810, endDay: '2026-11-03', end: 900 });
    expect(spanMinutes(span!)).toBe(90);
    expect(isSameDaySpan(span!)).toBe(true);
    expect(readTimedSpan({ tl: c({ from: '2026-11-03', to: '2026-11-04' }) }, tl)).toBeNull();
    expect(readTimedSpan({}, tl)).toBeNull();
  });

  it('reads a date with start and end hour columns', () => {
    const cells = { d: c({ date: '2026-11-03' }), s: c({ hour: 9, minute: 0 }), e: c({ hour: 10, minute: 30 }) };
    expect(readTimedSpan(cells, dh, il)).toEqual({ day: '2026-11-03', start: 540, endDay: '2026-11-03', end: 630 });
    // No end: the default length; an end before the start is the next day.
    expect(readTimedSpan({ d: cells.d, s: cells.s }, dh, il)?.end).toBe(600);
    const night = readTimedSpan({ d: cells.d, s: c({ hour: 22, minute: 0 }), e: c({ hour: 1, minute: 0 }) }, dh, il);
    expect(night).toEqual({ day: '2026-11-03', start: 1320, endDay: '2026-11-04', end: 60 });
    expect(isSameDaySpan(night!)).toBe(false);
    // No start at all: all-day.
    expect(readTimedSpan({ d: cells.d }, dh, il)).toBeNull();
  });

  it("a date's own time (UTC) is the start in the account's zone when there is no start column", () => {
    const cfg: CalendarTimeConfig = { source: 'date_hours', dateColumnId: 'd', defaultDuration: 45 };
    // 07:00 UTC = 09:00 in Israel in November.
    const span = readTimedSpan({ d: c({ date: '2026-11-03', time: '07:00' }) }, cfg, il);
    expect(span).toEqual({ day: '2026-11-03', start: 540, endDay: '2026-11-03', end: 585 });
    // Moving it writes the new start back as UTC.
    expect(timedCells(cfg, {}, '2026-11-04', 600, 45, il)).toEqual({ d: { date: '2026-11-04', time: '08:00' } });
  });

  it('writes a move / resize to a timeline, keeping a milestone mark', () => {
    const cur = {
      tl: c({ from: '2026-11-03', to: '2026-11-03', from_time: '09:00', to_time: '10:00', milestone: true }),
    };
    expect(timedCells(tl, cur, '2026-11-05', 615, 90)).toEqual({
      tl: { from: '2026-11-05', to: '2026-11-05', from_time: '10:15', to_time: '11:45', milestone: true },
    });
    // Past midnight: the end lands on the next day; an end at midnight stays on the same day as 24:00.
    expect(timedCells(tl, {}, '2026-11-05', 1380, 120)).toEqual({
      tl: { from: '2026-11-05', to: '2026-11-06', from_time: '23:00', to_time: '01:00' },
    });
    expect(timedCells(tl, {}, '2026-11-05', 1380, 60)).toEqual({
      tl: { from: '2026-11-05', to: '2026-11-05', from_time: '23:00', to_time: '24:00' },
    });
  });

  it('writes a move to a date and hour columns', () => {
    expect(timedCells(dh, { d: c({ date: '2026-11-03' }) }, '2026-11-04', 840, 45, il)).toEqual({
      d: { date: '2026-11-04' },
      s: { hour: 14, minute: 0 },
      e: { hour: 14, minute: 45 },
    });
  });

  it("all-day: drops the hours, keeps a timeline's length in days", () => {
    expect(
      allDayCells(
        tl,
        { tl: c({ from: '2026-11-03', to: '2026-11-04', from_time: '22:00', to_time: '02:00' }) },
        '2026-11-10',
      ),
    ).toEqual({
      tl: { from: '2026-11-10', to: '2026-11-11' },
    });
    expect(allDayCells(dh, { d: c({ date: '2026-11-03' }) }, '2026-11-10')).toEqual({
      d: { date: '2026-11-10' },
      s: null,
      e: null,
    });
  });

  it('overlaps stand side by side; touching items do not', () => {
    const lay = layoutOverlaps([
      { id: 'a', start: 600, end: 660 },
      { id: 'b', start: 630, end: 720 },
      { id: 'c', start: 660, end: 690 },
      { id: 'd', start: 720, end: 780 },
    ]);
    expect(lay.get('a')).toEqual({ col: 0, cols: 2 });
    expect(lay.get('b')).toEqual({ col: 1, cols: 2 });
    // c starts when a ends: it takes a's column.
    expect(lay.get('c')).toEqual({ col: 0, cols: 2 });
    // d starts when the cluster ends: alone.
    expect(lay.get('d')).toEqual({ col: 0, cols: 1 });
  });

  it('bars across a row of days: lanes, and the ends that carry on', () => {
    const days = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07'];
    const bars = dayBars(
      [
        { id: 'conf', from: '2026-10-30', to: '2026-11-03' },
        { id: 'trip', from: '2026-11-02', to: '2026-11-09' },
        { id: 'one', from: '2026-11-05', to: '2026-11-05' },
        { id: 'away', from: '2026-11-20', to: '2026-11-21' },
      ],
      days,
    );
    expect(bars.map((b) => [b.item.id, b.first, b.last, b.lane, b.before, b.after])).toEqual([
      ['conf', 0, 2, 0, true, false],
      ['trip', 1, 6, 1, false, true],
      ['one', 4, 4, 0, false, false],
    ]);
  });

  it('view settings fill in their defaults', () => {
    const s = calendarSettingsOf({ date_column_id: 'tl' });
    expect(s).toMatchObject({ show_hours: false, time_source: 'timeline', snap: 15, day_start: 7, day_end: 21 });
    expect(s.default_duration).toBe(60);
  });
});

describe('timeline "with hours"', () => {
  const def = columnTypes.get('timeline')!;
  const ctx = { people: [] };
  it('keeps both times or neither, the end after the start on one day', () => {
    expect(
      parseCellValue(def, {}, { from: '2026-11-03', to: '2026-11-03', from_time: '09:00', to_time: '10:00' }).ok,
    ).toBe(true);
    expect(parseCellValue(def, {}, { from: '2026-11-03', to: '2026-11-03', from_time: '09:00' }).ok).toBe(false);
    expect(
      parseCellValue(def, {}, { from: '2026-11-03', to: '2026-11-03', from_time: '10:00', to_time: '09:00' }).ok,
    ).toBe(false);
    expect(
      parseCellValue(def, {}, { from: '2026-11-03', to: '2026-11-04', from_time: '22:00', to_time: '02:00' }).ok,
    ).toBe(true);
  });

  it('as text, and back', () => {
    const one = { from: '2026-11-03', to: '2026-11-03', from_time: '09:00', to_time: '10:30' };
    const text = def.toText(one, {}, {});
    expect(text).toBe('03/11/2026 09:00 – 10:30');
    expect(def.fromText?.(text, {}, ctx)).toEqual(one);
    const two = { from: '2026-11-03', to: '2026-11-04', from_time: '22:00', to_time: '02:00' };
    expect(def.fromText?.(def.toText(two, {}, {}), {}, ctx)).toEqual(two);
    expect(def.fromText?.('03/11/2026 10:00 – 09:00', {}, ctx)).toBeUndefined();
    // Plain days as before.
    expect(def.fromText?.('03/11/2026 – 05/11/2026', {}, ctx)).toEqual({ from: '2026-11-03', to: '2026-11-05' });
  });
});
