// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  aggregateWorkload,
  applyDrag,
  bucketCapacity,
  buildAxis,
  columnTypes,
  countDays,
  criticalPath,
  DEFAULT_CALENDAR,
  dayAt,
  daysBetween,
  dragDays,
  linksOfValue,
  loadLevel,
  offsetInAxis,
  parseCellValue,
  planShifts,
  remapViewSettings,
  requiredShift,
  spanBox,
  spanToValue,
  startOfUnit,
  ticks,
  viewSettingsSchema,
  wouldCycle,
  workingDays,
  workloadBuckets,
  type DepLink,
  type Span,
} from '../src';

const s = (from: string, to: string): Span => ({ from, to });

describe('time axis', () => {
  it('aligns units to the account week start, months, quarters and years', () => {
    // 2026-10-07 is a Wednesday.
    expect(startOfUnit('2026-10-07', 'week', 0)).toBe('2026-10-04'); // Sunday
    expect(startOfUnit('2026-10-07', 'week', 1)).toBe('2026-10-05'); // Monday
    expect(startOfUnit('2026-10-07', 'month')).toBe('2026-10-01');
    expect(startOfUnit('2026-11-20', 'quarter')).toBe('2026-10-01');
    expect(startOfUnit('2026-11-20', 'year')).toBe('2026-01-01');
  });

  it('builds an axis of whole major units around the items and today', () => {
    const axis = buildAxis('day', s('2026-10-10', '2026-10-12'), '2026-10-05', 0);
    expect(axis.start).toBe('2026-09-01'); // padded back a week, then to the month's start
    expect(axis.pxPerDay).toBe(40);
    expect(daysBetween(axis.start, '2026-10-12')).toBeLessThan(axis.days);
    // An empty board still shows a stretch around today.
    const empty = buildAxis('month', null, '2026-10-05', 0);
    expect(empty.days).toBeGreaterThanOrEqual(365);
  });

  it('places bars from the inline start and finds days under offsets', () => {
    const axis = buildAxis('day', null, '2026-10-05', 0);
    const box = spanBox(axis, s('2026-10-05', '2026-10-07'));
    expect(box.width).toBe(3 * 40);
    expect(dayAt(axis, box.start)).toBe('2026-10-05');
    expect(dayAt(axis, box.start + box.width - 1)).toBe('2026-10-07');
  });

  it('reads pointer offsets and drags in RTL (time flows to the left)', () => {
    const rect = { left: 100, right: 900 };
    expect(offsetInAxis(880, rect, 'rtl')).toBe(20);
    expect(offsetInAxis(120, rect, 'ltr')).toBe(20);
    // Dragging 80px to the left at 40px/day: two days later in RTL, two days earlier in LTR.
    expect(dragDays(-80, 40, 'rtl')).toBe(2);
    expect(dragDays(-80, 40, 'ltr')).toBe(-2);
    expect(dragDays(10, 40, 'rtl')).toBe(0);
    expect(Object.is(dragDays(-10, 40, 'ltr'), 0)).toBe(true); // never -0
  });

  it('moves and resizes spans; an edge never crosses the other', () => {
    const span = s('2026-10-05', '2026-10-07');
    expect(applyDrag(span, 3, 'move')).toEqual(s('2026-10-08', '2026-10-10'));
    expect(applyDrag(span, -1, 'start')).toEqual(s('2026-10-04', '2026-10-07'));
    expect(applyDrag(span, 5, 'start')).toEqual(s('2026-10-07', '2026-10-07'));
    expect(applyDrag(span, -9, 'end')).toEqual(s('2026-10-05', '2026-10-05'));
  });

  it('keeps a moved bar’s working days when the column asks', () => {
    const keep = (mode: 'calendar' | 'weekdays' | 'workdays') => ({
      mode,
      calendar: DEFAULT_CALENDAR,
      weekend: 'fri_sat' as const,
    });
    // Sun 1 – Thu 5 Nov 2026 = 5 working days; a day later it runs Mon 2 – Sun 8 (over the Fri–Sat weekend).
    const week = s('2026-11-01', '2026-11-05');
    expect(applyDrag(week, 1, 'move', keep('workdays'))).toEqual(s('2026-11-02', '2026-11-08'));
    expect(applyDrag(week, 1, 'move', keep('weekdays'))).toEqual(s('2026-11-02', '2026-11-08'));
    // Calendar mode / no setting = the plain shift.
    expect(applyDrag(week, 1, 'move', keep('calendar'))).toEqual(s('2026-11-02', '2026-11-06'));
    expect(applyDrag(week, 1, 'move')).toEqual(s('2026-11-02', '2026-11-06'));
    // Onto Yom Kippur (Mon 21 Sep 2026, a day off): workdays skip it, weekdays count it.
    const three = s('2026-09-15', '2026-09-17'); // Tue–Thu
    expect(applyDrag(three, 6, 'move', keep('workdays'))).toEqual(s('2026-09-21', '2026-09-24'));
    expect(applyDrag(three, 6, 'move', keep('weekdays'))).toEqual(s('2026-09-21', '2026-09-23'));
    expect(countDays('2026-09-21', '2026-09-24', 'workdays', DEFAULT_CALENDAR)).toBe(3);
    // Resizing is never re-counted.
    expect(applyDrag(week, 1, 'end', keep('workdays'))).toEqual(s('2026-11-01', '2026-11-06'));
  });

  it('cuts the header into ticks that cover the axis exactly', () => {
    const axis = buildAxis('week', s('2026-10-01', '2026-12-31'), '2026-10-05', 0);
    for (const unit of ['month', 'week'] as const) {
      const list = ticks(axis, unit);
      expect(list[0]!.start).toBe(axis.start);
      expect(list.reduce((n, t) => n + t.days, 0)).toBe(axis.days);
    }
  });

  it('writes a new span back as the column value (dates keep their time)', () => {
    expect(spanToValue('timeline', s('2026-10-01', '2026-10-03'), { from: 'x', to: 'y' })).toEqual({
      from: '2026-10-01',
      to: '2026-10-03',
    });
    expect(spanToValue('date', s('2026-10-01', '2026-10-01'), { date: '2026-09-01', time: '10:00' })).toEqual({
      date: '2026-10-01',
      time: '10:00',
    });
  });
});

