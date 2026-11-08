// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { relativeBucketDate, relativeDateBucket, RELATIVE_BUCKETS, workSection } from '../src';

/** Saturday 2026-10-03, weeks from Sunday: this week = 27/09–03/10, next = 04/10–10/10. */
const env = { today: '2026-10-03', timezone: 'Asia/Jerusalem', weekend: 'fri_sat' as const, firstDay: 0 };

describe('relative date buckets (group by date, My Work)', () => {
  it('places dates relative to today, week before month', () => {
    const b = (d: string) => relativeDateBucket(d, env);
    expect(b('2026-10-03')).toBe('today');
    expect(b('2026-09-28')).toBe('earlier_this_week'); // this week started in September
    expect(b('2026-09-22')).toBe('last_week');
    expect(b('2026-09-05')).toBe('last_month'); // before this week's month — September is "last month"
    expect(b('2026-08-15')).toBe('older');
    expect(b('2026-10-05')).toBe('next_week');
    expect(b('2026-10-20')).toBe('this_month');
    expect(b('2026-11-10')).toBe('next_month');
    expect(b('2027-01-01')).toBe('later');
  });

  it('gives a date inside each bucket that has one (for "+ item" under it)', () => {
    for (const bucket of RELATIVE_BUCKETS) {
      const d = relativeBucketDate(bucket, env);
      if (d) expect(relativeDateBucket(d, env)).toBe(bucket);
    }
    expect(relativeBucketDate('this_week', env)).toBeNull(); // Saturday: nothing left this week
  });

  it('My Work folds them into its sections', () => {
    expect(workSection('2026-09-05', env)).toBe('past');
    expect(workSection('2026-10-03', env)).toBe('today');
    expect(workSection('2026-10-05', env)).toBe('next_week');
    expect(workSection('2026-11-10', env)).toBe('later');
    expect(workSection(null, env)).toBe('no_date');
  });
});
