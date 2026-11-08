// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { filterGroupSchema, type FilterGroup, type FilterRule } from '@bines/shared';
import { blankDraft, failedConditionPart, firstConditions, pruneConditions } from './recipe-draft';

const rule = (column_id: string, extra: Partial<FilterRule> = {}): FilterRule => ({
  kind: 'rule',
  column_id,
  operator: 'is_not_empty',
  values: [],
  negate: false,
  ...extra,
});
const group = (operator: 'and' | 'or', rules: FilterGroup['rules'], negate = false): FilterGroup => ({
  kind: 'group',
  operator,
  negate,
  rules,
});

describe('automation builder drafts', () => {
  it('a new custom automation starts with no actions (nothing pre-filled that looks undeletable)', () => {
    expect(blankDraft().actions).toEqual([]);
  });

  it('the first condition makes a root AND group', () => {
    expect(firstConditions(rule('a'))).toEqual(group('and', [rule('a')]));
  });

  it('round trip: an existing tree (and / or, nested, negated, rule fields) saves back unchanged', () => {
    const trees: FilterGroup[] = [
      group('and', [rule('a')]),
      group('or', [rule('a'), rule('b', { operator: 'any_of', values: ['Done', null] })]),
      group('and', [rule('a'), group('or', [rule('b'), rule('c', { negate: true })])]),
      group('or', [group('and', [rule('a'), group('or', [rule('b'), group('and', [rule('c')], true)])])], true),
      group('and', [rule('d', { attribute: 'end', operator: 'within_the_last', values: [3, 'days'] })]),
      group('and', [rule('e', { disabled: 'column_type_changed:x' })]),
    ];
    for (const tree of trees) {
      const saved = pruneConditions(structuredClone(tree));
      expect(saved).toEqual(tree);
      // …and it is still a valid stored filter tree.
      expect(filterGroupSchema.parse(saved)).toEqual(tree);
    }
    expect(pruneConditions(undefined)).toBeUndefined();
  });

  it('validation: empty groups are not saved, at any depth; nothing left → no conditions', () => {
    expect(
      pruneConditions(group('and', [rule('a'), group('or', []), group('or', [rule('b'), group('and', [])])])),
    ).toEqual(group('and', [rule('a'), group('or', [rule('b')])]));
    expect(pruneConditions(group('and', [group('or', [group('and', [])])]))).toBeUndefined();
    expect(pruneConditions(group('or', []))).toBeUndefined();
  });

  it('test dialog: which top-level part failed', () => {
    const tree = group('and', [rule('a'), group('or', [rule('b'), rule('c')])]);
    expect(failedConditionPart(tree, 'a')).toBe(0);
    expect(failedConditionPart(tree, 'group')).toBe(1);
    expect(failedConditionPart(tree, 'zzz')).toBeNull();
    expect(failedConditionPart(group('or', [rule('a'), rule('b')]), 'a')).toBe('none_or');
    expect(failedConditionPart(group('and', [rule('a')], true), 'a')).toBeNull();
    // Two groups: the engine only says "a group" — not told which.
    expect(failedConditionPart(group('and', [group('or', [rule('a')]), group('or', [rule('b')])]), 'group')).toBeNull();
    expect(failedConditionPart(undefined, 'a')).toBeNull();
  });
});
