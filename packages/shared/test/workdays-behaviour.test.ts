// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  addWorkdays,
  aggregateWorkload,
  bucketCapacity,
  countDays,
  DATE_EXPR_RE,
  dateExprShift,
  dateExprText,
  dateFireAt,
  dateScheduleHash,
  dayCountOf,
  DEFAULT_CALENDAR,
  evaluateDateExpr,
  evaluateFormula,
  parseFormula,
  planShifts,
  relativeSpan,
  requiredShift,
  resolveCalendar,
  shiftSpanCounted,
  triggerSentence,
  triggerSchema,
  workingDays,
  type CalendarConfig,
  type DateEnv,
  type DayCount,
} from '../src';

/**
 * Working days everywhere days are counted: filters, formulas, automations, dependencies, bulk
 * shifts and the workload view all go through the shared engine. Israeli calendar 5787:
 * erev Rosh Hashana Fri 11/09/2026 (half) · Rosh Hashana Sat–Sun 12–13/09 (off) · erev Yom Kippur Sun 20/09 (half)
 * · Yom Kippur Mon 21/09 (off). The weekend is Friday + Saturday unless said otherwise.
 */
const cal = DEFAULT_CALENDAR;
/** Half days count as working days here — the arithmetic is easier to read. */
const calFull: CalendarConfig = resolveCalendar({ half_day: 'work' });
const TZ = 'Asia/Jerusalem';

describe('filters: addWorkdays / within the next N working days', () => {
  it('skips only the weekend without a calendar (as before)', () => {
    expect(addWorkdays('2026-09-10', 1, 'fri_sat')).toBe('2026-09-13');
    expect(addWorkdays('2026-09-17', 2, 'fri_sat')).toBe('2026-09-21');
    expect(addWorkdays('2026-09-14', -1, 'fri_sat')).toBe('2026-09-13');
  });

  it('skips Rosh Hashana and Yom Kippur with the account calendar', () => {
    // Thu 10/09 → Fri, Sat (weekend), Sun 13/09 (Rosh Hashana II) → Mon 14/09.
    expect(addWorkdays('2026-09-10', 1, 'fri_sat', calFull)).toBe('2026-09-14');
    // Thu 17/09 + 2 → Sun 20/09 (erev Yom Kippur, a working day here), skip Mon 21/09 (Yom Kippur) → Tue 22/09.
    expect(addWorkdays('2026-09-17', 2, 'fri_sat', calFull)).toBe('2026-09-22');
    // Backwards across both holidays: Tue 22/09 − 1 → Sun 20/09; − 6 → Thu 10/09.
    expect(addWorkdays('2026-09-22', -1, 'fri_sat', calFull)).toBe('2026-09-20');
    expect(addWorkdays('2026-09-22', -6, 'fri_sat', calFull)).toBe('2026-09-10');
  });

  it('a half day counts half by default (landing needs a whole day)', () => {
    // Thu 17/09 + 1: Sun 20/09 is half a day, Mon 21/09 off → Tue 22/09.
    expect(addWorkdays('2026-09-17', 1, 'fri_sat', cal)).toBe('2026-09-22');
  });

  it('crosses the year (Dec → Jan) and follows a Sat+Sun weekend', () => {
    expect(addWorkdays('2026-12-31', 1, 'fri_sat', cal)).toBe('2027-01-03');
    expect(addWorkdays('2026-12-31', 1, 'sat_sun', cal)).toBe('2027-01-01');
    expect(addWorkdays('2027-01-03', -1, 'fri_sat', cal)).toBe('2026-12-31');
  });

  it('relativeSpan uses the env calendar when present', () => {
    const env: DateEnv = { today: '2026-09-10', timezone: TZ, weekend: 'fri_sat', firstDay: 0 };
    expect(relativeSpan([1, 'workdays'], 'next', env)).toEqual({ from: '2026-09-10', to: '2026-09-13' });
    expect(relativeSpan([1, 'workdays'], 'next', { ...env, calendar: calFull })).toEqual({
      from: '2026-09-10',
      to: '2026-09-14',
    });
    expect(relativeSpan([3, 'workdays'], 'last', { ...env, today: '2026-09-22', calendar: calFull })).toEqual({
      from: '2026-09-16',
      to: '2026-09-22',
    });
  });

  it("an account's own day off is skipped too", () => {
    const own = resolveCalendar({}, { custom_days: [{ date: '2026-11-02', name: 'Team day', state: 'off' }] });
    expect(addWorkdays('2026-11-01', 1, 'fri_sat', own)).toBe('2026-11-03');
  });
});

