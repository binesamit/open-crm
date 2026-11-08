// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { columnTypes, formatDuration, parseCellValue, parseDuration, validateEntryRange } from '../src';

describe('time tracking (03 §3.3, M1.1 #11)', () => {
  it('formats durations', () => {
    expect(formatDuration(9015)).toBe('02:30:15');
    expect(formatDuration(9015, { show_seconds: false })).toBe('02:30');
    expect(formatDuration(9000, { display: 'decimal_hours' })).toBe('2.5h');
    expect(formatDuration(7200, { display: 'decimal_hours' })).toBe('2h');
    expect(formatDuration(-5)).toBe('00:00:00');
  });

  it('reads the manual duration formats', () => {
    expect(parseDuration('1:30')).toBe(5400);
    expect(parseDuration('1:30:15')).toBe(5415);
    expect(parseDuration('1.5h')).toBe(5400);
    expect(parseDuration('1,5')).toBe(5400);
    expect(parseDuration('90m')).toBe(5400);
    expect(parseDuration('45 דק')).toBe(2700);
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('1:75')).toBeNull();
  });

  it('validates manual ranges', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const at = (iso: string) => new Date(iso);
    expect(validateEntryRange(at('2026-10-02T09:00:00Z'), at('2026-10-02T10:30:00Z'), now)).toBeNull();
    expect(validateEntryRange(at('2026-10-02T11:00:00Z'), at('2026-10-02T13:00:00Z'), now)).toBe('time_in_future');
    expect(validateEntryRange(at('2026-10-02T10:00:00Z'), at('2026-10-02T09:00:00Z'), now)).toBe(
      'time_end_before_start',
    );
    expect(validateEntryRange(at('2026-09-30T08:00:00Z'), at('2026-10-01T09:00:00Z'), now)).toBe('time_too_long');
  });

  it('caches the total as the cell value; empty when nothing was tracked', () => {
    const def = columnTypes.get('time_tracking')!;
    const cell = parseCellValue(def, def.defaultSettings, { duration: 3725, running: false, entries_count: 2 });
    expect(cell.ok && cell.derived).toMatchObject({ textValue: '01:02:05', numberValue: 3725 });
    expect(def.toText({ duration: 0, running: false, entries_count: 0 }, {}, {})).toBe('');
  });
});
