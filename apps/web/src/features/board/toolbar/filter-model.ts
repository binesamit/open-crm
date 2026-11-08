// SPDX-License-Identifier: AGPL-3.0-only
import {
  columnTypes,
  isGroup,
  operatorsOf,
  resolveField,
  SYSTEM_FIELDS,
  t,
  type Column,
  type Field,
  type FilterGroup,
  type FilterOperator,
  type FilterRule,
  type MessageKey,
  type QueryEnv,
  isSubField,
  SUB_PREFIX,
  hasChoiceFilter,
  isRelationMatchOp,
  supportsOperator,
  type DateToken,
} from '@bines/shared';
/** Pure helpers behind the filter panel (13-FILTERS §4). */

export const emptyGroup = (operator: 'and' | 'or' = 'and'): FilterGroup => ({
  kind: 'group',
  operator,
  negate: false,
  rules: [],
});

/** Fields a rule can use: filterable columns in board order, then the system fields that make sense in the UI. */
const filterable = (c: Column) => (columnTypes.get(c.type)?.filterOperators.length ?? 0) > 0;

/** The board's columns, system fields, then the subitems' columns (`sub:<key>` — "has a subitem where…", D14). */
export const filterFields = (columns: Column[], subColumns: Column[] = []) => [
  ...columns.filter(filterable).map((c) => ({ id: c.id, title: c.title, type: c.type as string | undefined })),
  ...(['__group__', '__created_at__', '__updated_at__', '__creator__'] as const).map((id) => ({
    id,
    title: t(`filter.field.${id}` as MessageKey),
    type: undefined,
  })),
  ...subColumns.filter(filterable).map((c) => ({
    id: `${SUB_PREFIX}${c.id}`,
    title: t('filter.subitem', { title: c.title }),
    type: c.type as string,
  })),
];

export const fieldTitle = (id: string, columns: Column[], subColumns: Column[] = []) => {
  if (isSubField(id)) {
    const c = subColumns.find((x) => `${SUB_PREFIX}${x.id}` === id);
    return c ? t('filter.subitem', { title: c.title }) : id;
  }
  return columns.find((c) => c.id === id)?.title ?? (id in SYSTEM_FIELDS ? t(`filter.field.${id}` as MessageKey) : id);
};

export const safeField = (id: string, env: QueryEnv): Field | null => {
  try {
    return resolveField(id, env);
  } catch {
    return null;
  }
};

/** `safeField` as the filter reads it: a mirror as the column it mirrors. */
export const filterField = (id: string, env: QueryEnv): Field | null => {
  try {
    return resolveField(id, env, 'filter');
  } catch {
    return null;
  }
};

/**
 * Operators offered for a field; relations hide id-based any_of (no item picker in the builder yet), and offer
 * "has a link that does not match" only when the column has a choice filter (r19relfilter).
 */
export const operatorChoices = (f: Field): FilterOperator[] =>
  operatorsOf(f).filter(
    (op) =>
      !(f.model === 'links' && (op === 'any_of' || op === 'not_any_of')) &&
      !(isRelationMatchOp(op) && (f.source !== 'column' || !hasChoiceFilter(f.settings))),
  );

/** Quick filters toggle top-level `any_of` rules: only fields that support `any_of` get a quick column. */
export const hasQuickFilter = (f: Field | null): f is Field => !!f && supportsOperator(f, 'any_of');

/** The relative choices of a date column's quick filter (today, this week, overdue…). */
export const QUICK_DATE_TOKENS: DateToken[] = [
  'TODAY',
  'YESTERDAY',
  'TOMORROW',
  'THIS_WEEK',
  'LAST_WEEK',
  'NEXT_WEEK',
  'THIS_MONTH',
  'LAST_MONTH',
  'NEXT_MONTH',
  'OVERDUE',
];

/**
 * A date column's quick-filter options, each with the rule its count is computed by — the same rule a click stores
 * (`toggleQuick`: any_of). Only for types with any_of; "blank" only when the type can be empty at all (it has
 * is_empty). the count used to plan an is_empty rule on a creation log, which has no such operator
 * and the whole board crashed.
 */
