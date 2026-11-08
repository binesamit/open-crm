// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes } from '../columns';
import type { AnyColumnTypeDef, FilterModel, FilterOperator } from '../columns/types';
import { comparesNumbers, DATE_OPS, NUMBER_OPS, TEXT_OPS } from '../columns/types';
import type { MirrorSource } from '../columns/defs/computed';
import { mirrorFilterOf, mirrorMatchApplies } from './mirror-filter';
import { AppError } from '../errors';
import { relativeSpan, resolveDateValue, type DateEnv, type DateSpan } from './dates';
import {
  filterDepth,
  flattenRules,
  isGroup,
  MAX_FILTER_DEPTH,
  MAX_FILTER_RULES,
  type FilterGroup,
  type FilterRule,
  type Query,
} from './filter';

/**
 * Resolves a Query against a board once (13-FILTERS §2–3): columns and operators are checked, label texts become
 * ids, `me`/teams become user ids, date tokens become spans. The in-memory engine (evaluate.ts) and the SQL
 * compiler (api items/query.repo.ts) both walk this plan, so they cannot disagree on what a value means.
 */

/** A board column as the engine sees it (the Column DTO: `id` is the column key). */
/** `mirror_source`: a mirror's resolved source (its footer summaries); absent = unknown. */
export type QueryColumn = {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  mirror_source?: MirrorSource | null;
};

/** A Column DTO as the engine reads it (with a mirror's resolved source, when the server sent it). */
export const queryColumnOf = (c: QueryColumn): QueryColumn => ({
  id: c.id,
  type: c.type,
  settings: c.settings,
  ...(c.mirror_source !== undefined ? { mirror_source: c.mirror_source } : {}),
});

export type QueryEnv = DateEnv & {
  columns: QueryColumn[];
  meId: string | null;
  /** Teams of the account with their members (people values `team:<id>`, and a user's own teams). */
  teams?: { id: string; member_ids: string[] }[];
  /** The sub-board's columns (D14): rules on `sub:<key>` and match_children read them on the subitems. */
  subitems?: QueryColumn[];
  /**
   * r19relfilter: per relation column key, the linked items that do not match its choice filter (for this viewer).
   * `has_unmatched_link` / `no_unmatched_link` read it; missing = nothing is unmatched.
   */
  relationUnmatched?: Record<string, string[]>;
};

/**
 * A filter column of the subitems (D14): `sub:<sub-board column key>` — "has a subitem where …". An item with no
 * subitems is not excluded by such rules (they do not apply to it — see `nodeMatches`).
 */
export const SUB_PREFIX = 'sub:';
export const isSubField = (id: string) => id.startsWith(SUB_PREFIX);

/** `ids` = plain string ids of a system field (group, parent item). */
export type EngineModel = FilterModel | 'ids';

export type SystemFieldId =
  '__group__' | '__parent__' | '__creator__' | '__created_at__' | '__updated_at__' | '__depth__' | '__key__';

export const SYSTEM_FIELDS: Record<
  SystemFieldId,
  { model: EngineModel; operators: FilterOperator[]; sortKey: 'text' | 'number' | 'date' }
> = {
  __group__: { model: 'ids', operators: ['any_of', 'not_any_of'], sortKey: 'text' },
  __parent__: { model: 'ids', operators: ['any_of', 'not_any_of', 'is_empty', 'is_not_empty'], sortKey: 'text' },
  __creator__: { model: 'people', operators: ['any_of', 'not_any_of', 'is_empty', 'is_not_empty'], sortKey: 'text' },
  __created_at__: { model: 'date', operators: DATE_OPS, sortKey: 'date' },
  __updated_at__: { model: 'date', operators: DATE_OPS, sortKey: 'date' },
  __depth__: { model: 'number', operators: NUMBER_OPS, sortKey: 'number' },
  __key__: { model: 'text', operators: TEXT_OPS, sortKey: 'text' },
};

export type Field =
  | { source: 'system'; id: SystemFieldId; model: EngineModel; sortKey: 'text' | 'number' | 'date' }
  | {
      source: 'column';
      id: string;
      column: QueryColumn;
      def: AnyColumnTypeDef;
      settings: Record<string, unknown>;
      model: EngineModel;
      sortKey: 'text' | 'number' | 'date' | 'none';
      /** A mirror filtered as its source: that type's operators instead of the column type's. */
      operators?: FilterOperator[];
      /** A mirror filtered as its source: its values are read from the mirror's value (see evaluate.ts). */
      mirrored?: true;
    };

