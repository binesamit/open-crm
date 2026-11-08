// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { type DateEnv, workSection } from '../src';

// Thursday 2026-10-01; the Israeli week starts on Sunday (first day 0): this week = 09-27 … 10-03.
const env: DateEnv = { today: '2026-10-01', timezone: 'Asia/Jerusalem', weekend: 'fri_sat', firstDay: 0 };

describe('workSection (07 §9.2)', () => {
  it.each([
    [null, 'no_date'],
    ['2026-09-30', 'past'],
    ['2025-01-01', 'past'],
    ['2026-10-01', 'today'],
    ['2026-10-02', 'this_week'],
    ['2026-10-03', 'this_week'],
    ['2026-10-04', 'next_week'],
    ['2026-10-10', 'next_week'],
    ['2026-10-11', 'later'],
  ] as const)('%s → %s', (date, section) => expect(workSection(date, env)).toBe(section));

  it('follows the account’s first day of the week', () => {
    const monday = { ...env, firstDay: 1 }; // week = 09-28 … 10-04
    expect(workSection('2026-10-04', monday)).toBe('this_week');
    expect(workSection('2026-10-05', monday)).toBe('next_week');
  });
});
