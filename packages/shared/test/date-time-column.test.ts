// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  cellFromText,
  columnTypes,
  DEFAULT_DATE_TIME,
  DEFAULT_REGION,
  localDateValue,
  storedDateValue,
  type Region,
} from '../src';

/** a time in a date column — "include time", entered and shown in the region's zone. */
const region = (p: Partial<Region> = {}): Region => ({ ...DEFAULT_REGION, ...p });
const IL = region();
const NY = region({ language: 'en', timezone: 'America/New_York', date_format: 'MM/DD/YYYY', time_format: '12h' });
const date = columnTypes.get('date')!;

describe('date column with a time', () => {
  it('stores a local wall-clock time as UTC and reads it back in the zone', () => {
    // Jerusalem summer (UTC+3): 01:30 on Oct 5 is Oct 4 22:30Z — the stored day moves, the local one does not.
    const stored = storedDateValue('2026-10-05', '01:30', IL);
    expect(stored).toEqual({ date: '2026-10-04', time: '22:30' });
    expect(localDateValue(stored, IL)).toEqual({ date: '2026-10-05', time: '01:30' });
    expect(localDateValue(stored, NY)).toEqual({ date: '2026-10-04', time: '18:30' });
  });

  it('keeps a plain date as it is (no time, no shift)', () => {
    expect(storedDateValue('2026-10-05', undefined, IL)).toEqual({ date: '2026-10-05' });
    expect(storedDateValue('2026-10-05', null, NY)).toEqual({ date: '2026-10-05' });
    expect(localDateValue({ date: '2026-10-05' }, NY)).toEqual({ date: '2026-10-05' });
  });

  it('accepts seconds in a stored time', () => {
    expect(localDateValue({ date: '2026-10-05', time: '11:30:45' }, IL)).toEqual({ date: '2026-10-05', time: '14:30' });
  });

  it('shows the time in the region format and zone; a plain date without one', () => {
    expect(date.toText({ date: '2026-10-04', time: '22:30' }, {}, { region: IL })).toBe('05/10/2026 01:30');
    expect(date.toText({ date: '2026-10-05' }, { show_time: true }, { region: IL })).toBe('05/10/2026');
    expect(date.toText({ date: '2026-10-04', time: '22:30' }, {}, { region: NY })).toMatch(/^10\/04\/2026 6:30\sPM$/);
  });

  it('round-trips typed text through the region (paste, MCP, automations)', () => {
    expect(cellFromText('date', '05/10/2026 01:30', {}, [], { region: IL })).toEqual({
      date: '2026-10-04',
      time: '22:30',
    });
    expect(cellFromText('date', '05/10/2026', { show_time: true }, [], { region: IL })).toEqual({ date: '2026-10-05' });
  });

  it('sorts, filters and computes from the instant (toDate / toFormula)', () => {
    expect(date.toDate!({ date: '2026-10-04', time: '22:30' }, {})).toBe('2026-10-04T22:30:00Z');
    expect(date.toDate!({ date: '2026-10-05' }, {})).toBe('2026-10-05');
    expect(date.toFormula!({ date: '2026-10-04', time: '22:30' }, {}, {})).toBe('2026-10-04T22:30:00Z');
  });

  it('has "include time" off by default and validates the start time', () => {
    expect(date.defaultSettings).toEqual({});
    expect(DEFAULT_DATE_TIME).toMatch(/^\d{2}:\d{2}$/);
    expect(date.settingsSchema.safeParse({ show_time: true, default_time: '08:15' }).success).toBe(true);
    expect(date.settingsSchema.safeParse({ default_time: '24:00' }).success).toBe(false);
    expect(date.settingsSchema.safeParse({ default_time: '9:00' }).success).toBe(false);
  });
});