export type PlanRule = {
  kind: 'rule';
  field: Field;
  operator: FilterOperator;
  negate: boolean;
  attribute?: 'start' | 'end';
  /** id-like models (label, labels, people, links, ids): wanted ids as strings. */
  ids: string[];
  /** A `null` / `none` value: "empty" is one of the wanted values (any_of / not_any_of). */
  wantsEmpty: boolean;
  /** text model: lowercased, trimmed values. */
  texts: string[];
  numbers: number[];
  /** date model: one span per value (`between` = one span from the first to the second value). */
  spans: PlanSpan[];
  /** date OVERDUE: also requires the deadline's status column to be "not done". */
  overdue?: { statusField: Field & { source: 'column' }; doneIds: string[] } | null;
  /** Read on the item's subitems: it matches when one of them does (D14). */
  sub?: boolean;
  /** A mirror rule that needs every linked item to match (`FilterRule.match`). */
  matchAll?: boolean;
};
/** A date span; `overdue` spans also require the deadline's status to be not done (OVERDUE, 13 §2). */
export type PlanSpan = DateSpan & { overdue?: boolean };
export type PlanGroup = {
  kind: 'group';
  operator: 'and' | 'or';
  negate: boolean;
  nodes: PlanNode[];
  /** A group whose rules all read subitems fails (instead of passing) on an item without subitems. */
  strict?: boolean;
};
export type PlanNode = PlanRule | PlanGroup;

export type Plan = {
  /** null = no filtering (no rules, or only incomplete ones). */
  filter: PlanNode | null;
  search: string | null;
  /** Columns the free-text search reads (stored values + the name). */
  searchFields: Field[];
  /**
   * The search also finds an item through its subitems at every depth (their names and stored values) — always
   * when the board has subitems (`env.subitems` given), and with match_children.
   */
  searchSubitems: boolean;
  /** With `searchSubitems`: the sub-board columns the search also reads on the subitems. */
  subSearchFields: Field[];
  sort: { field: Field; direction: 'asc' | 'desc'; nulls: 'first' | 'last' }[];
  scope: Query['scope'];
  matchChildren: boolean;
  /** `subitems_strict`: see `querySchema`. */
  subitemsStrict: boolean;
};

const withDefaults = (def: AnyColumnTypeDef, settings: Record<string, unknown>) => ({
  ...(def.defaultSettings as Record<string, unknown>),
  ...settings,
});

/**
 * A field of the board. `purpose: 'filter'`: a mirror with a known source resolves as that source
 * type filters (`mirrorFilterOf`) — only for filter rules; grouping, sorting, charts and views keep reading it as
 * its own type.
 */
export const resolveField = (id: string, env: QueryEnv, purpose: 'filter' | 'any' = 'any'): Field => {
  if (isSubField(id)) {
    const field = resolveField(id.slice(SUB_PREFIX.length), { ...env, columns: env.subitems ?? [] }, purpose);
    if (field.source === 'system') throw new AppError('unknown_column', `Unknown column "${id}"`, { column_id: id });
    return field; // its id is the sub-board key: that is how the subitems' cells are keyed
  }
  if (id in SYSTEM_FIELDS) {
    const f = SYSTEM_FIELDS[id as SystemFieldId];
    return { source: 'system', id: id as SystemFieldId, model: f.model, sortKey: f.sortKey };
  }
  const column = env.columns.find((c) => c.id === id);
  const def = column && columnTypes.get(column.type);
  if (!column || !def) throw new AppError('unknown_column', `Unknown column "${id}"`, { column_id: id });
  const settings = withDefaults(def, column.settings);
  const mirror = purpose === 'filter' && def.engine === 'mirror' ? mirrorFilterOf(column.mirror_source) : null;
  if (mirror)
    return {
      source: 'column',
      id,
      column,
      def,
      // A mirrored label column's labels: what the filter offers and what label texts resolve to.
      settings: mirror.labels ? { ...settings, labels: mirror.labels } : settings,
      model: mirror.model,
      sortKey: def.sortKey,
      operators: mirror.operators,
      mirrored: true,
    };
  return { source: 'column', id, column, def, settings, model: def.filterModel, sortKey: def.sortKey };
};