describe('dependencies', () => {
  const link = (item: string, on: string, kind: DepLink['kind'] = 'FS', lag = 0): DepLink => ({ item, on, kind, lag });

  it('finds cycles (also through others, and to itself)', () => {
    const links = [link('b', 'a'), link('c', 'b')];
    expect(wouldCycle(links, 'a', ['c'])).toBe(true);
    expect(wouldCycle(links, 'a', ['a'])).toBe(true);
    expect(wouldCycle(links, 'd', ['c'])).toBe(false);
    // Replacing c's own links does not count them.
    expect(wouldCycle(links, 'c', ['a'])).toBe(false);
  });

  it('computes the shift each kind needs, with lag', () => {
    const a = s('2026-10-01', '2026-10-05');
    expect(requiredShift(a, s('2026-10-04', '2026-10-06'), 'FS', 0)).toBe(2);
    expect(requiredShift(a, s('2026-10-04', '2026-10-06'), 'FS', 1)).toBe(3);
    expect(requiredShift(a, s('2026-10-09', '2026-10-10'), 'FS', 0)).toBe(0);
    expect(requiredShift(a, s('2026-09-30', '2026-10-02'), 'SS', 0)).toBe(1);
    expect(requiredShift(a, s('2026-10-01', '2026-10-03'), 'FF', 0)).toBe(2);
    expect(requiredShift(a, s('2026-09-20', '2026-09-29'), 'SF', 0)).toBe(2);
  });

  const spans = new Map<string, Span>([
    ['a', s('2026-10-01', '2026-10-03')],
    ['b', s('2026-10-06', '2026-10-07')],
    ['c', s('2026-10-10', '2026-10-12')],
  ]);
  const chain = [link('b', 'a'), link('c', 'b')];

  it('strict: dependents shift the same, both ways, down the chain', () => {
    const later = planShifts({
      spans,
      links: chain,
      moved: new Map([['a', { before: spans.get('a')!, after: s('2026-10-03', '2026-10-05') }]]),
      mode: 'strict',
    });
    expect(later.get('b')).toEqual(s('2026-10-08', '2026-10-09'));
    expect(later.get('c')).toEqual(s('2026-10-12', '2026-10-14'));
    const earlier = planShifts({
      spans,
      links: chain,
      moved: new Map([['a', { before: spans.get('a')!, after: s('2026-09-29', '2026-10-01') }]]),
      mode: 'strict',
    });
    expect(earlier.get('b')).toEqual(s('2026-10-04', '2026-10-05'));
    expect(earlier.get('c')).toEqual(s('2026-10-08', '2026-10-10'));
  });

  it('flexible: only when the change makes an overlap, and only as far as needed', () => {
    const small = planShifts({
      spans,
      links: chain,
      moved: new Map([['a', { before: spans.get('a')!, after: s('2026-10-01', '2026-10-04') }]]),
      mode: 'flexible',
    });
    expect(small.size).toBe(0); // b still starts after a ends
    const big = planShifts({
      spans,
      links: chain,
      moved: new Map([['a', { before: spans.get('a')!, after: s('2026-10-01', '2026-10-08') }]]),
      mode: 'flexible',
    });
    expect(big.get('b')).toEqual(s('2026-10-09', '2026-10-10'));
    expect(big.get('c')).toEqual(s('2026-10-11', '2026-10-13')); // b now ends on c's first day
    const back = planShifts({
      spans,
      links: chain,
      moved: new Map([['a', { before: spans.get('a')!, after: s('2026-09-20', '2026-09-22') }]]),
      mode: 'flexible',
    });
    expect(back.size).toBe(0); // never pulled back
  });

  it('visual: nothing moves', () => {
    const none = planShifts({
      spans,
      links: chain,
      moved: new Map([['a', { before: spans.get('a')!, after: s('2026-10-20', '2026-10-25') }]]),
      mode: 'visual',
    });
    expect(none.size).toBe(0);
  });

  it('stops on a cycle that slipped in, and never moves the item the user placed', () => {
    const loop = [link('b', 'a'), link('a', 'b')];
    const out = planShifts({
      spans,
      links: loop,
      moved: new Map([['a', { before: spans.get('a')!, after: s('2026-10-05', '2026-10-07') }]]),
      mode: 'strict',
    });
    expect(out.has('a')).toBe(false);
    expect(out.get('b')).toEqual(s('2026-10-10', '2026-10-11'));
  });

  it('reads a cell value as links (FS / 0 by default)', () => {
    expect(linksOfValue('b', { item_ids: ['a', 'c'], kind: { c: 'SS' }, lag_days: { a: 2 } })).toEqual([
      link('b', 'a', 'FS', 2),
      link('b', 'c', 'SS', 0),
    ]);
  });

  it('marks the critical path (zero slack)', () => {
    const sp = new Map<string, Span>([
      ['a', s('2026-10-01', '2026-10-03')],
      ['b', s('2026-10-04', '2026-10-06')],
      ['x', s('2026-10-01', '2026-10-01')],
    ]);
    expect([...criticalPath(sp, [link('b', 'a')])!].sort()).toEqual(['a', 'b']);
    expect(criticalPath(sp, [link('b', 'a'), link('a', 'b')])).toBeNull();
  });

  it('is a column type with links storage and validated values', () => {
    const def = columnTypes.get('dependency')!;
    expect(def.engine).toBe('links');
    expect(def.settingsSchema.parse({})).toMatchObject({ mode: 'flexible' });
    expect(parseCellValue(def, {}, { item_ids: ['a'], kind: { a: 'XX' } }).ok).toBe(false);
    expect(parseCellValue(def, {}, { item_ids: ['a'], kind: { a: 'SS' }, lag_days: { a: 2 } }).ok).toBe(true);
  });
});

