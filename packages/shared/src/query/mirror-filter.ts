// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes } from '../columns';
import type { MirrorSource } from '../columns/defs/computed';
import type { FilterModel, FilterOperator } from '../columns/types';

/**
 * Prod (product owner: "a mirror should filter like the column it mirrors"): a mirror whose source is known filters
 * as that source type does — a mirrored status / dropdown by its labels (and done / not done), people by people,
 * dates by dates, numbers by the number it shows. Its text operators stay (a saved "contains" keeps working). A
 * mirror of anything else — or of a source the viewer cannot see — filters as text, as before.
 *
 * A mirror holds the values of several linked items: by default a rule matches when ANY of them does ("is" / "has"
 * one of the picked labels, people or dates); a rule set to `match: 'all'` needs EVERY linked item to (none linked →
 * no match). The negative operators ("is not", "not done") match when no linked item has the value, and "is empty" /
 * "is not empty" read the cell as a whole — the same in both modes. Numbers compare the number the cell shows (the
 * sum, average … the mirror is set to).
 */
export type MirrorFilter = {
  model: FilterModel;
  operators: FilterOperator[];
  /** Label sources: the labels to pick from (the server merges them by text over the linked boards). */
  labels?: { id: number; label: string; color?: string; is_done?: boolean; is_deactivated?: boolean }[];
};

/**
 * The operators whose rule offers "any / all linked items" (`FilterRule.match`): those that look for a value. The
 * others read the same either way — "is not" / "not done" (no linked item has it), "is empty" / "is not empty" (the
 * cell as a whole) — and a number compares the one number the cell shows.
 */
export const MIRROR_MATCH_OPS: readonly FilterOperator[] = [
  'any_of',
  'is_done',
  'greater_than',
  'lower_than',
  'between',
  'within_the_last',
  'within_the_next',
];
const MATCH_MODELS = new Set<string>(['label', 'labels', 'people', 'date']);

/** Whether a rule on this field and operator has the any / all choice (a mirror filtered as its source). */
export const mirrorMatchApplies = (
  f: { source: string; model: string; mirrored?: true },
  op: FilterOperator,
): boolean => f.source === 'column' && !!f.mirrored && MATCH_MODELS.has(f.model) && MIRROR_MATCH_OPS.includes(op);

const LIST_OPS: FilterOperator[] = ['any_of', 'not_any_of', 'is_empty', 'is_not_empty', 'is_done', 'is_not_done'];
const TEXT_ONLY_OPS: FilterOperator[] = ['contains_text', 'not_contains_text', 'starts_with', 'ends_with'];

export const mirrorFilterOf = (source: MirrorSource | null | undefined): MirrorFilter | null => {
  const def = source ? columnTypes.get(source.type) : undefined;
  if (!source || !def) return null;
  const own = def.filterOperators;
  switch (def.filterModel) {
    case 'label':
    case 'labels': {
      const labels = Array.isArray(source.settings.labels) ? (source.settings.labels as MirrorFilter['labels'])! : [];
      return {
        model: def.filterModel,
        operators: [...own.filter((op) => LIST_OPS.includes(op)), ...TEXT_ONLY_OPS],
        labels,
      };
    }
    case 'people':
      return { model: 'people', operators: [...own.filter((op) => LIST_OPS.includes(op)), ...TEXT_ONLY_OPS] };
    case 'date':
      return { model: 'date', operators: own };
    case 'number':
      return { model: 'number', operators: own };
    default:
      return null;
  }
};