describe('formulas: WORKDAYS / ADD_WORKDAYS', () => {
  const run = (src: string, ctx: Partial<Parameters<typeof evaluateFormula>[1]> = {}) =>
    evaluateFormula(parseFormula(src), { ref: () => null, ...ctx });

  it('keeps the old result without a calendar (Fri+Sat)', () => {
    expect(run('WORKDAYS("2026-10-08","2026-10-04")')).toBe(5);
    expect(run('WORKDAYS("2026-09-24","2026-09-10")')).toBe(11);
    expect(run('WORKDAYS("2026-09-10","2026-09-24")')).toBe(-11);
  });

  it('follows the account weekend', () => {
    // Thu 10/09 … Thu 24/09 with Sat+Sun off: 15 days − 4 weekend days.
    expect(run('WORKDAYS("2026-09-24","2026-09-10")', { weekend: 'sat_sun' })).toBe(11);
    expect(run('WORKDAYS("2026-10-03","2026-10-02")', { weekend: 'sat_sun' })).toBe(1);
    expect(run('WORKDAYS("2026-10-03","2026-10-02")')).toBe(0);
  });

  it('skips holidays with the calendar (and counts a half day as half)', () => {
    // 11 weekdays − Sun 13/09 (off) − Mon 21/09 (off) − ½ Sun 20/09 (erev Yom Kippur).
    expect(run('WORKDAYS("2026-09-24","2026-09-10")', { calendar: cal })).toBe(8.5);
    expect(run('WORKDAYS("2026-09-24","2026-09-10")', { calendar: calFull })).toBe(9);
  });

  it('equals the engine count on long spans and across years', () => {
    const own = resolveCalendar(
      {},
      {
        custom_days: [
          { date: '2026-12-30', to: '2027-01-05', name: 'Closing', state: 'off' },
          { date: '2027-03-01', name: 'Offsite', state: 'half' },
        ],
      },
    );
    for (const [from, to] of [
      ['2026-01-01', '2027-12-31'],
      ['2026-09-01', '2026-10-31'],
      ['2026-12-20', '2027-01-10'],
      ['2027-03-01', '2027-03-01'],
    ] as const)
      for (const weekend of ['fri_sat', 'sat_sun'] as const)
        expect(run(`WORKDAYS("${to}","${from}")`, { calendar: own, weekend })).toBe(
          countDays(from, to, 'workdays', own, weekend),
        );
  });

  it('ADD_WORKDAYS moves over the weekend, holidays and the year end', () => {
    expect(run('ADD_WORKDAYS("2026-09-10",1)')).toBe('2026-09-13');
    expect(run('ADD_WORKDAYS("2026-09-10",1)', { calendar: cal })).toBe('2026-09-14');
    expect(run('ADD_WORKDAYS("2026-09-22",-1)', { calendar: calFull })).toBe('2026-09-20');
    expect(run('ADD_WORKDAYS("2026-12-31",1)', { calendar: cal })).toBe('2027-01-03');
    expect(run('ADD_WORKDAYS("2026-12-31",1)', { calendar: cal, weekend: 'sat_sun' })).toBe('2027-01-01');
    expect(run('ADD_WORKDAYS("",1)')).toBeNull();
  });
});

