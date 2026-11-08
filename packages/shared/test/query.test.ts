// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  addWorkdays,
  summaryOptions,
  applyPlan,
  decodeQuery,
  encodeQuery,
  groupRows,
  planQuery,
  querySchema,
  relativeSpan,
  resolveDateValue,
  resolveField,
  summarize,
  type QueryInput,
} from '../src';
import { env, fixtureRows, queryCases } from './query-fixtures';

const run = (q: QueryInput, e = env()) => {
  const plan = planQuery(querySchema.parse(q), e);
  return applyPlan(fixtureRows(), plan, e.timezone).map((r) => r.name);
};

describe('query engine — truth table', () => {
  for (const c of queryCases) {
    it(c.title, () => expect(run(c.query as QueryInput)).toEqual(c.expect));
  }
});

describe('query validation', () => {
  const rule = (column_id: string, operator: string) => ({
    filter: { kind: 'group' as const, operator: 'and' as const, rules: [{ column_id, operator, values: ['x'] }] },
  });

  it('rejects unknown columns and operators that do not apply', () => {
    expect(() => run(rule('nope', 'any_of') as QueryInput)).toThrow(
      expect.objectContaining({ code: 'unknown_column' }),
    );
    expect(() => run(rule('box', 'contains_text') as QueryInput)).toThrow(
      expect.objectContaining({ code: 'invalid_operator' }),
    );
  });

  it('limits nesting to 5 levels and 50 rules', () => {
    const leaf = { column_id: 'amount', operator: 'is_empty' as const };
    type G = { kind: 'group'; operator: 'and'; rules: unknown[] };
    const nest = (depth: number): G => ({
      kind: 'group',
      operator: 'and',
      rules: depth === 1 ? [leaf] : [nest(depth - 1)],
    });
    expect(() => run({ filter: nest(5) } as QueryInput)).not.toThrow();
    expect(() => run({ filter: nest(6) } as QueryInput)).toThrow(
      expect.objectContaining({ code: 'query_too_complex' }),
    );
    const many = { kind: 'group', operator: 'or', rules: Array.from({ length: 51 }, () => leaf) };
    expect(() => querySchema.parse({ filter: many })).toThrow();
  });

  it('an empty or incomplete filter matches everything', () => {
    expect(run({})).toHaveLength(6);
    expect(run({ filter: { kind: 'group', operator: 'and', rules: [] } })).toHaveLength(6);
    expect(
      run({
        filter: {
          kind: 'group',
          operator: 'or',
          negate: true,
          rules: [{ column_id: 'note', operator: 'contains_text' }],
        },
      }),
    ).toHaveLength(6);
  });
});

describe('sorting', () => {
  it('sorts by number desc with nulls last, ties in board order', () => {
    expect(run({ sort: [{ column_id: 'amount', direction: 'desc' }] })).toEqual([
      'Foxtrot',
      'Bravo',
      'Alpha',
      'Delta',
      'Charlie',
      'Echo',
    ]);
  });

  it('sorts status by label position and text case-insensitively', () => {
    expect(run({ sort: [{ column_id: 'status' }, { column_id: 'name', direction: 'desc' }] })).toEqual([
      'Alpha',
      'Foxtrot',
      'Bravo',
      'Charlie',
      'Delta',
      'Echo',
    ]);
    expect(run({ sort: [{ column_id: 'note', nulls: 'first' }] })).toEqual([
      'Charlie',
      'Echo',
      'Bravo',
      'Alpha',
      'Foxtrot',
      'Delta', // Hebrew sorts after Latin (codepoint order)
    ]);
  });

  it('sorts dates by instant (a time sorts within its day)', () => {
    expect(run({ sort: [{ column_id: 'due' }] })).toEqual(['Charlie', 'Bravo', 'Alpha', 'Delta', 'Foxtrot', 'Echo']);
  });

  it('orders by group first when a group rank is given', () => {
    const e = env();
    const plan = planQuery(querySchema.parse({ sort: [{ column_id: 'amount' }] }), e);
    const rank = new Map([
      ['g2', 0],
      ['g1', 1],
    ]);
    expect(applyPlan(fixtureRows(), plan, e.timezone, rank).map((r) => r.name)).toEqual([
      'Delta',
      'Foxtrot',
      'Echo',
      'Charlie',
      'Alpha',
      'Bravo',
    ]);
  });
});

