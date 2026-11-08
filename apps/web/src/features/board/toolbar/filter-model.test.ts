// SPDX-License-Identifier: AGPL-3.0-only
import {
  columnTypes,
  mirrorSourceOf,
  planQuery,
  querySchema,
  ruleProblem,
  type FilterRule,
  type QueryEnv,
} from '@bines/shared';
import { describe, expect, it } from 'vitest';
import {
  changeField,
  filterField,
  hasQuickFilter,
  operatorChoices,
  quickDateRules,
  safeField,
  toggleQuick,
  withMatch,
} from './filter-model';

/**
 * Prod bug: the filter panel crashed an imported board ("Operator is_empty does not apply to a
 * column with a long imported key"). Whatever the builder and the quick filters offer, for every column type, the engine accepts.
 */
const defs = columnTypes.all();
const env: QueryEnv = {
  columns: defs.map((d) => ({ id: `c_${d.type}`, type: d.type, settings: {} })),
  meId: 'u1',
  today: '2026-10-07',
  timezone: 'Asia/Jerusalem',
  weekend: 'fri_sat',
  firstDay: 0,
};
const plans = (r: FilterRule) => () =>
  planQuery(querySchema.parse({ filter: { kind: 'group', operator: 'and', rules: [r] } }), env);

describe('filter builder offers only what the engine accepts', () => {
  for (const def of defs) {
    const id = `c_${def.type}`;
    it(`${def.type}: operators, field change and quick filters`, () => {
      const field = filterField(id, env)!;
      for (const operator of operatorChoices(field)) {
        const r: FilterRule = { kind: 'rule', column_id: id, operator, values: [], negate: false };
        expect(ruleProblem(r, env)).toBeNull();
        expect(plans(r)).not.toThrow();
      }
      // Switching a rule to this column lands on an operator it has.
      const moved = changeField(
        { kind: 'rule', column_id: 'c_text', operator: 'is_empty', values: [], negate: false },
        id,
        env,
      );
      if (operatorChoices(field).length) expect(ruleProblem(moved, env)).toBeNull();
      if (field.model === 'date') for (const { rule } of quickDateRules(id, field)) expect(plans(rule)).not.toThrow();
      if (hasQuickFilter(field))
        expect(plans({ kind: 'rule', column_id: id, operator: 'any_of', values: [null], negate: false })).not.toThrow();
    });
  }

  it('a creation log gets relative quick dates but no "blank" (it is never empty)', () => {
    const field = safeField('c_creation_log', env)!;
    const values = quickDateRules('c_creation_log', field).map((o) => o.value);
    expect(values).toContain('TODAY');
    expect(values).not.toContain(null);
    expect(quickDateRules('c_date', safeField('c_date', env)!).map((o) => o.value)).toContain(null);
  });
});

/**
 * a mirror filters as the column it mirrors — the builder offers that type's operators (and a status
 * source's labels, as a quick list), every one of which the engine accepts; elsewhere it is still a mirror.
 */
describe('a mirror filters like its source', () => {
  const labels = [
    { id: 0, label: 'In progress', color: 'yellow' },
    { id: 1, label: 'Done', color: 'forest', is_done: true },
  ];
  const sources = {
    status: mirrorSourceOf('status', { labels }, { withLabels: true }),
    people: mirrorSourceOf('people', {}),
    date: mirrorSourceOf('date', {}),
    numbers: mirrorSourceOf('numbers', {}),
  };
  const mirrorEnv: QueryEnv = {
    ...env,
    columns: Object.entries(sources).map(([type, mirror_source]) => ({
      id: `m_${type}`,
      type: 'mirror',
      settings: { relation_column_id: 'rel', source_column_id: 'x' },
      mirror_source,
    })),
  };
  const mirrorPlans = (r: FilterRule) => () =>
    planQuery(querySchema.parse({ filter: { kind: 'group', operator: 'and', rules: [r] } }), mirrorEnv);

  for (const type of Object.keys(sources)) {
    it(`a mirror of ${type}: its operators plan`, () => {
      const id = `m_${type}`;
      const field = filterField(id, mirrorEnv)!;
      expect(field.model).toBe(columnTypes.get(type)!.filterModel);
      for (const operator of operatorChoices(field)) {
        const r: FilterRule = { kind: 'rule', column_id: id, operator, values: [], negate: false };
        expect(ruleProblem(r, mirrorEnv)).toBeNull();
        expect(mirrorPlans(r)).not.toThrow();
      }
      // Grouping / views: still the mirror's own reading.
      expect(safeField(id, mirrorEnv)!.model).toBe('text');
    });
  }

  it('a mirrored status gets a quick list of the source labels', () => {
    const field = filterField('m_status', mirrorEnv)!;
    expect(hasQuickFilter(field)).toBe(true);
    expect(field.source === 'column' && (field.settings.labels as { label: string }[]).map((l) => l.label)).toEqual([
      'In progress',
      'Done',
    ]);
    expect(operatorChoices(field)).toEqual(expect.arrayContaining(['any_of', 'is_done', 'contains_text']));
  });
});

describe('a mirror rule’s "any / all linked items"', () => {
  const base: FilterRule = { kind: 'rule', column_id: 'm', operator: 'any_of', values: ['Done'], negate: false };

  it('"any" is the default and is not stored; "all" is', () => {
    expect(withMatch(base, 'all').match).toBe('all');
    expect('match' in withMatch(withMatch(base, 'all'), 'any')).toBe(false);
  });

  it('moving the rule to another column drops "all"; a quick-list click keeps it', () => {
    expect('match' in changeField(withMatch(base, 'all'), 'c_text', env)).toBe(false);
    const filter = { kind: 'group' as const, operator: 'and' as const, negate: false, rules: [withMatch(base, 'all')] };
    const next = toggleQuick(filter, 'm', 'Blocked')!;
    expect(next.rules[0]).toMatchObject({ values: ['Done', 'Blocked'], match: 'all' });
  });
});
