// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { cellFromText } from '../src/columns/from-text';
import { evaluateDateExpr } from '../src/automations/date-expr';
import { nextPeriodFire } from '../src/automations/schedule';
import { TRIGGERS, type AutomationEvent } from '../src/automations/triggers';
import { DEFAULT_REGION } from '../src/locale/format';

/** Audit 2026-10-10 — dates and automations round 2: A1, A2, automations #8 and #9. */
const JLM = { ...DEFAULT_REGION, timezone: 'Asia/Jerusalem' };

describe('A1 — a typed date with a time is wall-clock in the region', () => {
  it('stores the UTC instant when a region is given; UTC as before without one', () => {
    // 15 Oct 2026, 14:00 in Jerusalem (UTC+3) = 11:00Z.
    expect(cellFromText('date', '15/10/2026 14:00', {}, [], { region: JLM })).toEqual({
      date: '2026-10-15',
      time: '11:00',
    });
    // Past midnight UTC: the stored date is the day before.
    expect(cellFromText('date', '15/10/2026 01:30', {}, [], { region: JLM })).toEqual({
      date: '2026-10-14',
      time: '22:30',
    });
    expect(cellFromText('date', '15/10/2026 14:00', {})).toEqual({ date: '2026-10-15', time: '14:00' });
    expect(cellFromText('date', '15/10/2026', {}, [], { region: JLM })).toEqual({ date: '2026-10-15' });
  });
});

describe('A2 — a monthly trigger on the 29th–31st', () => {
  const t = { type: 'every_time_period', period: 'month', day_of_month: 31, time: '09:00' } as const;
  it('fires on the last day of a shorter month, then on the 31st again', () => {
    // 09:00 in Jerusalem in February = 07:00Z.
    expect(nextPeriodFire(t as never, new Date('2026-02-10T12:00:00Z'), 'Asia/Jerusalem').toISOString()).toBe(
      '2026-02-28T07:00:00.000Z',
    );
    // Right after it fired: the 31st of March (not the 28th).
    expect(nextPeriodFire(t as never, new Date('2026-02-28T07:00:30Z'), 'Asia/Jerusalem').toISOString()).toBe(
      '2026-03-31T06:00:00.000Z',
    );
    // December → January of the next year.
    expect(nextPeriodFire(t as never, new Date('2026-12-31T10:00:00Z'), 'Asia/Jerusalem').toISOString()).toBe(
      '2027-01-31T07:00:00.000Z',
    );
  });
});

describe('#9 — `column:x@HH:MM` takes the account’s local day', () => {
  const env = (iso: string) => ({
    today: '2026-10-10',
    now: new Date('2026-10-10T12:00:00Z'),
    timezone: 'Asia/Jerusalem',
    columnDate: () => iso,
  });
  it('22:30Z is already the 11th in Jerusalem', () => {
    // 11 Oct 09:00 Jerusalem = 06:00Z.
    expect(evaluateDateExpr('column:x@09:00', env('2026-10-10T22:30:00Z'))).toEqual({
      date: '2026-10-11',
      time: '06:00',
    });
    // Moving by days keeps the local day too; an hour shift stays on the instant.
    expect(evaluateDateExpr('column:x+1d', env('2026-10-10T22:30:00Z'))).toEqual({
      date: '2026-10-12',
      time: '22:30',
    });
    expect(evaluateDateExpr('column:x+2h', env('2026-10-10T22:30:00Z'))).toEqual({
      date: '2026-10-11',
      time: '00:30',
    });
    expect(evaluateDateExpr('column:x@09:00', env('2026-10-10'))).toEqual({ date: '2026-10-10', time: '06:00' });
  });
});

describe('#8 — `column_changed` ignores a write that left the value as it was', () => {
  const ev = (before: unknown, after: unknown): AutomationEvent => ({
    id: 'e',
    type: 'cell.changed',
    board_id: 'b',
    item_id: 'i',
    column_key: 'priority',
    before: { value: before },
    after: { value: after },
    actor: { type: 'user', id: 'u' },
  });
  const t = { type: 'column_changed', column: 'priority' } as const;
  const ctx = { automationId: 'a', columns: [] };
  it('same value (key order aside): no match; a real change: match', () => {
    expect(TRIGGERS.column_changed.match(t as never, ev({ index: 1 }, { index: 1 }), ctx)).toBe(false);
    expect(TRIGGERS.column_changed.match(t as never, ev('high', 'high'), ctx)).toBe(false);
    expect(TRIGGERS.column_changed.match(t as never, ev({ a: 1, b: 2 }, { b: 2, a: 1 }), ctx)).toBe(false);
    expect(TRIGGERS.column_changed.match(t as never, ev({ index: 1 }, { index: 2 }), ctx)).toBe(true);
    expect(TRIGGERS.column_changed.match(t as never, ev(null, 'x'), ctx)).toBe(true);
    // An event without both sides is a change.
    const bare = { ...ev(null, null), before: undefined, after: undefined };
    expect(TRIGGERS.column_changed.match(t as never, bare, ctx)).toBe(true);
  });
});

