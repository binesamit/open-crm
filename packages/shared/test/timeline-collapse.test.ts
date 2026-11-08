// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  addDays,
  applyDrag,
  type Axis,
  axisColumns,
  axisSkips,
  axisWidth,
  collapseAxis,
  columnOf,
  dayAt,
  daysBetween,
  DEFAULT_CALENDAR,
  isHiddenDay,
  lightDays,
  shiftByColumns,
  spanBox,
  ticks,
  workdaysOnlyAxis,
  xOf,
  type Span,
} from '../src';

/**
 * "Working days only" timelines: the collapsed axis. September 2026 in the default (Israeli)
 * calendar, Fri–Sat weekend: Tue 1 … Thu 10, Fri 11 – Sat 12 weekend (Rosh Hashana 12–13), Sun 13 Rosh Hashana
 * (off), Mon 14 … Thu 17, Fri 18 – Sat 19 weekend, Sun 20 Erev Yom Kippur (half), Mon 21 Yom Kippur (off), Tue 22.
 */
const s = (from: string, to: string): Span => ({ from, to });
const plain: Axis = { start: '2026-09-01', days: 30, pxPerDay: 40, zoom: 'day', firstDay: 0 };
const axis = workdaysOnlyAxis(plain, DEFAULT_CALENDAR, 'fri_sat');
const PX = 40;