describe('workload', () => {
  // 2026-10-04 is a Sunday; fri_sat weekend = 2026-10-09/10.
  it('spreads effort over working days only', () => {
    expect(workingDays(s('2026-10-08', '2026-10-11'), 'fri_sat')).toEqual(['2026-10-08', '2026-10-11']);
    expect(workingDays(s('2026-10-09', '2026-10-10'), 'fri_sat')).toEqual(['2026-10-09', '2026-10-10']);
  });

  const items = [
    { id: 'i1', people: ['u1'], span: s('2026-10-04', '2026-10-05'), effort: 4 },
    { id: 'i2', people: ['u1', 'u2'], span: s('2026-10-05', '2026-10-05'), effort: 6 },
    { id: 'i3', people: [], span: s('2026-10-05', '2026-10-05'), effort: 1 },
    { id: 'i4', people: ['u2'], span: null, effort: 9 },
  ];
  const range = s('2026-10-04', '2026-10-17');

  it('counts items per day, every assignee carries the item', () => {
    const grid = aggregateWorkload({ items, measure: 'count', unit: 'day', range, weekend: 'fri_sat', firstDay: 0 });
    expect(grid.get('u1')!.get('2026-10-05')).toEqual({ load: 2, items: ['i1', 'i2'] });
    expect(grid.get('u1')!.get('2026-10-04')).toEqual({ load: 1, items: ['i1'] });
    expect(grid.get('u2')!.get('2026-10-05')!.load).toBe(1);
    expect(grid.has('i3')).toBe(false);
  });

  it('sums a column split over working days, per week', () => {
    const grid = aggregateWorkload({ items, measure: 'column', unit: 'week', range, weekend: 'fri_sat', firstDay: 0 });
    expect(grid.get('u1')!.get('2026-10-04')!.load).toBe(10);
    const daily = aggregateWorkload({ items, measure: 'column', unit: 'day', range, weekend: 'fri_sat', firstDay: 0 });
    expect(daily.get('u1')!.get('2026-10-04')!.load).toBe(2);
    expect(daily.get('u1')!.get('2026-10-05')!.load).toBe(8);
  });

  it('gives buckets, capacities and over-capacity levels', () => {
    expect(workloadBuckets(range, 'week', 0)).toEqual(['2026-10-04', '2026-10-11']);
    expect(workloadBuckets(s('2026-10-04', '2026-10-06'), 'day', 0)).toHaveLength(3);
    expect(bucketCapacity('2026-10-04', 'week', 8, 'fri_sat')).toBe(40);
    expect(bucketCapacity('2026-10-09', 'day', 8, 'fri_sat')).toBe(0);
    expect(loadLevel(0, 8)).toBe('none');
    expect(loadLevel(4, 8)).toBe('under');
    expect(loadLevel(8, 8)).toBe('full');
    expect(loadLevel(9, 8)).toBe('over');
    expect(loadLevel(1, 0)).toBe('over');
  });
});

describe('view settings', () => {
  it('parses timeline / gantt / workload settings with defaults', () => {
    const v = viewSettingsSchema.parse({ timeline: {}, gantt: {}, workload: {} });
    expect(v.timeline!.zoom).toBe('week');
    expect(v.gantt!.show_subitems).toBe(true);
    expect(v.workload).toMatchObject({ measure: 'count', unit: 'day', capacity_overrides: {} });
  });

  it('remaps their columns to another board', () => {
    const v = viewSettingsSchema.parse({
      timeline: { date_column_id: 'tl', group_by: '__group__', color_by: 'st' },
      gantt: { date_column_id: 'tl', dependency_column_id: 'deps' },
      workload: { people_column_id: 'p', effort_column_id: 'n' },
    });
    const out = remapViewSettings(v, (k) => (k === 'tl' ? 'tl2' : k === 'p' ? 'p2' : null));
    expect(out.timeline).toMatchObject({ date_column_id: 'tl2', group_by: '__group__', color_by: undefined });
    expect(out.gantt).toMatchObject({ date_column_id: 'tl2', dependency_column_id: undefined });
    expect(out.workload).toMatchObject({ people_column_id: 'p2', effort_column_id: undefined });
  });
});
