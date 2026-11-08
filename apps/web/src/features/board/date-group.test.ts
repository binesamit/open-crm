// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { dateGroupDay, dateGroupLabel } from './date-group';

/** a date bucket's title and the day an item gets in it. Tuesday 2026-10-13, weeks from Sunday. */
const env = { today: '2026-10-13', timezone: 'Asia/Jerusalem', weekend: 'fri_sat' as const, firstDay: 0 };

describe('date groups', () => {
  it('titles: when buckets, a quarter, a year', () => {
    expect(dateGroupLabel('overdue')).toBe('באיחור');
    expect(dateGroupLabel('tomorrow', 'when')).toBe('מחר');
    expect(dateGroupLabel('2026-Q4', 'quarter')).toBe('רבעון 4 · 2026');
    expect(dateGroupLabel('2026', 'year')).toBe('2026');
    expect(dateGroupLabel('2026-10', 'month')).toMatch(/2026/);
  });

  it('a day inside the bucket: when, or the first day of the period', () => {
    expect(dateGroupDay('tomorrow', env)).toBe('2026-10-14');
    expect(dateGroupDay('2026-10-11', env, { unit: 'week' })).toBe('2026-10-11');
    expect(dateGroupDay('2026-11', env, { unit: 'month' })).toBe('2026-11-01');
    expect(dateGroupDay('2027-Q2', env, { unit: 'quarter' })).toBe('2027-04-01');
    expect(dateGroupDay('2027', env, { unit: 'year' })).toBe('2027-01-01');
    expect(dateGroupDay('last_week', env, { pastDetail: true })).toBe('2026-10-04');
  });
});