describe('automations: +Nwd and "N working days before"', () => {
  const env = {
    today: '2026-09-17',
    timezone: TZ,
    now: new Date('2026-09-17T08:00:00Z'),
    columnDate: (key: string) => (key === 'due' ? '2026-09-22' : null),
  };

  it('parses the wd unit', () => {
    expect(DATE_EXPR_RE.test('today+3wd')).toBe(true);
    expect(DATE_EXPR_RE.test('column:due-2wd@09:00')).toBe(true);
    expect(DATE_EXPR_RE.test('today+3wx')).toBe(false);
    expect(dateExprShift('+3wd')).toEqual({ n: 3, unit: 'wd' });
    expect(dateExprShift('-2w')).toEqual({ n: -2, unit: 'w' });
  });

  it('set_date counts working days of the account calendar', () => {
    expect(evaluateDateExpr('today+2wd', { ...env, calendar: calFull, weekend: 'fri_sat' })).toEqual({
      date: '2026-09-22',
    });
    expect(evaluateDateExpr('column:due-1wd', { ...env, calendar: calFull, weekend: 'fri_sat' })).toEqual({
      date: '2026-09-20',
    });
    // Calendar days are unchanged.
    expect(evaluateDateExpr('today+2d', { ...env, calendar: calFull })).toEqual({ date: '2026-09-19' });
    expect(evaluateDateExpr('today+1w', env)).toEqual({ date: '2026-09-24' });
  });

  it('the sentence says working days', () => {
    expect(dateExprText('today+3wd', { columns: [], groups: [] }, 'he')).toContain('ימי עבודה');
    const board = { columns: [{ key: 'due', title: 'Due', type: 'date' }], groups: [] };
    const text = (tr: unknown) =>
      triggerSentence(triggerSchema.parse(tr), board, 'he')
        .map((p) => p.text)
        .join('');
    expect(text({ type: 'date_arrives_before', column: 'due', days: 2, workdays: true })).toContain('ימי עבודה');
    expect(text({ type: 'date_arrives_before', column: 'due', days: 2 })).not.toContain('ימי עבודה');
    expect(text({ type: 'date_arrived', column: 'due', offset_days: 3, workdays: true })).toContain('ימי עבודה');
    expect(text({ type: 'date_arrived', column: 'due', offset_days: -3, workdays: true })).toContain('ימי עבודה');
  });

  it('date triggers fire N working days before / after', () => {
    const before = triggerSchema.parse({ type: 'date_arrives_before', column: 'due', days: 1, workdays: true });
    const work = { weekend: 'fri_sat' as const, calendar: calFull };
    // Due Tue 22/09: one working day before is Sun 20/09 (Mon 21/09 is Yom Kippur); 09:00 IDT = 06:00Z.
    expect(dateFireAt(before as never, '2026-09-22', TZ, work).toISOString()).toBe('2026-09-20T06:00:00.000Z');
    // Without the flag: calendar days, as before.
    const plain = { ...before, workdays: undefined };
    expect(dateFireAt(plain as never, '2026-09-22', TZ, work).toISOString()).toBe('2026-09-21T06:00:00.000Z');
    // After, over the year end: Thu 31/12 + 1 working day → Sun 03/01/2027 (IST, 07:00Z).
    const after = triggerSchema.parse({ type: 'date_arrived', column: 'due', offset_days: 1, workdays: true });
    expect(dateFireAt(after as never, '2026-12-31', TZ, work).toISOString()).toBe('2027-01-03T07:00:00.000Z');
    // A date with a time keeps its clock.
    expect(dateFireAt(after as never, '2026-09-10T10:30:00.000Z', TZ, work).toISOString()).toBe(
      '2026-09-14T10:30:00.000Z',
    );
    // Switching the flag re-arms the schedule.
    expect(dateScheduleHash(before as never, '2026-09-22')).not.toBe(dateScheduleHash(plain as never, '2026-09-22'));
  });
});

