// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  applyPlan,
  type FilterRule,
  mirrorSourceOf,
  planQuery,
  type QueryEnv,
  type QueryRow,
  querySchema,
  resolveField,
} from '../src';

/**
 * Prod (product owner: "a mirror should filter like the column it mirrors"): with a known source a mirror filters as
 * that type — labels (and done), people, dates, numbers — matching when ANY linked item's value does; text
 * operators still work; grouping / sorting keep reading it as a mirror.
 */
const STATUS = [
  { id: 0, label: 'In progress', color: '#fdab3d' },
  { id: 1, label: 'Done', color: '#00c875', is_done: true },
  { id: 2, label: 'Blocked', color: '#e2445c' },
];
const env = (source: QueryEnv['columns'][number]['mirror_source']): QueryEnv => ({
  columns: [
    { id: 'm', type: 'mirror', settings: { relation_column_id: 'rel', source_column_id: 'x' }, mirror_source: source },
  ],
  meId: 'u1',
  teams: [{ id: 't1', member_ids: ['u2'] }],
  today: '2026-10-25',
  timezone: 'UTC',
  weekend: 'fri_sat',
  firstDay: 0,
});
const row = (id: string, value: unknown, text: string | null = null): QueryRow => ({
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
const rule = (operator: FilterRule['operator'], values: unknown[] = []): FilterRule => ({
  kind: 'rule',
  column_id: 'm',
  operator,
  values,
  negate: false,
});
const run = (e: QueryEnv, rows: QueryRow[], r: FilterRule) =>
  applyPlan(
    rows,
    planQuery(querySchema.parse({ filter: { kind: 'group', operator: 'and', rules: [r] } }), e),
    'UTC',
  ).map((x) => x.id);

const labelsOn = (...ls: string[]) => ({
  display_value: ls.join(', '),
  number: null,
  labels: ls.map((label) => ({ label, color: '#000', count: 1 })),
});

describe('a mirror of a status filters like a status', () => {
  const e = env(mirrorSourceOf('status', { labels: STATUS }, { withLabels: true }));
  const rows = [
    row('a', labelsOn('Done'), 'Done'),
    row('b', labelsOn('In progress', 'Blocked'), 'Working on it, Stuck'),
    row('c', null),
  ];

  it('offers the source labels and status operators — text ones too — for filters only', () => {
    const f = resolveField('m', e, 'filter');
    expect(f.model).toBe('label');
    expect(f.source === 'column' && (f.settings.labels as { label: string }[]).map((l) => l.label)).toEqual([
      'In progress',
      'Done',
      'Blocked',
    ]);
    expect(f.source === 'column' && f.operators).toEqual(
      expect.arrayContaining(['any_of', 'not_any_of', 'is_empty', 'is_done', 'contains_text']),
    );
    // Grouping, sorting, views: still a mirror.
    expect(resolveField('m', e).model).toBe('text');
  });

  it('"is" a label: any linked item on it; "is not": none; empty', () => {
    expect(run(e, rows, rule('any_of', ['Blocked']))).toEqual(['b']);
    expect(run(e, rows, rule('any_of', ['done', 'Blocked']))).toEqual(['a', 'b']);
    expect(run(e, rows, rule('not_any_of', ['Blocked']))).toEqual(['a', 'c']);
    expect(run(e, rows, rule('any_of', [null]))).toEqual(['c']);
    expect(run(e, rows, rule('is_not_empty'))).toEqual(['a', 'b']);
  });

  it('done / not done by the source labels; "contains" on the text still works', () => {
    expect(run(e, rows, rule('is_done'))).toEqual(['a']);
    expect(run(e, rows, rule('is_not_done'))).toEqual(['b', 'c']);
    expect(run(e, rows, rule('contains_text', ['work']))).toEqual(['b']);
  });
});

describe('other sources', () => {
  it('people: me, a user, a team member', () => {
    const e = env(mirrorSourceOf('people', {}));
    const rows = [
      row('a', { display_value: 'Me', people: ['u1'] }),
      row('b', { display_value: 'Bob', people: ['u2'] }),
      row('c', null),
    ];
    expect(resolveField('m', e, 'filter').model).toBe('people');
    expect(run(e, rows, rule('any_of', ['me']))).toEqual(['a']);
    expect(run(e, rows, rule('any_of', ['team:t1']))).toEqual(['b']);
    expect(run(e, rows, rule('is_empty'))).toEqual(['c']);
  });

  it('dates: a match when any linked item’s date does', () => {
    const e = env(mirrorSourceOf('date', {}));
    const rows = [
      row('a', { display_value: '2026-10-01, 2026-12-01', dates: [d('2026-10-01'), d('2026-12-01')] }),
      row('b', { display_value: '2026-11-15', dates: [d('2026-11-15')] }),
      row('c', null),
    ];
    expect(resolveField('m', e, 'filter').model).toBe('date');
    expect(run(e, rows, rule('between', ['2026-11-30', '2026-12-31']))).toEqual(['a']);
    expect(run(e, rows, rule('lower_than', ['2026-10-10']))).toEqual(['a']);
    expect(run(e, rows, rule('any_of', ['TODAY']))).toEqual([]);
    expect(run(e, rows, rule('is_empty'))).toEqual(['c']);
  });

  it('numbers: the number the cell shows', () => {
    const e = env(mirrorSourceOf('numbers', {}));
    const rows = [row('a', { display_value: '1,500', number: 1500 }), row('b', { display_value: '20', number: 20 })];
    expect(resolveField('m', e, 'filter').model).toBe('number');
    expect(run(e, rows, rule('greater_than', [100]))).toEqual(['a']);
  });

  it('an unknown or text source: text, as before', () => {
    for (const source of [null, undefined, mirrorSourceOf('text', {})]) {
      const f = resolveField('m', env(source), 'filter');
      expect(f.model).toBe('text');
      expect(f.source === 'column' && f.operators).toBeFalsy();
    }
  });

  it('labels travel only for a label source', () => {
    expect(mirrorSourceOf('numbers', { labels: STATUS }).settings.labels).toBeUndefined();
    expect(mirrorSourceOf('status', { labels: STATUS }).settings.labels).toBeUndefined();
    expect(mirrorSourceOf('status', { labels: STATUS }, { withLabels: true }).settings.labels).toHaveLength(3);
  });
});

function d(date: string) {
  return { start: date, end: date };
}

describe('"all linked items" (match: all)', () => {
  const e = env(mirrorSourceOf('status', { labels: STATUS }, { withLabels: true }));
  const items = (...per: string[][]) => ({
    display_value: per.flat().join(', '),
    number: null,
    labels: per.flat().map((label) => ({ label, color: '#000', count: 1 })),
    each: per.map((labels) => (labels.length ? { labels } : {})),
  });
  const rows = [
    row('a', items(['Done'], ['Done'])),
    row('b', items(['Done'], ['Blocked'])),
    row('c', items(['Done'], [])),
    row('d', null),
  ];
  const all = (operator: FilterRule['operator'], values: unknown[] = []) => ({
    ...rule(operator, values),
    match: 'all' as const,
  });

  it('"is": every linked item; one of them is the default', () => {
    expect(run(e, rows, all('any_of', ['Done']))).toEqual(['a']);
    expect(run(e, rows, rule('any_of', ['Done']))).toEqual(['a', 'b', 'c']);
    // An item without a value counts when "empty" is one of the picked values.
    expect(run(e, rows, all('any_of', ['Done', null]))).toEqual(['a', 'c']);
  });

  it('done: every linked item; no linked item → no match', () => {
    expect(run(e, rows, all('is_done'))).toEqual(['a']);
  });

  it('"is not", "not done", "is empty" read the same either way', () => {
    for (const [op, values] of [
      ['not_any_of', ['Blocked']],
      ['is_not_done', []],
      ['is_empty', []],
      ['is_not_empty', []],
    ] as const)
      expect(run(e, rows, all(op, [...values]))).toEqual(run(e, rows, rule(op, [...values])));
  });

  it('dates: every linked item in the range', () => {
    const de = env(mirrorSourceOf('date', {}));
    const dated = (...ds: (string | null)[]) => ({
      display_value: '',
      dates: ds.filter((x): x is string => !!x).map(d),
      each: ds.map((x) => (x ? { dates: [d(x)] } : {})),
    });
    const drows = [row('a', dated('2026-12-01', '2026-12-20')), row('b', dated('2026-12-01', '2027-01-05'))];
    expect(run(de, drows, all('between', ['2026-12-01', '2026-12-31']))).toEqual(['a']);
    expect(run(de, drows, rule('between', ['2026-12-01', '2026-12-31']))).toEqual(['a', 'b']);
  });

  it('ignored where it does not apply (a number, a plain column)', () => {
    const ne = env(mirrorSourceOf('numbers', {}));
    const nrows = [row('a', { display_value: '5', number: 5 })];
    expect(run(ne, nrows, all('greater_than', [1]))).toEqual(['a']);
  });
});