describe('collapsed time axis', () => {
  it('leaves out weekends and days off, keeps half days', () => {
    expect(axis.visible).toBeDefined();
    for (const d of ['2026-09-04', '2026-09-05', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-21'])
      expect(isHiddenDay(axis, d)).toBe(true);
    for (const d of ['2026-09-10', '2026-09-14', '2026-09-20', '2026-09-22']) expect(isHiddenDay(axis, d)).toBe(false);
    expect(axisWidth(axis)).toBe(axisColumns(axis) * PX);
    expect(axisColumns(axis)).toBeLessThan(plain.days);
  });

  it('maps days to visible columns across Rosh Hashana, the weekend and Yom Kippur', () => {
    // Tue 1, Wed 2, Thu 3 = 0..2; Fri 4 – Sat 5 hidden; Sun 6 … Thu 10 = 3..7; Mon 14 = 8.
    expect(columnOf(axis, '2026-09-10')).toBe(7);
    expect(columnOf(axis, '2026-09-14')).toBe(8);
    // A hidden day sits where the next visible day starts.
    expect(xOf(axis, '2026-09-11')).toBe(8 * PX);
    expect(xOf(axis, '2026-09-13')).toBe(8 * PX);
    expect(columnOf(axis, '2026-09-17')).toBe(11);
    expect(columnOf(axis, '2026-09-20')).toBe(12); // the half day keeps its column
    expect(columnOf(axis, '2026-09-21')).toBe(13); // Yom Kippur → Tue 22's column
    expect(columnOf(axis, '2026-09-22')).toBe(13);
    // dayAt is the inverse on visible days.
    expect(dayAt(axis, 8 * PX + 5)).toBe('2026-09-14');
    expect(dayAt(axis, 7 * PX + 39)).toBe('2026-09-10');
    expect(dayAt(axis, 13 * PX)).toBe('2026-09-22');
  });

  it('snaps a span over hidden days to the visible ones', () => {
    // Thu 10 – Mon 14: two visible columns.
    expect(spanBox(axis, s('2026-09-10', '2026-09-14'))).toEqual({ start: 7 * PX, width: 2 * PX });
    // Starting on Rosh Hashana (Sat 12) → drawn from Mon 14; ending on Yom Kippur → up to Sun 20.
    expect(spanBox(axis, s('2026-09-12', '2026-09-21'))).toEqual({ start: 8 * PX, width: 5 * PX });
    // Only hidden days: the minimum width at the next visible column.
    expect(spanBox(axis, s('2026-09-11', '2026-09-13'))).toEqual({ start: 8 * PX, width: 4 });
  });

  it('steps through visible columns', () => {
    expect(shiftByColumns(axis, '2026-09-10', 1)).toBe('2026-09-14');
    expect(shiftByColumns(axis, '2026-09-14', -1)).toBe('2026-09-10');
    expect(shiftByColumns(axis, '2026-09-17', 1)).toBe('2026-09-20');
    expect(shiftByColumns(axis, '2026-09-17', 2)).toBe('2026-09-22');
    expect(shiftByColumns(axis, '2026-09-22', -2)).toBe('2026-09-17');
    // From a hidden day the first step lands on the next / previous visible day.
    expect(shiftByColumns(axis, '2026-09-12', 1)).toBe('2026-09-14');
    expect(shiftByColumns(axis, '2026-09-12', -1)).toBe('2026-09-10');
    expect(shiftByColumns(axis, '2026-09-21', 1)).toBe('2026-09-22');
    expect(shiftByColumns(axis, '2026-09-21', -1)).toBe('2026-09-20');
    expect(shiftByColumns(axis, '2026-09-12', 0)).toBe('2026-09-12');
    // Past the axis it counts on in calendar days.
    expect(shiftByColumns(axis, '2026-09-30', 2)).toBe('2026-10-02');
  });

  it('moves a bar by visible columns across Rosh Hashana and the weekend', () => {
    // Wed 9 – Thu 10, one column later: Thu 10 – Mon 14 (over the weekend and Rosh Hashana).
    expect(applyDrag(s('2026-09-09', '2026-09-10'), 1, 'move', null, axis)).toEqual(s('2026-09-10', '2026-09-14'));
    // Mon 14 – Thu 17, one column back: Thu 10 – Wed 16.
    expect(applyDrag(s('2026-09-14', '2026-09-17'), -1, 'move', null, axis)).toEqual(s('2026-09-10', '2026-09-16'));
    // Keeping working days: Mon 14 – Thu 17 (4) a column later starts Tue 15 and needs Tue 22 (Sun 20 is ½).
    const keep = { mode: 'workdays' as const, calendar: DEFAULT_CALENDAR, weekend: 'fri_sat' as const };
    expect(applyDrag(s('2026-09-14', '2026-09-17'), 1, 'move', keep, axis)).toEqual(s('2026-09-15', '2026-09-22'));
  });

  it('resizes each edge by visible columns across Rosh Hashana and Yom Kippur', () => {
    // End edge: Thu 10 + 1 column = Mon 14; Thu 17 + 2 = Tue 22 (Yom Kippur skipped).
    expect(applyDrag(s('2026-09-08', '2026-09-10'), 1, 'end', null, axis)).toEqual(s('2026-09-08', '2026-09-14'));
    expect(applyDrag(s('2026-09-14', '2026-09-17'), 2, 'end', null, axis)).toEqual(s('2026-09-14', '2026-09-22'));
    // Start edge: Mon 14 − 1 column = Thu 10; Tue 22 − 1 = Sun 20 (the half day).
    expect(applyDrag(s('2026-09-14', '2026-09-17'), -1, 'start', null, axis)).toEqual(s('2026-09-10', '2026-09-17'));
    expect(applyDrag(s('2026-09-22', '2026-09-24'), -1, 'start', null, axis)).toEqual(s('2026-09-20', '2026-09-24'));
    // An edge never crosses the other.
    expect(applyDrag(s('2026-09-10', '2026-09-14'), 3, 'start', null, axis)).toEqual(s('2026-09-14', '2026-09-14'));
    expect(applyDrag(s('2026-09-10', '2026-09-14'), -3, 'end', null, axis)).toEqual(s('2026-09-10', '2026-09-10'));
  });

  it('moves across Yom Kippur', () => {
    // Sun 20 – Tue 22, one column later: Tue 22 – Wed 23.
    expect(applyDrag(s('2026-09-20', '2026-09-22'), 1, 'move', null, axis)).toEqual(s('2026-09-22', '2026-09-23'));
    expect(applyDrag(s('2026-09-22', '2026-09-22'), -1, 'move', null, axis)).toEqual(s('2026-09-20', '2026-09-20'));
  });

  it('cuts header ticks into visible columns only', () => {
    const days = ticks(axis, 'day');
    expect(days.map((t) => t.start)).not.toContain('2026-09-21');
    expect(days.map((t) => t.start)).not.toContain('2026-09-12');
    expect(days).toHaveLength(axisColumns(axis));
    for (const unit of ['week', 'month'] as const) {
      const list = ticks(axis, unit);
      expect(list.reduce((n, t) => n + t.days, 0)).toBe(axisColumns(axis));
      expect(list.every((t) => !isHiddenDay(axis, t.start))).toBe(true);
    }
    // The week of Sun 13 (Rosh Hashana) starts at its first visible day.
    expect(ticks(axis, 'week').map((t) => t.start)).toContain('2026-09-14');
  });

  it('lists what was skipped', () => {
    const skips = axisSkips(axis);
    expect(skips.find((k) => k.col === 8)?.days).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
    expect(skips.find((k) => k.col === 13)?.days).toEqual(['2026-09-21']);
    expect(skips.find((k) => k.col === 12)?.days).toEqual(['2026-09-18', '2026-09-19']);
  });

  it('leaves a plain axis exactly as it was', () => {
    expect(collapseAxis(plain, () => false)).toBe(plain);
    expect(collapseAxis(plain, () => true)).toBe(plain); // nothing left to show
    expect(axisSkips(plain)).toEqual([]);
    expect(axisWidth(plain)).toBe(30 * PX);
    for (let i = -3; i < 34; i++) {
      const d = addDays(plain.start, i);
      expect(xOf(plain, d)).toBe(daysBetween(plain.start, d) * PX);
      expect(shiftByColumns(plain, d, 3)).toBe(addDays(d, 3));
      expect(isHiddenDay(plain, d)).toBe(false);
    }
    expect(spanBox(plain, s('2026-09-11', '2026-09-13'))).toEqual({ start: 10 * PX, width: 3 * PX });
    expect(dayAt(plain, 10 * PX + 1)).toBe('2026-09-11');
    const span = s('2026-09-10', '2026-09-14');
    for (const edge of ['move', 'start', 'end'] as const)
      expect(applyDrag(span, 2, edge, null, plain)).toEqual(applyDrag(span, 2, edge));
    expect(ticks(plain, 'day')).toHaveLength(30);
  });
});

describe('light days of a span', () => {
  it('lists the days that count less than one, from the shared engine', () => {
    expect(lightDays(s('2026-09-17', '2026-09-22'), 'workdays', DEFAULT_CALENDAR, 'fri_sat')).toEqual([
      { day: '2026-09-18', index: 1, weight: 0 },
      { day: '2026-09-19', index: 2, weight: 0 },
      { day: '2026-09-20', index: 3, weight: 0.5 },
      { day: '2026-09-21', index: 4, weight: 0 },
    ]);
    // Weekdays: only the weekend.
    expect(lightDays(s('2026-09-17', '2026-09-22'), 'weekdays', DEFAULT_CALENDAR, 'fri_sat').map((d) => d.day)).toEqual(
      ['2026-09-18', '2026-09-19'],
    );
    expect(lightDays(s('2026-09-17', '2026-09-22'), 'calendar', DEFAULT_CALENDAR, 'fri_sat')).toEqual([]);
    // Too long to draw day by day.
    expect(lightDays(s('2026-01-01', '2027-12-31'), 'workdays', DEFAULT_CALENDAR, 'fri_sat')).toEqual([]);
  });
});