describe('dependencies and bulk shifts count working days', () => {
  const wd: DayCount = { mode: 'workdays', calendar: calFull, weekend: 'fri_sat' };
  const s = (from: string, to: string) => ({ from, to });

  it('dayCountOf: the column duration, else the account', () => {
    expect(dayCountOf({}, cal, 'fri_sat').mode).toBe(cal.duration);
    expect(dayCountOf({ duration: 'account' }, resolveCalendar({ duration: 'workdays' }), 'fri_sat').mode).toBe(
      'workdays',
    );
    expect(dayCountOf({ duration: 'weekdays', keep_workdays: true }, cal, 'sat_sun')).toMatchObject({
      mode: 'weekdays',
      keepWorkdays: true,
      weekend: 'sat_sun',
    });
  });

  it('requiredShift: "after" is the next working day, lags count working days', () => {
    const pred = s('2026-09-08', '2026-09-10');
    // Calendar: the next day (Fri 11/09) — unchanged behaviour.
    expect(requiredShift(pred, s('2026-09-11', '2026-09-11'), 'FS', 0)).toBe(0);
    // Working days: Fri, Sat, Sun 13/09 (Rosh Hashana) are not → Mon 14/09.
    expect(requiredShift(pred, s('2026-09-11', '2026-09-11'), 'FS', 0, wd)).toBe(3);
    // A lag of 1 working day → Tue 15/09.
    expect(requiredShift(pred, s('2026-09-11', '2026-09-11'), 'FS', 1, wd)).toBe(4);
    // SS with a lag over Yom Kippur: Thu 17/09 + 2 → Tue 22/09.
    expect(requiredShift(s('2026-09-17', '2026-09-17'), s('2026-09-17', '2026-09-17'), 'SS', 2, wd)).toBe(5);
  });

  it('flexible: the dependent is pushed to the next working day', () => {
    const out = planShifts({
      spans: new Map([
        ['a', s('2026-09-06', '2026-09-08')],
        ['b', s('2026-09-09', '2026-09-10')],
      ]),
      links: [{ item: 'b', on: 'a', kind: 'FS', lag: 0 }],
      moved: new Map([['a', { before: s('2026-09-06', '2026-09-08'), after: s('2026-09-06', '2026-09-10') }]]),
      mode: 'flexible',
      count: wd,
    });
    // b starts Mon 14/09; its calendar length (2 days) is kept → 15/09.
    expect(out.get('b')).toEqual(s('2026-09-14', '2026-09-15'));
  });

  it('strict: the dependent moves as many working days as its predecessor, keeping its working days', () => {
    const moved = new Map([['a', { before: s('2026-09-06', '2026-09-08'), after: s('2026-09-06', '2026-09-09') }]]);
    const spans = new Map([
      ['a', s('2026-09-06', '2026-09-08')],
      ['b', s('2026-09-17', '2026-09-20')],
    ]);
    const links = [{ item: 'b', on: 'a', kind: 'FS' as const, lag: 0 }];
    // a's end moved 1 working day; b (Thu 17 → Sun 20 = 2 working days) starts Sun 20/09 …
    const calendarLen = planShifts({ spans, links, moved, mode: 'strict', count: wd });
    expect(calendarLen.get('b')).toEqual(s('2026-09-20', '2026-09-23'));
    // … and with keep_workdays ends after 2 working days: Sun 20, (Yom Kippur), Tue 22.
    const kept = planShifts({ spans, links, moved, mode: 'strict', count: { ...wd, keepWorkdays: true } });
    expect(kept.get('b')).toEqual(s('2026-09-20', '2026-09-22'));
    // Without a count: calendar days, as before.
    expect(planShifts({ spans, links, moved, mode: 'strict' }).get('b')).toEqual(s('2026-09-18', '2026-09-21'));
  });

  it('bulk shift: N working days, across the year end', () => {
    expect(shiftSpanCounted(s('2026-12-31', '2026-12-31'), 1, wd)).toEqual(s('2027-01-03', '2027-01-03'));
    expect(shiftSpanCounted(s('2026-09-10', '2026-09-14'), 1, { ...wd, keepWorkdays: true })).toEqual(
      s('2026-09-14', '2026-09-15'),
    );
    expect(shiftSpanCounted(s('2026-09-10', '2026-09-14'), 1)).toEqual(s('2026-09-11', '2026-09-15'));
    expect(shiftSpanCounted(s('2026-09-10', '2026-09-14'), 1, { mode: 'calendar' })).toEqual(
      s('2026-09-11', '2026-09-15'),
    );
  });
});

describe('workload: holidays carry no work', () => {
  it('workingDays and capacity skip days off (a half day has half)', () => {
    expect(workingDays({ from: '2026-09-17', to: '2026-09-22' }, 'fri_sat')).toEqual([
      '2026-09-17',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
    ]);
    expect(workingDays({ from: '2026-09-17', to: '2026-09-22' }, 'fri_sat', cal)).toEqual([
      '2026-09-17',
      '2026-09-20',
      '2026-09-22',
    ]);
    // Only days off: the item keeps its own days.
    expect(workingDays({ from: '2026-09-21', to: '2026-09-21' }, 'fri_sat', cal)).toEqual(['2026-09-21']);
    expect(bucketCapacity('2026-09-21', 'day', 8, 'fri_sat', cal)).toBe(0);
    expect(bucketCapacity('2026-09-20', 'day', 8, 'fri_sat', cal)).toBe(4);
    expect(bucketCapacity('2026-09-21', 'day', 8, 'fri_sat')).toBe(8);
    // The week of 20/09: Sun ½ + Mon 0 + Tue–Thu 3 = 3.5 days.
    expect(bucketCapacity('2026-09-20', 'week', 8, 'fri_sat', cal)).toBe(28);
  });

  it('spreads effort over working days only', () => {
    const grid = aggregateWorkload({
      items: [{ id: 'x', people: ['p'], span: { from: '2026-09-20', to: '2026-09-22' }, effort: 6 }],
      measure: 'column',
      unit: 'day',
      range: { from: '2026-09-01', to: '2026-09-30' },
      weekend: 'fri_sat',
      firstDay: 0,
      calendar: cal,
    });
    expect([...grid.get('p')!.entries()].map(([d, c]) => [d, c.load])).toEqual([
      ['2026-09-20', 3],
      ['2026-09-22', 3],
    ]);
  });
});