/**
 * The operators a field supports — THE single list: the web's filter builder and quick filters offer only these,
 * and `planQuery` accepts only these.
 */
const operatorsOf = (f: Field): FilterOperator[] =>
  f.source === 'system' ? SYSTEM_FIELDS[f.id].operators : (f.operators ?? f.def.filterOperators);

/** Whether `op` applies to the field (see `operatorsOf`). */
export const supportsOperator = (f: Field, op: FilterOperator): boolean => operatorsOf(f).includes(op);

/**
 * Why a rule cannot run on this board, or null when it can: its column is gone / unknown, or the column's type does
 * not have the operator (a view saved before a type change, or imported with an operator the type lacks).
 * `pruneQuery` drops such rules; the filter builder shows them as invalid with a remove button.
 */
export const ruleProblem = (r: FilterRule, env: QueryEnv): 'unknown_column' | 'invalid_operator' | null => {
  let field: Field;
  try {
    field = resolveField(r.column_id, env, 'filter');
  } catch {
    return 'unknown_column';
  }
  return supportsOperator(field, r.operator) ? null : 'invalid_operator';
};

type Label = { id: number; label: string; is_done?: boolean };
const labelsOf = (f: Field): Label[] =>
  f.source === 'column' && Array.isArray(f.settings.labels) ? (f.settings.labels as Label[]) : [];

const norm = (s: unknown) => String(s).trim().toLowerCase();

/** Status/dropdown values: label texts (stable when labels are reordered) or numeric ids (13 §2). */
const labelIds = (f: Field, values: unknown[]) => {
  const labels = labelsOf(f);
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v === 'number') out.add(String(v));
    else if (typeof v === 'string') {
      const byText = labels.filter((l) => norm(l.label) === norm(v));
      if (byText.length) byText.forEach((l) => out.add(String(l.id)));
      else if (/^\d+$/.test(v)) out.add(v);
    }
  }
  return [...out];
};

/** People values: `me`, `user:<id>`, `team:<id>` (13 §2). A user also matches items assigned to their teams. */
const peopleIds = (values: unknown[], env: QueryEnv) => {
  const out = new Set<string>();
  const teams = env.teams ?? [];
  const addUser = (id: string) => {
    out.add(id);
    for (const t of teams) if (t.member_ids.includes(id)) out.add(t.id);
  };
  for (const v of values) {
    if (typeof v !== 'string') continue;
    if (v === 'me') {
      if (env.meId) addUser(env.meId);
    } else if (v.startsWith('user:')) addUser(v.slice(5));
    else if (v.startsWith('team:')) {
      const id = v.slice(5);
      out.add(id);
      teams.find((t) => t.id === id)?.member_ids.forEach((m) => out.add(m));
    } else if (v !== 'none') addUser(v);
  }
  return [...out];
};

const isEmptyValue = (v: unknown) => v === null || v === 'none' || v === '__empty__';

/** Operators that need no values; every other operator with no usable value is an incomplete rule (ignored). */
const NO_VALUE_OPS = new Set<FilterOperator>([
  'is_empty',
  'is_not_empty',
  'is_done',
  'is_not_done',
  'has_unmatched_link',
  'no_unmatched_link',
  'is_running',
  'is_not_running',
]);

