// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { labelColorSchema } from '../colors';
import { filterRuleSchema, querySchema, type FilterRule } from './filter';
import { rowMatches, type QueryRow } from './evaluate';
import { planQuery, pruneQuery, type QueryEnv } from './plan';

/**
 * Conditional coloring: a rule = a filter condition (13-FILTERS, the same rule model) + a colour,
 * painting the whole item or one column's cell. Saved with the view (15 §7); the first matching rule wins per
 * row and per cell.
 */
export const coloringRuleSchema = z.object({
  id: z.string().min(1).max(40),
  rule: filterRuleSchema,
  /** 'row' = the whole item; 'cell' = the cell of `column_id` (default: the rule's column). */
  target: z.enum(['row', 'cell']).default('row'),
  column_id: z.string().max(64).optional(),
  /** A palette key (`colors.ts`); a saved hex is read as the nearest key. */
  color: labelColorSchema,
});
export type ColoringRule = z.infer<typeof coloringRuleSchema>;
export const MAX_COLORING_RULES = 30;

export type RowColors = { row?: string; cells: Record<string, string> };

/**
 * Compiles the rules once (unknown columns / operators are dropped like a saved filter's) into a function that
 * colours a row. Rules on subitem columns (`sub:`) and system fields work as in the filter.
 */
export const compileColoring = (rules: ColoringRule[], env: QueryEnv) => {
  const compiled = rules.flatMap((r) => {
    const query = pruneQuery(
      querySchema.parse({ filter: { kind: 'group', operator: 'and', rules: [r.rule as FilterRule] } }),
      env,
    );
    if (!query.filter?.rules.length) return [];
    try {
      return [{ r, plan: planQuery(query, env) }];
    } catch {
      return [];
    }
  });
  return (row: QueryRow): RowColors => {
    const out: RowColors = { cells: {} };
    for (const { r, plan } of compiled) {
      if (r.target === 'row' ? out.row : out.cells[r.column_id ?? r.rule.column_id]) continue;
      // Painting marks real matches: a subitem rule never paints an item without subitems.
      if (!rowMatches(plan, row, env.timezone, 'fail')) continue;
      if (r.target === 'row') out.row = r.color;
      else out.cells[r.column_id ?? r.rule.column_id] = r.color;
    }
    return out;
  };
};
