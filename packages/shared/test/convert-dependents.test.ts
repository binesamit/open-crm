// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  adaptRule,
  adaptViewSettings,
  adaptWidgetSettings,
  clearRuleMarks,
  conversionMark,
  type ConvertedColumn,
  type FilterGroup,
  type FilterRule,
  formulaKindOf,
  formulaReads,
  planQuery,
  querySchema,
  recipeBreaks,
  recipeNames,
  recipeSchema,
  sameWidgetRoles,
  viewChanged,
} from '../src';

/** D28 §6 — what depends on a converted column: saved rules, summaries, formulas, recipes, widgets. */

const statusSettings = {
  labels: [
    { id: 1, label: 'בטיפול', color: '#fdab3d', index: 0 },
    { id: 2, label: 'הושלם', color: '#00c875', index: 1 },
  ],
};
const col = (from: string, to: string, fromSettings: Record<string, unknown> = {}): ConvertedColumn => ({
  key: 'c1',
  title: 'Amount',
  from: { type: from, settings: fromSettings },
  to: { type: to, settings: to === 'status' ? statusSettings : {} },
});
const mark = conversionMark('conv1');
const rule = (operator: string, values: unknown[] = []) =>
  ({ kind: 'rule', column_id: 'c1', operator, values, negate: false }) as FilterRule;

describe('saved rules', () => {
  it('disables an operator the new type lacks; keeps the rest; maps label ids to names when labels become text', () => {
    expect(adaptRule(rule('greater_than', [5]), 'c1', col('numbers', 'text'), mark)).toMatchObject({
      change: 'disabled',
      rule: { disabled: mark },
    });
    expect(adaptRule(rule('is_empty'), 'c1', col('numbers', 'text'), mark).change).toBe('kept');
    expect(adaptRule(rule('any_of', [5]), 'c1', col('numbers', 'text'), mark)).toMatchObject({
      change: 'mapped',
      rule: { values: ['5'] },
    });
    expect(adaptRule(rule('any_of', [2]), 'c1', col('status', 'text', statusSettings), mark)).toMatchObject({
      change: 'mapped',
      rule: { values: ['הושלם'] },
    });
    expect(adaptRule(rule('any_of', [2]), 'c1', col('status', 'dropdown', statusSettings), mark).change).toBe('kept');
    expect(adaptRule(rule('any_of', ['הושלם']), 'c1', col('text', 'status'), mark).change).toBe('kept');
    expect(adaptRule(rule('contains_text', ['x']), 'c1', col('text', 'status'), mark).change).toBe('disabled');
    expect(adaptRule(rule('any_of', ['TODAY']), 'c1', col('date', 'text'), mark).change).toBe('disabled');
    // Another column's rule is not touched.
    const other = { ...rule('greater_than', [1]), column_id: 'c2' };
    expect(adaptRule(other, 'c1', col('numbers', 'text'), mark)).toEqual({ rule: other, change: 'kept' });
  });

  it('a disabled rule is ignored by the engine and its mark comes off on undo', () => {
    const filter: FilterGroup = {
      kind: 'group',
      operator: 'and',
      negate: false,
      rules: [{ ...rule('greater_than', [5]), disabled: mark }],
    };
    const env = {
      columns: [{ id: 'c1', type: 'numbers', settings: {} }],
      meId: null,
      today: '2026-01-01',
      timezone: 'UTC',
      weekend: 'fri_sat' as const,
      firstDay: 0,
    };
    expect(planQuery(querySchema.parse({ filter }), env).filter).toBeNull();
    const cleared = clearRuleMarks(filter, mark);
    expect((cleared.rules[0] as { disabled?: string }).disabled).toBeUndefined();
    expect(planQuery(querySchema.parse({ filter: cleared }), env).filter).not.toBeNull();
  });
});

