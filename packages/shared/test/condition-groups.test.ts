// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { conditionLines, conditionText, recipeText, type FilterGroup, type FilterRule, type Recipe } from '../src';

/**
 * Round 16 — "and" / "or" and groups in automation conditions: the readable sentence shows the
 * builder's tree with parentheses, sub-board columns by name, and people / groups by name.
 */
const board = {
  columns: [
    { key: 'status', title: 'סטטוס', type: 'status' },
    { key: 'due', title: 'יעד', type: 'date' },
    { key: 'owner', title: 'אחראי', type: 'people' },
  ],
  subColumns: [{ key: 'sstat', title: 'מצב', type: 'status' }],
  groups: [{ id: 'g1', title: 'סגורים' }],
  personName: (id: string) => (id === 'u1' ? 'דנה' : undefined),
};
const rule = (column_id: string, operator: FilterRule['operator'], values: unknown[] = []): FilterRule => ({
  kind: 'rule',
  column_id,
  operator,
  values,
  negate: false,
});
const group = (operator: 'and' | 'or', rules: FilterGroup['rules'], negate = false): FilterGroup => ({
  kind: 'group',
  operator,
  negate,
  rules,
});

describe('r16 and / or conditions in words', () => {
  it('A and (B or C)', () => {
    const tree = group('and', [
      rule('status', 'any_of', ['Done']),
      group('or', [rule('due', 'is_empty'), rule('owner', 'is_not_empty')]),
    ]);
    expect(conditionText(tree, board)).toBe('סטטוס הוא Done וגם (יעד ריק או אחראי לא ריק)');
    expect(conditionLines(tree, board)).toEqual(['סטטוס הוא Done', '(יעד ריק או אחראי לא ריק)']);
    const recipe = { trigger: { type: 'item_created' }, conditions: tree, actions: [{ type: 'archive_item' }] };
    expect(recipeText(recipe as unknown as Recipe, board)).toContain(
      'ורק אם סטטוס הוא Done וגם (יעד ריק או אחראי לא ריק)',
    );
  });

  it('a negated group and a negated root read with "not"', () => {
    const tree = group('or', [rule('due', 'is_empty'), group('and', [rule('status', 'is_empty')], true)], true);
    expect(conditionText(tree, board)).toBe('לא: (יעד ריק או לא: (סטטוס ריק))');
  });

  it('people, groups and sub-board columns read by name', () => {
    const tree = group('and', [
      rule('owner', 'any_of', ['user:u1', 'me']),
      rule('__group__', 'any_of', ['g1']),
      rule('sub:sstat', 'is_not_empty'),
    ]);
    expect(conditionLines(tree, board)).toEqual(['אחראי הוא דנה או אני', 'קבוצה הוא סגורים', 'תת-פריט › מצב לא ריק']);
  });
});