describe('scope and match_children', () => {
  const tree = () => {
    const rows = fixtureRows();
    // Bravo becomes a subitem of Alpha, Charlie a subitem of Bravo.
    rows[1] = { ...rows[1]!, parent_item_id: 'i0', depth: 1, group_id: null };
    rows[2] = { ...rows[2]!, parent_item_id: 'i1', depth: 2, group_id: null };
    return rows;
  };
  const names = (q: QueryInput) => {
    const e = env();
    return applyPlan(tree(), planQuery(querySchema.parse(q), e), e.timezone).map((r) => r.name);
  };
  const stuck = {
    kind: 'group' as const,
    operator: 'and' as const,
    rules: [{ column_id: 'status', operator: 'any_of' as const, values: ['תקוע'] }],
  };

  it('returns only the requested levels', () => {
    expect(names({ scope: 'subitems' })).toEqual(['Bravo', 'Charlie']);
    expect(names({ scope: 'parents' })).toHaveLength(4);
  });

  it('keeps a parent when a descendant matches', () => {
    expect(names({ scope: 'parents', filter: stuck })).toEqual([]);
    expect(names({ scope: 'parents', match_children: true, filter: stuck })).toEqual(['Alpha']);
  });
});

describe('dynamic dates', () => {
  const e = env();
  it('resolves tokens around the account week and weekend', () => {
    expect(resolveDateValue('THIS_WEEK', e)).toEqual({ from: '2026-10-04', to: '2026-10-10' });
    expect(resolveDateValue('THIS_WEEK', { ...e, firstDay: 1 })).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    expect(resolveDateValue('LAST_MONTH', e)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(resolveDateValue('THIS_QUARTER', e)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(resolveDateValue('FUTURE', e)).toEqual({ from: '2026-10-08', to: null });
    expect(resolveDateValue('EXACT:2026-01-31', e)).toEqual({ from: '2026-01-31', to: '2026-01-31' });
    expect(resolveDateValue('SOMEDAY', e)).toBeNull();
  });

  it('counts workdays without the weekend', () => {
    // Thursday + 1 workday = Sunday (Fri+Sat off); with Sat+Sun off = Friday.
    expect(addWorkdays('2026-10-08', 1, 'fri_sat')).toBe('2026-10-11');
    expect(addWorkdays('2026-10-08', 1, 'sat_sun')).toBe('2026-10-09');
    expect(addWorkdays('2026-10-11', -1, 'fri_sat')).toBe('2026-10-08');
    expect(relativeSpan([1, 'months'], 'last', { ...e, today: '2026-03-31' })).toEqual({
      from: '2026-02-28',
      to: '2026-03-31',
    });
  });
});

describe('?q= encoding', () => {
  it('round-trips unicode queries', () => {
    const q = {
      filter: {
        kind: 'group',
        operator: 'and',
        rules: [{ column_id: 'status', operator: 'any_of', values: ['תקוע'] }],
      },
      search: 'שלום',
    } as const;
    const s = encodeQuery(q as QueryInput);
    expect(s).not.toMatch(/[+/=]/);
    expect(decodeQuery(s)).toMatchObject({ search: 'שלום', filter: { rules: [{ values: ['תקוע'] }] } });
  });
});

describe('group by', () => {
  const e = env();
  const bucketsOf = (column: string, direction: 'asc' | 'desc' = 'asc') =>
    groupRows(fixtureRows(), resolveField(column, e), {
      timezone: e.timezone,
      direction,
      emptyLabel: 'ריק',
      nameOf: (id) => ({ u_me: 'Me', u_other: 'Other', t_ops: 'Ops' })[id],
    }).map((b) => [b.label, b.rows.map((r) => r.name)]);

  it('status: one bucket per label in label order, empty last', () => {
    expect(bucketsOf('status')).toEqual([
      ['עובד על זה', ['Alpha']],
      ['הושלם', ['Bravo', 'Foxtrot']],
      ['תקוע', ['Charlie']],
      ['חדש', ['Delta']],
      ['ריק', ['Echo']],
    ]);
    expect(bucketsOf('status', 'desc')[0]![0]).toBe('חדש');
  });

  it('multi-value columns put an item in every bucket', () => {
    expect(bucketsOf('tags')).toEqual([
      ['A', ['Alpha']],
      ['B', ['Alpha', 'Delta']],
      ['C', ['Bravo']],
      ['ריק', ['Charlie', 'Echo', 'Foxtrot']],
    ]);
    expect(bucketsOf('owner').map((b) => b[0])).toEqual(['Me', 'Ops', 'Other', 'ריק']);
  });

  it('dates by local day, numbers by value, checkbox', () => {
    expect(bucketsOf('due').map((b) => b[0])).toEqual([
      '30/09/2026',
      '01/10/2026',
      '07/10/2026',
      '09/10/2026',
      '15/11/2026',
      'ריק',
    ]);
    expect(bucketsOf('stars').map((b) => b[0])).toEqual(['2', '4', '5', 'ריק']);
    expect(bucketsOf('box')).toEqual([
      ['✓', ['Alpha']],
      ['ריק', ['Bravo', 'Charlie', 'Delta', 'Echo', 'Foxtrot']],
    ]);
  });
});

describe('group summaries', () => {
  const e = env();
  const sum = (column: string, rows = fixtureRows()) => summarize(resolveField(column, e), rows, e.timezone);

  it('status battery in label order, blanks last', () => {
    expect(sum('status')).toEqual({
      kind: 'battery',
      total: 6,
      segments: [
        { key: '0', label: 'עובד על זה', color: 'yellow', count: 1 },
        { key: '1', label: 'הושלם', color: 'forest', count: 2 },
        { key: '2', label: 'תקוע', color: 'crimson', count: 1 },
        { key: '5', label: 'חדש', color: 'blue', count: 1 },
        { key: '', label: '', color: 'empty', count: 1 },
      ],
    });
  });

  it('numbers sum by default, or the column footer; rating averages', () => {
    expect(sum('amount')).toEqual({ kind: 'value', fn: 'sum', text: '1345.5' });
    const avg = env({
      columns: e.columns.map((c) =>
        c.id === 'amount' ? { ...c, settings: { footer: 'max', unit: { symbol: '₪', direction: 'left' } } } : c,
      ),
    });
    expect(summarize(resolveField('amount', avg), fixtureRows(), e.timezone)).toEqual({
      kind: 'value',
      fn: 'max',
      text: '₪1000',
    });
    expect(sum('stars')).toEqual({ kind: 'value', fn: 'avg', text: '3.7' });
  });

  it('check box done count, date range, nothing for text', () => {
    expect(sum('box')).toEqual({ kind: 'done', done: 1, total: 6 });
    expect(sum('due')).toEqual({ kind: 'range', from: '2026-09-30', to: '2026-11-15' });
    expect(sum('note')).toBeNull();
    expect(sum('status', [])).toBeNull();
  });

  it('the view picks a calculation per column (the footer menu); unknown choices fall back', () => {
    const pick = (column: string, choice: string) =>
      summarize(resolveField(column, e), fixtureRows(), e.timezone, choice);
    expect(summaryOptions(resolveField('amount', e))).toEqual(['sum', 'avg', 'median', 'min', 'max', 'count', 'none']);
    expect(summaryOptions(resolveField('status', e))).toEqual(['battery', 'filled', 'none']);
    expect(summaryOptions(resolveField('note', e))).toEqual(['none', 'filled']);
    expect(pick('amount', 'count')).toMatchObject({ kind: 'value', fn: 'count' });
    expect(pick('amount', 'none')).toBeNull();
    expect(pick('amount', 'battery')).toMatchObject({ kind: 'value', fn: 'sum' });
    expect(pick('due', 'earliest')).toEqual({ kind: 'range', fn: 'earliest', from: '2026-09-30', to: '2026-09-30' });
    expect(pick('due', 'latest')).toMatchObject({ fn: 'latest', from: '2026-11-15' });
    expect(pick('status', 'filled')).toMatchObject({ kind: 'done', fn: 'filled', total: 6 });
  });
});

describe('number comparisons on mirror / formula (imported "greater than 0" conditions on a mirror)', () => {
  const e = env({
    columns: [
      { id: 'name', type: 'name', settings: {} },
      { id: 'open', type: 'mirror', settings: {} },
    ],
  });
  const rows = fixtureRows()
    .slice(0, 3)
    .map((r, i) => ({
      ...r,
      cells: [
        { open: { value: { display_value: '3', number: 3 }, text: '3' } },
        { open: { value: { display_value: '0', number: 0 }, text: '0' } },
        { open: { value: { display_value: 'שם', number: null }, text: 'שם' } },
      ][i]!,
    }));
  const names = (operator: string, values: unknown[]) =>
    applyPlan(
      rows,
      planQuery(
        querySchema.parse({
          filter: { kind: 'group', operator: 'and', rules: [{ kind: 'rule', column_id: 'open', operator, values }] },
        }),
        e,
      ),
      e.timezone,
    ).map((r) => r.name);

  it('compares the number; text without a number never matches', () => {
    expect(names('greater_than', [0])).toEqual(['Alpha']);
    expect(names('lower_than_or_equal', [0])).toEqual(['Bravo']);
    expect(names('contains_text', ['ש'])).toEqual(['Charlie']); // text operators still read the text
  });
});
