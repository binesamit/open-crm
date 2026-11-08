// SPDX-License-Identifier: AGPL-3.0-only
import { flattenRules, type FilterGroup, type FilterRule } from '../query/filter';
import { rowMatches, type QueryRow } from '../query/evaluate';
import { planQuery, type QueryEnv } from '../query/plan';

/**
 * 04 §3 — "only if" conditions are the query model's filter tree (13-FILTERS), run by the same in-memory
 * engine as the board toolbar on a fresh item snapshot. A missing cell is empty.
 */
export type ConditionResult = { matched: true } | { matched: false; failed_rule: string | null };

export const evaluateConditions = (
  conditions: FilterGroup | undefined,
  row: QueryRow,
  env: QueryEnv,
): ConditionResult => {
  if (!conditions || !flattenRules(conditions).length) return { matched: true };
  const plan = planQuery({ filter: conditions, sort: [], scope: 'all', match_children: false }, env);
  if (rowMatches(plan, row, env.timezone)) return { matched: true };
  // The first top-level rule that fails on its own — for the run log (04 §5.3 step 4).
  for (const r of conditions.rules) {
    const one = planQuery(
      {
        filter: { kind: 'group', operator: 'and', negate: false, rules: [r] },
        sort: [],
        scope: 'all',
        match_children: false,
      },
      env,
    );
    if (!rowMatches(one, row, env.timezone))
      return { matched: false, failed_rule: r.kind === 'rule' ? r.column_id : 'group' };
  }
  return { matched: false, failed_rule: null };
};

/**
 * round 2 — each top-level part of a condition tree (a rule or a nested group) on its own: whether the item
 * meets it. A workflow move lists the parts that are not met (and the popup ticks them off as they are filled in).
 * A part on a column that is gone counts as met, as the tree does.
 */
export const conditionParts = (
  conditions: FilterGroup | undefined,
  row: QueryRow,
  env: QueryEnv,
): { part: FilterRule | FilterGroup; met: boolean }[] =>
  (conditions?.rules ?? [])
    .filter((r) => (r.kind === 'rule' ? !r.disabled : flattenRules(r).length > 0))
    .map((part) => {
      try {
        const one = planQuery(
          {
            filter: { kind: 'group', operator: 'and', negate: false, rules: [part] },
            sort: [],
            scope: 'all',
            match_children: false,
          },
          env,
        );
        return { part, met: rowMatches(one, row, env.timezone) };
      } catch {
        return { part, met: true };
      }
    });

/** Checks the columns and operators of a condition tree against a board; throws the planner's 422 AppError. */
export const validateConditions = (conditions: FilterGroup | undefined, env: QueryEnv) => {
  if (conditions) planQuery({ filter: conditions, sort: [], scope: 'all', match_children: false }, env);
};
