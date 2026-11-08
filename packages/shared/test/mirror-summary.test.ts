// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { mirrorSourceOf, type QueryEnv, type QueryRow, resolveField, summarize, summaryOptions } from '../src';

/**
 * a mirror's group footer offers its source column's summaries over the mirrored values — numbers
 * sum / average … shown the source's way (a currency stays a currency), labels as the battery — not only "filled".
 */
const env = (
  source: QueryEnv['columns'][number]['mirror_source'],
  settings: Record<string, unknown> = {},
): QueryEnv => ({
  columns: [
    {
      id: 'm',
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: 'x', ...settings },
      mirror_source: source,
    },
  ],
  meId: null,
  today: '2026-10-13',
  timezone: 'UTC',
  weekend: 'fri_sat',
  firstDay: 0,
});
const row = (id: string, value: unknown, text: string | null): QueryRow => ({
  id,
  group_id: 'g',
  parent_item_id: null,
  depth: 0,
  name: id,
  position: id,
  key: null,
  cells: { m: { value, text } },
  created_at: '2026-10-13T00:00:00Z',
  created_by: null,
  updated_at: '2026-10-13T00:00:00Z',
});
const shekel = mirrorSourceOf('numbers', {
  unit: { symbol: '₪', direction: 'left' },
  thousands: true,
  // Only the number display travels.
  labels: [{ id: 1, label: 'secret' }],
});
const money = [
  row('a', { display_value: '₪1,200', number: 1200 }, '₪1,200'),
  row('b', { display_value: '₪300', number: 300 }, '₪300'),
  row('c', null, null),
];

describe('mirror footer summaries', () => {
  it('keeps only the number display of the source', () => {
    expect(shekel).toEqual({
      type: 'numbers',
      settings: { unit: { symbol: '₪', direction: 'left' }, thousands: true },
    });
  });

  it('a mirror of numbers: sum / average … in the source format', () => {
    const f = resolveField('m', env(shekel));
    expect(summaryOptions(f)).toEqual(['sum', 'avg', 'median', 'min', 'max', 'count', 'none']);
    expect(summarize(f, money, 'UTC')).toEqual({ kind: 'value', fn: 'sum', text: '₪1,500' });
    expect(summarize(f, money, 'UTC', 'avg')).toEqual({ kind: 'value', fn: 'avg', text: '₪750' });
    expect(summarize(f, money, 'UTC', 'count')).toEqual({ kind: 'value', fn: 'count', text: '2' });
  });

  it('a mirror that counts its items sums plain counts', () => {
    const f = resolveField('m', env(shekel, { aggregate: 'count' }));
    expect(summaryOptions(f)[0]).toBe('sum');
    expect(summarize(f, money, 'UTC')).toEqual({ kind: 'value', fn: 'sum', text: '1500' });
  });

  it('a mirror of labels: the battery of the labels it carries, blanks as the empty part', () => {
    const f = resolveField('m', env(mirrorSourceOf('status', {})));
    expect(summaryOptions(f)).toEqual(['battery', 'filled', 'none']);
    const rows = [
      row(
        'a',
        { display_value: 'Done, Done', number: null, labels: [{ label: 'Done', color: 'forest', count: 2 }] },
        'Done',
      ),
      row('b', { display_value: 'Open', number: null, labels: [{ label: 'Open', color: 'blue', count: 1 }] }, 'Open'),
      row('c', null, null),
    ];
    const s = summarize(f, rows, 'UTC');
    expect(s).toMatchObject({ kind: 'battery', total: 4 });
    expect(s?.kind === 'battery' && s.segments.map((x) => [x.label, x.count])).toEqual([
      ['Done', 2],
      ['Open', 1],
      ['', 1],
    ]);
  });

  it('text, dates or an unknown source: filled only, as before', () => {
    for (const source of [mirrorSourceOf('text', {}), mirrorSourceOf('date', {}), null, undefined])
      expect(summaryOptions(resolveField('m', env(source)))).toEqual(['none', 'filled']);
  });
});