const planRule = (r: FilterRule, env: QueryEnv): PlanRule | null => {
  if (r.disabled) return null; // D28: a rule switched off by a column type change is ignored
  const field = resolveField(r.column_id, env, 'filter');
  if (!operatorsOf(field).includes(r.operator))
    throw new AppError('invalid_operator', `Operator "${r.operator}" does not apply to "${r.column_id}"`, {
      column_id: r.column_id,
      operator: r.operator,
    });
  const rule: PlanRule = {
    kind: 'rule',
    field,
    operator: r.operator,
    negate: r.negate,
    ...(isSubField(r.column_id) ? { sub: true } : {}),
    ...(r.match === 'all' && mirrorMatchApplies(field, r.operator) ? { matchAll: true } : {}),
    ...(r.attribute === 'start' || r.attribute === 'end' ? { attribute: r.attribute } : {}),
    ids: [],
    wantsEmpty: r.values.some(isEmptyValue),
    texts: [],
    numbers: [],
    spans: [],
  };
  const values = r.values.filter((v) => !isEmptyValue(v));
  const m = field.model;

  if (r.operator === 'is_done' || r.operator === 'is_not_done') {
    rule.ids = labelsOf(field)
      .filter((l) => l.is_done)
      .map((l) => String(l.id));
    return rule;
  }
  if (r.operator === 'has_unmatched_link' || r.operator === 'no_unmatched_link') {
    rule.ids = isSubField(r.column_id) ? [] : (env.relationUnmatched?.[r.column_id] ?? []);
    return rule;
  }
  if (NO_VALUE_OPS.has(r.operator)) return rule;

  const textOp = ['contains_text', 'not_contains_text', 'starts_with', 'ends_with'].includes(r.operator);
  if (m === 'text' && comparesNumbers(m, r.operator)) {
    rule.numbers = values.map(Number).filter(Number.isFinite);
  } else if (textOp || m === 'text' || m === 'files') {
    rule.texts = values.map(norm).filter((s) => s !== '');
  } else if (m === 'label' || m === 'labels') {
    rule.ids = labelIds(field, values);
    // Unknown label texts must still match nothing (not be dropped as "incomplete").
    if (!rule.ids.length && values.length) rule.ids = ['__none__'];
  } else if (m === 'people') {
    rule.ids = peopleIds(values, env);
    if (!rule.ids.length && values.length) rule.ids = ['__none__'];
  } else if (m === 'links' || m === 'ids' || m === 'tags') {
    rule.ids = values.map(String);
  } else if (m === 'number') {
    rule.numbers = values.map(Number).filter(Number.isFinite);
  } else if (m === 'date') {
    if (r.operator === 'within_the_last' || r.operator === 'within_the_next') {
      const span = relativeSpan(values, r.operator === 'within_the_last' ? 'last' : 'next', env);
      rule.spans = span ? [span] : [];
    } else if (r.operator === 'between') {
      const a = resolveDateValue(values[0], env);
      const b = resolveDateValue(values[1], env);
      rule.spans = a && b ? [{ from: a.from, to: b.to }] : [];
    } else {
      rule.spans = values.flatMap((v) => {
        const span = resolveDateValue(v, env);
        return span ? [v === 'OVERDUE' ? { ...span, overdue: true } : span] : [];
      });
      if (values.includes('OVERDUE')) rule.overdue = overdueCheck(field, env);
    }
  } else if (m === 'checkbox') {
    return rule;
  }

  const wanted = rule.ids.length + rule.texts.length + rule.numbers.length + rule.spans.length;
  if (!wanted && !(rule.wantsEmpty && (r.operator === 'any_of' || r.operator === 'not_any_of'))) return null;
  if (r.operator === 'between' && m === 'number' && rule.numbers.length < 2) return null;
  return rule;
};

/** OVERDUE (13 §2): past and not done, per the date column's deadline settings (03 §2.7). */
const overdueCheck = (field: Field, env: QueryEnv): PlanRule['overdue'] => {
  if (field.source !== 'column') return null;
  const statusKey = (field.settings.deadline as { status_column_id?: string } | undefined)?.status_column_id;
  if (!statusKey) return null;
  let status: Field;
  try {
    status = resolveField(statusKey, env);
  } catch {
    return null;
  }
  if (status.source !== 'column') return null;
  const doneIds = labelsOf(status)
    .filter((l) => l.is_done)
    .map((l) => String(l.id));
  return { statusField: status, doneIds };
};

const planGroup = (g: FilterGroup, env: QueryEnv): PlanNode | null => {
  const nodes = g.rules
    .map((r) => (isGroup(r) ? planGroup(r, env) : planRule(r, env)))
    .filter((n): n is PlanNode => n !== null);
  if (!nodes.length) return null;
  return { kind: 'group', operator: g.operator, negate: g.negate, nodes };
};

