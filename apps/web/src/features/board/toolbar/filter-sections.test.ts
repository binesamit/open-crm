// SPDX-License-Identifier: AGPL-3.0-only
import type { FilterGroup, FilterRule } from '@bines/shared';
import { describe, expect, it } from 'vitest';
import { ADVANCED, advancedRuleCount, startSection, toggleQuick } from './filter-model';

/** Prod (filter panel option B): the rail's counts and where the panel opens. */
const rule = (column_id: string, operator: FilterRule['operator'], values: unknown[], negate = false): FilterRule => ({
  kind: 'rule',
  column_id,
  operator,
  values,
  negate,
});
const group = (rules: FilterGroup['rules'], operator: 'and' | 'or' = 'and', negate = false): FilterGroup => ({
  kind: 'group',
  operator,
  negate,
  rules,
});
const quick = ['__group__', 'status', 'person'];

describe('advancedRuleCount', () => {
  it('is 0 with no filter, or only quick picks', () => {
    expect(advancedRuleCount(undefined, quick)).toBe(0);
    const f = toggleQuick(toggleQuick(undefined, 'status', 'Done'), 'person', 'me');
    expect(advancedRuleCount(f, quick)).toBe(0);
  });

  it('counts complete rules the quick lists cannot show, at any depth', () => {
    const f = group([
      rule('status', 'any_of', ['Done']), // quick
      rule('status', 'any_of', ['Blocked'], true), // negated: advanced
      rule('text', 'contains_text', ['abc']),
      rule('text', 'contains_text', []), // incomplete: not counted
      rule('date', 'is_empty', []),
      group([rule('person', 'any_of', ['me']), rule('num', 'greater_than', [3])], 'or'),
    ]);
    expect(advancedRuleCount(f, quick)).toBe(5);
  });

  it('an OR or negated root has no quick picks: every rule is advanced', () => {
    expect(advancedRuleCount(group([rule('status', 'any_of', ['Done'])], 'or'), quick)).toBe(1);
    expect(advancedRuleCount(group([rule('status', 'any_of', ['Done'])], 'and', true), quick)).toBe(1);
  });
});

describe('startSection', () => {
  it('opens on the first list when nothing is filtered', () => {
    expect(startSection(undefined, quick)).toBe('__group__');
  });
  it('opens on the first list that has a pick', () => {
    expect(startSection(toggleQuick(undefined, 'person', 'me'), quick)).toBe('person');
  });
  it('opens on the advanced conditions when only they hold rules', () => {
    expect(startSection(group([rule('text', 'contains_text', ['a'])]), quick)).toBe(ADVANCED);
  });
  it('opens on the advanced conditions when there is no quick list at all', () => {
    expect(startSection(undefined, [])).toBe(ADVANCED);
  });
});