export const quickDateRules = (columnId: string, field: Field): { value: DateToken | null; rule: FilterRule }[] => {
  const rule = (operator: FilterOperator, values: unknown[]): FilterRule => ({
    kind: 'rule',
    column_id: columnId,
    operator,
    values,
    negate: false,
  });
  if (!supportsOperator(field, 'any_of')) return [];
  return [
    ...QUICK_DATE_TOKENS.map((value) => ({ value, rule: rule('any_of', [value]) })),
    ...(supportsOperator(field, 'is_empty') ? [{ value: null, rule: rule('any_of', [null]) }] : []),
  ];
};

/** Operator wording depends on the model: dates say before/after, check boxes checked/unchecked. */
export const operatorLabel = (op: FilterOperator, f: Field | null): string => {
  if (f?.model === 'date' && (op === 'greater_than' || op === 'lower_than')) return t(`filter.op.date.${op}`);
  if (f?.model === 'checkbox' && (op === 'is_empty' || op === 'is_not_empty')) return t(`filter.op.checkbox.${op}`);
  return t(`filter.op.${op}` as MessageKey);
};

export const NO_VALUE_OPS = new Set<FilterOperator>([
  'is_empty',
  'is_not_empty',
  'is_done',
  'is_not_done',
  'has_unmatched_link',
  'no_unmatched_link',
  'is_running',
  'is_not_running',
]);

export const newRule = (columns: Column[], env: QueryEnv): FilterRule => {
  const first = filterFields(columns)[0]!;
  const f = filterField(first.id, env);
  return {
    kind: 'rule',
    column_id: first.id,
    operator: f ? operatorChoices(f)[0]! : 'is_not_empty',
    values: [],
    negate: false,
  };
};

/**
 * Changing the field keeps the operator when the new field has it, and drops values of another kind — and a
 * mirror's "all linked items" (it belongs to that column).
 */
export const changeField = (rule: FilterRule, columnId: string, env: QueryEnv): FilterRule => {
  const f = filterField(columnId, env);
  const ops = f ? operatorChoices(f) : [];
  const prev = filterField(rule.column_id, env);
  const sameModel = prev && f && prev.model === f.model;
  return {
    ...withMatch(rule, 'any'),
    column_id: columnId,
    operator: ops.includes(rule.operator) ? rule.operator : ops[0]!,
    values: sameModel ? rule.values : [],
  };
};

/** A mirror rule's "any / all linked items"; `any` is the default and is not stored. */
export const withMatch = (rule: FilterRule, match: 'any' | 'all'): FilterRule => {
  const { match: _old, ...rest } = rule;
  return match === 'all' ? { ...rest, match } : rest;
};

export const changeOperator = (rule: FilterRule, operator: FilterOperator): FilterRule => {
  const kind = (op: FilterOperator) =>
    NO_VALUE_OPS.has(op)
      ? 'none'
      : op === 'between'
        ? 'pair'
        : op === 'within_the_last' || op === 'within_the_next'
          ? 'relative'
          : 'list';
  return { ...rule, operator, values: kind(operator) === kind(rule.operator) ? rule.values : [] };
};

// ---- quick filters: one top-level `any_of` rule per column in a root AND group ----

const rootAnd = (filter: FilterGroup | undefined): FilterGroup => {
  if (!filter) return emptyGroup();
  return filter.operator === 'and' && !filter.negate ? filter : { ...emptyGroup(), rules: [filter] };
};

const quickIndex = (g: FilterGroup, columnId: string) =>
  g.rules.findIndex((r) => !isGroup(r) && r.column_id === columnId && r.operator === 'any_of' && !r.negate);

export const quickValues = (filter: FilterGroup | undefined, columnId: string): unknown[] => {
  if (!filter || filter.operator !== 'and' || filter.negate) return [];
  const r = filter.rules[quickIndex(filter, columnId)];
  return r && !isGroup(r) ? r.values : [];
};

const sameValue = (a: unknown, b: unknown) => a === b || (a === null && b === null);

