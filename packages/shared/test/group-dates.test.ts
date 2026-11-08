// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  type QueryEnv,
  type QueryRow,
  groupBySchema,
  groupRows,
  resolveField,
  WHEN_BUCKETS,
  whenBucket,
  whenBucketDate,
} from '../src';

/**
 * grouping by a date — "when" (overdue, today, tomorrow …, the default), the past in detail, or one
 * bucket per day / week (the account's first day) / month / quarter / year; a timeline by its start or end.
 * Tuesday 2026-10-13, weeks from Sunday: this week 11/10–17/10, next 18/10–24/10.
 */
const env: QueryEnv = {
  columns: [
    { id: 'due', type: 'date', settings: {} },
    { id: 'span', type: 'timeline', settings: {} },
  ],
  meId: null,
  today: '2026-10-13',
  timezone: 'Asia/Jerusalem',
  weekend: 'fri_sat',
  firstDay: 0,
};
const row = (id: string, cells: QueryRow['cells']): QueryRow => ({
  id,
  group_id: 'g',
  parent_item_id: null,
  depth: 0,
  name: id,
  position: id,
  key: null,
  cells,
  created_at: '2026-10-01T00:00:00Z',
  created_by: null,
  updated_at: '2026-10-01T00:00:00Z',
});
const due = (id: string, date: string | null) => row(id, date ? { due: { value: { date }, text: date } } : {});
const rows = [
  due('late', '2026-10-01'),
  due('today', '2026-10-13'),
  due('tomorrow', '2026-10-14'),
  due('week', '2026-10-16'),
  due('next', '2026-10-21'),
  due('month', '2026-10-28'),
  due('nextMonth', '2026-11-09'),
  due('later', '2027-02-01'),
  due('none', null),
];
const group = (opts: { unit?: 'when' | 'day' | 'week' | 'month' | 'quarter' | 'year'; pastDetail?: boolean }) =>
  groupRows(rows, resolveField('due', env), {
    timezone: env.timezone,
    emptyLabel: 'ללא תאריך',
    dates: { env, label: (k) => k, ...opts },
  }).map((b) => [b.key, b.rows.map((r) => r.id)]);

describe('group by a date', () => {
  it('"when" by default: overdue … later, then no date', () => {
    expect(group({})).toEqual([
      ['overdue', ['late']],
      ['today', ['today']],
      ['tomorrow', ['tomorrow']],
      ['this_week', ['week']],
      ['next_week', ['next']],
      ['this_month', ['month']],
      ['next_month', ['nextMonth']],
      ['later', ['later']],
      ['__empty__', ['none']],
    ]);
  });

  it('the past in detail keeps the relative buckets', () => {
    expect(group({ pastDetail: true })[0]).toEqual(['earlier_this_month', ['late']]);
  });

  it('day / week (from the first day) / month / quarter / year', () => {
    expect(group({ unit: 'day' }).slice(0, 2)).toEqual([
      ['2026-10-01', ['late']],
      ['2026-10-13', ['today']],
    ]);
    expect(group({ unit: 'week' }).slice(0, 3)).toEqual([
      ['2026-09-27', ['late']],
      ['2026-10-11', ['today', 'tomorrow', 'week']],
      ['2026-10-18', ['next']],
    ]);
    expect(group({ unit: 'month' }).map(([k]) => k)).toEqual(['2026-10', '2026-11', '2027-02', '__empty__']);
    expect(group({ unit: 'quarter' }).map(([k]) => k)).toEqual(['2026-Q4', '2027-Q1', '__empty__']);
    expect(group({ unit: 'year' }).map(([k]) => k)).toEqual(['2026', '2027', '__empty__']);
  });

  it('a timeline groups by its start, or by its end', () => {
    const span = [
      row('a', { span: { value: { from: '2026-10-28', to: '2026-11-03' }, text: '' } }),
      row('b', { span: { value: { from: '2026-11-05', to: '2026-11-06' }, text: '' } }),
    ];
    const by = (edge?: 'start' | 'end') =>
      groupRows(span, resolveField('span', env), {
        timezone: env.timezone,
        emptyLabel: '',
        dates: { env, label: (k) => k, unit: 'month', edge },
      }).map((b) => [b.key, b.rows.map((r) => r.id)]);
    expect(by()).toEqual([
      ['2026-10', ['a']],
      ['2026-11', ['b']],
    ]);
    expect(by('end')).toEqual([['2026-11', ['a', 'b']]]);
  });

  it('a day inside each "when" bucket (a new item, a drag); none when the bucket is empty now', () => {
    for (const b of WHEN_BUCKETS) {
      const d = whenBucketDate(b, env);
      expect(d && whenBucket(d, env)).toBe(b);
    }
    // Saturday: nothing is left of this week after tomorrow.
    expect(whenBucketDate('this_week', { ...env, today: '2026-10-16' })).toBeNull();
  });

  it('a saved grouping without a unit still parses (the default is "when")', () => {
    expect(groupBySchema.parse({ column_id: 'due' })).toEqual({ column_id: 'due', direction: 'asc', collapse: false });
  });
});
