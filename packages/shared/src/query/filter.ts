// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { FilterOperator } from '../columns/types';

/**
 * The query model (13-FILTERS §1): one recursive AND/OR/NOT tree serves the board toolbar, saved views,
 * `items/query`, automation conditions and `view_items: by_filter`.
 */
export const MAX_FILTER_DEPTH = 5;
export const MAX_FILTER_RULES = 50;
export const MAX_SORT_LEVELS = 5;
/** Grouping levels a view may nest (ק3): the first plus up to two subgroups. */
export const MAX_GROUP_LEVELS = 3;

export const FILTER_OPERATORS = [
  'any_of',
  'not_any_of',
  'is_empty',
  'is_not_empty',
  'contains_text',
  'not_contains_text',
  'starts_with',
  'ends_with',
  'greater_than',
  'greater_than_or_equal',
  'lower_than',
  'lower_than_or_equal',
  'between',
  'within_the_last',
  'within_the_next',
  'is_done',
  'is_not_done',
  'has_unmatched_link',
  'no_unmatched_link',
  'is_running',
  'is_not_running',
] as const satisfies readonly FilterOperator[];

export const filterRuleSchema = z
  .object({
    kind: z.literal('rule').default('rule'),
    /** Column key, or a system field (`__group__`, `__created_at__`, … — see query/fields.ts). */
    column_id: z.string().min(1).max(64),
    operator: z.enum(FILTER_OPERATORS),
    values: z.array(z.unknown()).max(200).default([]),
    /** timeline: 'start' | 'end' (default: the whole range). */
    attribute: z.string().max(32).optional(),
    /**
     * Prod — a mirror over several linked items: `any` (default) = one of them matching is enough, `all` =
     * every linked item must match (none linked → no match). Only "is", "done", date and range rules read it; "is
     * not", "not done", "is empty" / "is not empty" mean the same either way (no linked item has it / the cell as a
     * whole). Ignored on other columns. See `MIRROR_MATCH_OPS`.
     */
    match: z.enum(['any', 'all']).optional(),
    negate: z.boolean().default(false),
    /**
     * Set when the rule stopped applying (D28: its column changed type — `column_type_changed:<conversion id>`):
     * kept in the view, shown as "not valid after a type change", ignored by the engine until removed.
     */
    disabled: z.string().max(80).optional(),
  })
  .meta({ id: 'FilterRule' });
export type FilterRule = z.infer<typeof filterRuleSchema>;

export type FilterGroup = {
  kind: 'group';
  operator: 'and' | 'or';
  negate: boolean;
  rules: (FilterRule | FilterGroup)[];
};

// Recursive via a getter (zod 4) + a named component, so OpenAPI emits a $ref instead of recursing forever.
export const filterGroupSchema: z.ZodType<FilterGroup, unknown> = z
  .object({
    kind: z.literal('group'),
    operator: z.enum(['and', 'or']),
    negate: z.boolean().default(false),
    get rules() {
      return z.array(z.union([filterGroupSchema, filterRuleSchema])).max(MAX_FILTER_RULES);
    },
  })
  .meta({ id: 'FilterGroup' });

export const sortLevelSchema = z.object({
  column_id: z.string().min(1).max(64),
  direction: z.enum(['asc', 'desc']).default('asc'),
  nulls: z.enum(['first', 'last']).default('last'),
});
export type SortLevel = z.infer<typeof sortLevelSchema>;

/**
 * How a date groups: `when` — relative to today (overdue, today, tomorrow, this week …; the
 * default), or one bucket per day / week (the account's week start) / month / quarter / year.
 */
export const GROUP_DATE_UNITS = ['when', 'day', 'week', 'month', 'quarter', 'year'] as const;
export type GroupDateUnit = (typeof GROUP_DATE_UNITS)[number];

/**
 * How a column that is not a date groups (ק2): `each` value (each label / person / linked item), the
 * whole `combo`, a person's `team`; labels by `name` instead of their order; numbers `exact` or in `ranges`; text by
 * its `first_letter`, an email's / link's `domain`, a phone's / address's `country`.
 */
export const GROUP_MODES = [
  'each',
  'combo',
  'team',
  'name',
  'exact',
  'ranges',
  'first_letter',
  'domain',
  'country',
] as const;
export type GroupMode = (typeof GROUP_MODES)[number];

export const groupBySchema = z.object({
  column_id: z.string().min(1).max(64),
  direction: z.enum(['asc', 'desc']).default('asc'),
  collapse: z.boolean().default(false),
  /** A date column: how it groups (absent = `when`). */
  date_unit: z.enum(GROUP_DATE_UNITS).optional(),
  /** `when`: the past in detail (last week, last month …) instead of one "overdue" bucket. */
  past_detail: z.boolean().optional(),
  /** A timeline: group by its start (default) or its end. */
  date_edge: z.enum(['start', 'end']).optional(),
  /** How other columns group (ק2; `groupModes` lists a column's, the first is its default). */
  mode: z.enum(GROUP_MODES).optional(),
  /** `ranges`: the size of a range (absent = a size picked from the values). */
  range_size: z.number().positive().max(1e12).optional(),
  /** Status / labels: a group for every label, also those no item is on (planning). */
  show_empty: z.boolean().optional(),
});
export type GroupBy = z.infer<typeof groupBySchema>;