describe('views', () => {
  it('adapts filter and colouring rules, resets summaries the type lacks and reports other references', () => {
    const settings = {
      query: {
        filter: { kind: 'group', operator: 'and', negate: false, rules: [rule('greater_than', [5]), rule('is_empty')] },
        sort: [{ column_id: 'c1', direction: 'asc', nulls: 'last' }],
      },
      summaries: { c1: 'sum', c2: 'sum' },
      coloring: [{ id: 'r1', rule: rule('lower_than', [0]), target: 'row', color: '#ff0000' }],
      kanban: { column_id: 'c1', card_fields: [] },
    };
    const impact = adaptViewSettings(settings, 'c1', col('numbers', 'text'), mark);
    expect(impact.rules).toEqual({ kept: 1, mapped: 0, disabled: 2 });
    expect(impact.summaries_reset).toBe(1);
    expect((impact.settings.summaries as Record<string, string>).c2).toBe('sum');
    expect(impact.references).toEqual(['kanban.column_id']);
    expect(impact.sorted).toBe(true);
    expect(viewChanged(impact)).toBe(true);
    // The input is not modified.
    expect(settings.summaries.c1).toBe('sum');
    // sub-board columns are `sub:<key>` on the parent's views.
    const sub = adaptViewSettings(
      {
        query: {
          filter: {
            kind: 'group',
            operator: 'and',
            negate: false,
            rules: [{ ...rule('greater_than', [1]), column_id: 'sub:c1' }],
          },
        },
      },
      'sub:c1',
      col('numbers', 'text'),
      mark,
    );
    expect(sub.rules.disabled).toBe(1);
  });
});

describe('formulas', () => {
  it('knows which formulas read the column and what kind of value they get', () => {
    expect(formulaReads('{c1} * 2', 'c1')).toBe(true);
    expect(formulaReads('{c2} * 2', 'c1')).toBe(false);
    expect(formulaKindOf('text')).toBe('text');
    expect(formulaKindOf('numbers')).toBe('number');
    expect(formulaKindOf('timeline')).toBe('range');
  });
});

describe('automations', () => {
  const before = {
    columns: [{ key: 'c1', type: 'status', title: 'S', settings: statusSettings }],
    groups: [{ id: 'g', title: 'G' }],
  };
  const after = { ...before, columns: [{ key: 'c1', type: 'text', title: 'S', settings: {} }] };
  it('a status trigger on a column that became text breaks; one on another column does not', () => {
    const recipe = recipeSchema.parse({
      trigger: { type: 'status_changed', column: 'c1', labels: ['הושלם'] },
      actions: [{ type: 'notify', to: ['@creator'], message: 'x' }],
    });
    expect(recipeNames(recipe, 'c1')).toBe(true);
    expect(recipeBreaks(recipe, before, after).length).toBeGreaterThan(0);
    const unrelated = recipeSchema.parse({
      trigger: { type: 'item_created' },
      actions: [{ type: 'notify', to: ['@creator'], message: 'x' }],
    });
    expect(recipeNames(unrelated, 'c1')).toBe(false);
    expect(recipeBreaks(unrelated, before, after)).toEqual([]);
  });
});

describe('dashboard widgets', () => {
  const ref = { type: 'text', title: 'Amount' };
  it('a reference keeps the column (pinned by key) when the new type fits its roles; else it must be chosen again', () => {
    expect(sameWidgetRoles('text', 'numbers')).toBe(true);
    expect(sameWidgetRoles('numbers', 'text')).toBe(false);
    const up = adaptWidgetSettings({ measure: { fn: 'count', column: ref } }, 'b1', col('text', 'numbers'));
    expect(up.updated).toBe(1);
    expect((up.settings.measure as { column: { keys: Record<string, string> } }).column.keys).toEqual({ b1: 'c1' });
    const down = adaptWidgetSettings(
      { measure: { fn: 'sum', column: { type: 'numbers', title: 'Amount', keys: { b1: 'c1' } } } },
      'b1',
      col('numbers', 'text'),
    );
    expect(down.needsChoice).toBe(1);
    expect((down.settings.measure as { column: { keys: Record<string, string> } }).column.keys).toEqual({});
    // Another column of the same title on another type is left alone.
    expect(adaptWidgetSettings({ c: { type: 'status', title: 'Amount' } }, 'b1', col('text', 'numbers')).updated).toBe(
      0,
    );
  });
});