/** Validates limits (depth 5, 50 rules) and resolves the query; throws AppError 422 on bad input. */
export const planQuery = (q: Query, env: QueryEnv): Plan => {
  if (q.filter) {
    if (filterDepth(q.filter) > MAX_FILTER_DEPTH)
      throw new AppError('query_too_complex', `Filter nesting is limited to ${MAX_FILTER_DEPTH} levels`);
    if (flattenRules(q.filter).length > MAX_FILTER_RULES)
      throw new AppError('query_too_complex', `A filter has at most ${MAX_FILTER_RULES} rules`);
  }
  let filter = q.filter ? planGroup(q.filter, env) : null;

  const subColumns = q.match_children ? (env.subitems ?? []) : [];
  if (q.person) {
    const isPeople = (c: QueryColumn) => columnTypes.get(c.type)?.filterModel === 'people';
    // With match_children an item is also "theirs" when one of its subitems is.
    const ids = [
      ...env.columns.filter(isPeople).map((c) => c.id),
      ...subColumns.filter(isPeople).map((c) => `${SUB_PREFIX}${c.id}`),
    ];
    const personRules = ids
      .map((id) =>
        planRule({ kind: 'rule', column_id: id, operator: 'any_of', values: [q.person], negate: false }, env),
      )
      .filter((n): n is PlanRule => n !== null);
    // No people column: the Person filter matches nothing (an OR of no rules).
    const person: PlanNode = { kind: 'group', operator: 'or', negate: false, nodes: personRules, strict: true };
    filter = filter ? { kind: 'group', operator: 'and', negate: false, nodes: [filter, person] } : person;
  }

  const search = q.search?.trim().toLowerCase() || null;
  const stored = (c: QueryColumn) => {
    const def = columnTypes.get(c.type);
    return !!def && def.storage !== 'computed';
  };
  const searchFields = search ? env.columns.filter(stored).map((c) => resolveField(c.id, env)) : [];
  // The board search finds subitems too (owner fix): every board with a sub-board, not only with match_children.
  const searchSubitems = !!search && (q.match_children || env.subitems !== undefined);
  const subSearchFields = searchSubitems
    ? (env.subitems ?? []).filter(stored).map((c) => resolveField(`${SUB_PREFIX}${c.id}`, env))
    : [];

  const sort = q.sort
    .map((s) => ({ field: resolveField(s.column_id, env), direction: s.direction, nulls: s.nulls }))
    .filter((s) => s.field.sortKey !== 'none');

  return {
    filter,
    search,
    searchFields,
    searchSubitems,
    subSearchFields,
    sort,
    scope: q.scope,
    matchChildren: q.match_children,
    subitemsStrict: q.subitems_strict ?? false,
  };
};

/**
 * Whether a plan reads subitems — a `sub:` rule (also Person with match_children), or a search that reads them
 * (`searchSubitems`): then the rows need their `subitems` attached. match_children alone filters nothing.
 */
export const planUsesSubitems = (plan: Plan): boolean => {
  const walk = (n: PlanNode | null): boolean => !!n && (n.kind === 'group' ? n.nodes.some(walk) : !!n.sub);
  return walk(plan.filter) || plan.searchSubitems;
};

/**
 * Whether a plan must run in memory: it reads values computed on read (formula, mirror, meta, the custom key)
 * or follows the item tree (match_children). Everything else compiles to SQL.
 */
export const planNeedsMemory = (plan: Plan): boolean => {
  const computed = (f: Field) => (f.source === 'column' ? f.def.storage === 'computed' : f.id === '__key__');
  const walk = (n: PlanNode | null): boolean =>
    !!n &&
    (n.kind === 'group' ? n.nodes.some(walk) : computed(n.field) || (!!n.overdue && computed(n.overdue.statusField)));
  return plan.matchChildren || planUsesSubitems(plan) || walk(plan.filter) || plan.sort.some((s) => computed(s.field));
};

/**
 * Drops rules (and sort/group levels) that no longer apply — their column was deleted or hidden, or its type
 * no longer has the operator — so a saved view keeps working instead of failing as a whole.
 */
export const pruneQuery = (q: Query, env: QueryEnv): Query => {
  const valid = (id: string) => {
    try {
      resolveField(id, env);
      return true;
    } catch {
      return false;
    }
  };
  const pruneGroup = (g: FilterGroup): FilterGroup => ({
    ...g,
    rules: g.rules
      .map((r) => (isGroup(r) ? pruneGroup(r) : r))
      .filter((r) => (isGroup(r) ? r.rules.length > 0 : ruleProblem(r, env) === null)),
  });
  return {
    ...q,
    filter: q.filter ? pruneGroup(q.filter) : undefined,
    sort: q.sort.filter((s) => valid(s.column_id)),
    group_by: q.group_by && valid(q.group_by.column_id) ? q.group_by : undefined,
    subgroups: q.subgroups?.filter((g) => valid(g.column_id)),
  };
};

export { operatorsOf };
