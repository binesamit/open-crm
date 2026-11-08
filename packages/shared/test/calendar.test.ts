// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { formatTimeline, inRange, isoOf, monthGrid, pickRange, rangeDays, shiftMonth, timelineProgress } from '../src';

describe('calendar', () => {
  it('builds a 6-week grid starting on Sunday', () => {
    const grid = monthGrid(2026, 9); // October 2026 starts on a Thursday
    expect(grid).toHaveLength(42);
    expect(grid[0]).toEqual({ iso: '2026-09-27', inMonth: false });
    expect(grid[4]).toEqual({ iso: '2026-10-01', inMonth: true });
    expect(grid.filter((d) => d.inMonth)).toHaveLength(31);
  });

  it('honours another week start', () => {
    expect(monthGrid(2026, 9, 1)[0]!.iso).toBe('2026-09-28');
  });

  it('shifts months and years across boundaries', () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 5, -12)).toEqual({ year: 2025, month: 5 });
  });

  it('normalises overflowing days', () => {
    expect(isoOf(2026, 1, 29)).toBe('2026-03-01');
    expect(isoOf(2028, 1, 29)).toBe('2028-02-29');
  });

  it('picks a range: start, end, then start again', () => {
    let r = pickRange({ from: null, to: null }, '2026-10-05');
    expect(r).toEqual({ from: '2026-10-05', to: null });
    r = pickRange(r, '2026-10-12');
    expect(r).toEqual({ from: '2026-10-05', to: '2026-10-12' });
    r = pickRange(r, '2026-10-20');
    expect(r).toEqual({ from: '2026-10-20', to: null });
    expect(pickRange(r, '2026-10-01')).toEqual({ from: '2026-10-01', to: '2026-10-20' });
    expect(pickRange(r, '2026-10-20')).toEqual({ from: '2026-10-20', to: '2026-10-20' });
  });

  it('tests membership of a range', () => {
    expect(inRange('2026-10-07', '2026-10-05', '2026-10-12')).toBe(true);
    expect(inRange('2026-10-13', '2026-10-05', '2026-10-12')).toBe(false);
    expect(inRange('2026-10-07', '2026-10-05', null)).toBe(false);
  });
});

describe('timeline label', () => {
  it('DD/MM, the year only across years or outside this year; days inclusive', () => {
    expect(formatTimeline('2026-09-25', '2026-09-26', '2026-10-02')).toBe('25/09 – 26/09');
    expect(formatTimeline('2026-09-30', '2027-10-08', '2026-10-02')).toBe('30/09/26 – 08/10/27');
    expect(formatTimeline('2027-03-01', '2027-03-05', '2026-10-02')).toBe('01/03/27 – 05/03/27');
    expect(formatTimeline('2026-10-02', '2026-10-02', '2026-10-02')).toBe('02/10');
    expect(rangeDays('2026-09-25', '2026-09-26')).toBe(2);
    expect(rangeDays('2026-12-31', '2027-01-01')).toBe(2);
    expect(rangeDays('2026-03-28', '2026-03-30')).toBe(3); // across a DST change
    expect(timelineProgress('2026-10-01', '2026-10-10', '2026-09-01')).toBe(0);
    expect(timelineProgress('2026-10-01', '2026-10-10', '2026-10-05')).toBe(0.5);
    expect(timelineProgress('2026-10-01', '2026-10-10', '2026-11-01')).toBe(1);
  });
});