/** Audit 2026-10-10 — lows: A3, A4, C2 and worker #10. */
import { importCellText } from '../src/bulk/import';
import { dateFireAt } from '../src/automations/schedule';

describe('A3 / A4 — typed dates follow the account: day / month order and the week start', () => {
  const US = { ...DEFAULT_REGION, timezone: 'America/New_York', date_format: 'MM/DD/YYYY', first_day: 1 };

  it('a date, a timeline and a week read month-first on an MM/DD/YYYY account', () => {
    expect(cellFromText('date', '03/10/2026', {}, [], { region: US })).toEqual({ date: '2026-03-10' });
    expect(cellFromText('date', '10/13/2026', {}, [], { region: US })).toEqual({ date: '2026-10-13' });
    expect(cellFromText('date', '03/10/2026', {}, [], { region: JLM })).toEqual({ date: '2026-10-03' });
    expect(cellFromText('timeline', '03/10/2026 – 03/12/2026', {}, [], { region: US })).toEqual({
      from: '2026-03-10',
      to: '2026-03-12',
    });
    expect(cellFromText('week', '10/14/2026', {}, [], { region: US })).toEqual({
      start: '2026-10-12',
      end: '2026-10-18',
    });
  });

  it('a week without a column first day starts on the account first day, as the picker does', () => {
    // Wed 14 Oct 2026: Monday-start account → Mon 12 – Sun 18; the column's own first day wins when set.
    expect(cellFromText('week', '2026-10-14', {}, [], { region: { ...JLM, first_day: 1 } })).toEqual({
      start: '2026-10-12',
      end: '2026-10-18',
    });
    expect(cellFromText('week', '2026-10-14', {}, [], { region: JLM })).toEqual({
      start: '2026-10-11',
      end: '2026-10-17',
    });
    expect(cellFromText('week', '2026-10-14', { first_day: 0 }, [], { region: { ...JLM, first_day: 1 } })).toEqual({
      start: '2026-10-11',
      end: '2026-10-17',
    });
  });
});

describe('C2 — an xlsx time-only cell is a time, not a date in 1899', () => {
  it('renders HH:MM for an Excel serial below 1; dates keep their text', () => {
    expect(importCellText(new Date('1899-12-30T09:36:00Z'))).toBe('09:36');
    expect(importCellText(new Date('2026-10-15T00:00:00Z'))).toBe('2026-10-15');
    expect(importCellText(new Date('2026-10-15T09:36:00Z'))).toBe('2026-10-15 09:36');
    expect(cellFromText('hour', importCellText(new Date('1899-12-30T09:36:00Z')), {})).toEqual({ hour: 9, minute: 36 });
  });
});

describe('worker #10 — a date-with-time trigger keeps its wall-clock time across a DST change', () => {
  const tz = 'Asia/Jerusalem';
  it('offset days land on the same local time, not n × 24 h later', () => {
    const arrived = { type: 'date_arrived' as const, column: 'd', offset_days: 7, time: '09:00' };
    // 20 Oct 2026 09:00 IDT (06:00Z); DST ends 25 Oct → 27 Oct 09:00 IST is 07:00Z.
    expect(dateFireAt(arrived, '2026-10-20T06:00:00.000Z', tz).toISOString()).toBe('2026-10-27T07:00:00.000Z');
    // No DST crossing: exactly 7 days.
    expect(dateFireAt(arrived, '2026-11-02T07:00:00.000Z', tz).toISOString()).toBe('2026-11-09T07:00:00.000Z');
    // No offset: the moment itself.
    expect(dateFireAt({ ...arrived, offset_days: 0 }, '2026-10-20T06:00:00.000Z', tz).toISOString()).toBe(
      '2026-10-20T06:00:00.000Z',
    );
  });
});
