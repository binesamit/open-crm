// SPDX-License-Identifier: AGPL-3.0-only
import type { DraftRecipe, FilterGroup, FilterRule } from '@bines/shared';

/** A new custom automation: a trigger to start from and no actions yet — the person picks each one. */
export const blankDraft = (): DraftRecipe => ({ trigger: { type: 'item_created' }, actions: [] });

/** The first "only if" rule: a root AND group holding it. */
export const firstConditions = (rule: FilterRule): FilterGroup => ({
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [rule],
});

/**
 * The conditions as they are saved (r16): groups left without rules are dropped at any depth (a group emptied in the
 * editor means nothing), and no rules at all → no conditions. Everything else — operators, negations, rule fields —
 * is kept exactly, so an existing automation saves back unchanged.
 */
export const pruneConditions = (g: FilterGroup | undefined): FilterGroup | undefined => {
  if (!g) return undefined;
  const prune = (group: FilterGroup): FilterGroup | null => {
    let changed = false;
    const rules: (FilterRule | FilterGroup)[] = [];
    for (const r of group.rules) {
      if (r.kind === 'rule') {
        rules.push(r);
        continue;
      }
      const next = prune(r);
      if (next !== r) changed = true;
      if (next) rules.push(next);
    }
    if (!rules.length) return null;
    return changed ? { ...group, rules } : group;
  };
  return prune(g) ?? undefined;
};

/**
 * "Run a test": which top-level part of the conditions failed. The engine reports the first top-level rule that fails
 * on its own by its column, or `'group'` for a nested group. Returns the index of that part when it is unambiguous,
 * `'none_or'` when the root is an "or" (every part failed), or `null` when it cannot be told.
 */
export const failedConditionPart = (
  g: FilterGroup | undefined,
  failedRule: string | null,
): number | 'none_or' | null => {
  if (!g || !g.rules.length) return null;
  if (g.negate) return null;
  if (g.operator === 'or' && g.rules.length > 1) return 'none_or';
  if (!failedRule) return null;
  const hits = g.rules
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => (failedRule === 'group' ? r.kind === 'group' : r.kind === 'rule' && r.column_id === failedRule));
  if (!hits.length) return null;
  // Several parts on the same column / several groups: the engine stops at the first that fails — the earlier ones
  // passed, so only one of them is the failing one; the first is the best guess for a rule, none for groups.
  if (hits.length > 1 && failedRule === 'group') return null;
  return hits[0]!.i;
};