/** What a view saves and what the toolbar edits — no paging. */
export const querySchema = z.object({
  filter: filterGroupSchema.optional(),
  /** Free text over the item name and every stored cell's text; AND with `filter`. */
  search: z.string().max(200).optional(),
  /** Toolbar "Person": `me` / `user:<id>` / `team:<id>` on every people column (OR between them). */
  person: z.string().max(80).optional(),
  sort: z.array(sortLevelSchema).max(MAX_SORT_LEVELS).default([]),
  group_by: groupBySchema.optional(),
  /**
   * Prod ק3: up to two more levels inside each group — the board's groups when `group_by`
   * is absent, else its buckets. Sorting applies inside the deepest level.
   */
  subgroups: z
    .array(groupBySchema)
    .max(MAX_GROUP_LEVELS - 1)
    .optional(),
  scope: z.enum(['all', 'parents', 'subitems']).default('all'),
  /** With scope 'parents': a parent also matches when one of its descendants does. */
  match_children: z.boolean().default(false),
  /**
   * Strict subitem filtering: a subitem that does not match by its own values is left out together
   * with everything under it — no dimmed "path" rows to a deeper match — and an item stays only when it matches by
   * its own values or through a chain of subitems that each match. Off by default (the path rows stay).
   */
  subitems_strict: z.boolean().optional(),
  /**
   * For saved views (the web app sets it when it sends a view's query): rules that cannot run on the board — their
   * column is gone, or its type lacks the operator (old or imported data) — are skipped instead of
   * failing with 422. Absent = strict: API, automation, MCP and AI callers get the error.
   */
  ignore_invalid_rules: z.boolean().optional(),
});
export type Query = z.infer<typeof querySchema>;
export type QueryInput = z.input<typeof querySchema>;

/**
 * A flat rule a form can fill in (integrations: Make, n8n): one column, one operator, the value as typed or as
 * picked from the column's choices. `rules` on `items/query` are ANDed together and with `filter`.
 */
export const simpleRuleSchema = z.object({
  column_id: z.string().min(1).max(64),
  operator: z.enum(FILTER_OPERATORS).default('any_of'),
  /** Typed: for `any_of` / `not_any_of` several values comma-separated (or an array); ignored by the empty checks. */
  value: z.unknown().optional(),
  /** Picked from the column's choices: wins over `value` when set. */
  choice: z.unknown().optional(),
});
export type SimpleRule = z.infer<typeof simpleRuleSchema>;

const blankValue = (v: unknown) => v === undefined || v === null || v === '';
const valueList = (v: unknown): unknown[] =>
  Array.isArray(v)
    ? v
    : String(v)
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

/** Simple rules → one AND group of the query model. */
export const rulesToFilter = (rules: SimpleRule[]): FilterGroup => ({
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: rules.map((r) => {
    const v = blankValue(r.choice) ? r.value : r.choice;
    const values =
      r.operator === 'is_empty' || r.operator === 'is_not_empty' || blankValue(v)
        ? []
        : r.operator === 'any_of' || r.operator === 'not_any_of'
          ? valueList(v)
          : [v];
    return { kind: 'rule' as const, column_id: r.column_id, operator: r.operator, values, negate: false };
  }),
});

/** `POST /boards/:id/items/query` body: a query plus paging. */
export const itemsQueryRequestSchema = querySchema.extend({
  /** Flat AND rules (integrations), ANDed with `filter`. */
  rules: z.array(simpleRuleSchema).max(MAX_FILTER_RULES).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(500).default(100),
});
export type ItemsQueryRequest = z.infer<typeof itemsQueryRequestSchema>;

export const isGroup = (n: FilterRule | FilterGroup): n is FilterGroup => n.kind === 'group';

/** Every rule of the tree, depth first. */
export const flattenRules = (g: FilterGroup | undefined): FilterRule[] =>
  g ? g.rules.flatMap((r) => (isGroup(r) ? flattenRules(r) : [r])) : [];

/** Nesting depth: a root group with rules only = 1. */
export const filterDepth = (g: FilterGroup): number =>
  1 + Math.max(0, ...g.rules.filter(isGroup).map((r) => filterDepth(r)));

/** Base64url of a query, for `?q=` (13 §5, 15 §2). Unicode-safe. */
export const encodeQuery = (q: QueryInput): string => {
  const bytes = new TextEncoder().encode(JSON.stringify(q));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** Parses `?q=`; throws on malformed input (the caller maps it to 422). */
export const decodeQuery = (s: string): Query => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const json = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  return querySchema.parse(JSON.parse(json));
};

/** True when the query narrows nothing (no filter rules, search or person). */
export const isEmptyFilter = (q: Pick<Query, 'filter' | 'search' | 'person'>) =>
  !flattenRules(q.filter).length && !q.search?.trim() && !q.person;