/** Toggles one value of a column's quick filter; the rule disappears with its last value. */
export const toggleQuick = (
  filter: FilterGroup | undefined,
  columnId: string,
  value: unknown,
): FilterGroup | undefined => {
  const root = rootAnd(filter);
  const i = quickIndex(root, columnId);
  const current = i >= 0 ? (root.rules[i] as FilterRule).values : [];
  const values = current.some((v) => sameValue(v, value))
    ? current.filter((v) => !sameValue(v, value))
    : [...current, value];
  const rules = [...root.rules];
  // A mirror's "all linked items" set in the advanced conditions stays.
  const match = i >= 0 ? (root.rules[i] as FilterRule).match : undefined;
  const rule: FilterRule = {
    kind: 'rule',
    column_id: columnId,
    operator: 'any_of',
    values,
    negate: false,
    ...(match ? { match } : {}),
  };
  if (i >= 0) {
    if (values.length) rules[i] = rule;
    else rules.splice(i, 1);
  } else rules.push(rule);
  return rules.length ? { ...root, rules } : undefined;
};

/** A rule the quick lists own: a top-level, non-negated `any_of` of a column with a quick list, in a plain AND root. */
const isQuickRule = (filter: FilterGroup, node: FilterRule | FilterGroup, quickIds: string[]) =>
  filter.operator === 'and' &&
  !filter.negate &&
  !isGroup(node) &&
  node.operator === 'any_of' &&
  !node.negate &&
  quickIds.includes(node.column_id);

/** Complete rules the quick lists do not show (the "advanced conditions" entry's count). */
export const advancedRuleCount = (filter: FilterGroup | undefined, quickIds: string[]): number =>
  filter
    ? filter.rules.reduce(
        (n, r) =>
          n +
          (isQuickRule(filter, r, quickIds)
            ? 0
            : isGroup(r)
              ? activeRuleCount(r)
              : NO_VALUE_OPS.has(r.operator) || r.values.length
                ? 1
                : 0),
        0,
      )
    : 0;

/** Where the filter panel opens: the first list with a choice, else the advanced conditions when they hold rules. */
export const ADVANCED = 'advanced';
export const startSection = (filter: FilterGroup | undefined, quickIds: string[]): string =>
  quickIds.find((id) => quickValues(filter, id).length) ??
  (advancedRuleCount(filter, quickIds) || !quickIds.length ? ADVANCED : quickIds[0]!);

/** Number of complete rules (the toolbar badge). */
export const activeRuleCount = (g: FilterGroup | undefined): number =>
  g
    ? g.rules.reduce(
        (n, r) => n + (isGroup(r) ? activeRuleCount(r) : NO_VALUE_OPS.has(r.operator) || r.values.length ? 1 : 0),
        0,
      )
    : 0;

// ---- chips (N2): one chip per complete rule, at any depth ----

/** A rule's place in the tree: indexes from the root group down. */
export type RulePath = number[];

const complete = (r: FilterRule) => NO_VALUE_OPS.has(r.operator) || r.values.length > 0;

/** Every complete rule with its path, in tree order (the toolbar shows each as a chip). */
export const activeRules = (g: FilterGroup | undefined, at: RulePath = []): { path: RulePath; rule: FilterRule }[] =>
  g
    ? g.rules.flatMap((r, i) =>
        isGroup(r) ? activeRules(r, [...at, i]) : complete(r) ? [{ path: [...at, i], rule: r }] : [],
      )
    : [];

/** Removes the rule at `path`; groups left empty go too, and an empty root is no filter at all. */
export const removeRuleAt = (g: FilterGroup | undefined, path: RulePath): FilterGroup | undefined => {
  if (!g || !path.length) return g;
  const [i, ...rest] = path as [number, ...number[]];
  const node = g.rules[i];
  if (node === undefined) return g;
  const rules = [...g.rules];
  const next = rest.length && isGroup(node) ? removeRuleAt(node, rest) : undefined;
  if (next) rules[i] = next;
  else rules.splice(i, 1);
  return rules.length ? { ...g, rules } : undefined;
};
