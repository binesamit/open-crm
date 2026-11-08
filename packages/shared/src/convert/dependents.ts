// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes } from '../columns';
import { formulaRefs, parseFormula } from '../formula';
import { type FilterGroup, type FilterRule, isGroup } from '../query/filter';
import { resolveField, type QueryEnv } from '../query/plan';
import { summaryOptions, type SummaryFn } from '../query/summary';
import { validateRecipe, type RecipeBoard } from '../automations/validate';
import { validateConditions } from '../automations/conditions';
import type { Recipe } from '../automations/schema';
import { columnFitsRole, type ColumnRole } from '../widgets/common';

/**
 * What else depends on a column whose type changes (D28, plan §6) — the pure part: which saved filter rules keep
 * working, which become disabled (kept, marked, ignored), which summaries reset, whether a formula, an automation
 * recipe or a dashboard widget still fits. The API scans the account, applies these and keeps the before-state
 * so an undo puts it all back.
 */
export type ConvertedColumn = {
  /** The column's key (as rules, recipes and settings name it). */
  key: string;
  title: string;
  from: { type: string; settings: Record<string, unknown> };
  to: { type: string; settings: Record<string, unknown> };
};

/** The mark a disabled rule carries (an undo of this conversion takes exactly these marks off). */
export const conversionMark = (conversionId: string) => `column_type_changed:${conversionId}`;

type Label = { id: number; label: string };
const NO_VALUE_OPS = new Set([
  'is_empty',
  'is_not_empty',
  'is_done',
  'is_not_done',
  'has_unmatched_link',
  'no_unmatched_link',
  'is_running',
  'is_not_running',
]);
const LABEL_MODELS = new Set(['label', 'labels']);

export type RuleChange = 'kept' | 'mapped' | 'disabled';

/**
 * One saved rule on the converted column (`id` = the key, or `sub:<key>` on the parent board's views): kept as it
 * is, its values mapped (label ids → names when labels became text, numbers → text), or disabled.
 */
export const adaptRule = (
  rule: FilterRule,
  id: string,
  c: ConvertedColumn,
  mark: string,
): { rule: FilterRule; change: RuleChange } => {
  if (rule.column_id !== id || rule.disabled) return { rule, change: 'kept' };
  const fromDef = columnTypes.get(c.from.type);
  const toDef = columnTypes.get(c.to.type);
  if (!fromDef || !toDef) return { rule: { ...rule, disabled: mark }, change: 'disabled' };
  if (!toDef.filterOperators.includes(rule.operator)) return { rule: { ...rule, disabled: mark }, change: 'disabled' };
  if (NO_VALUE_OPS.has(rule.operator)) return { rule, change: 'kept' };
  const from = fromDef.filterModel;
  const to = toDef.filterModel;
  if (from === to) return { rule, change: 'kept' };
  // status ↔ dropdown keep their label ids; label names in rules match a label column by name.
  if (LABEL_MODELS.has(from) && LABEL_MODELS.has(to)) return { rule, change: 'kept' };
  if (from === 'text' && LABEL_MODELS.has(to)) return { rule, change: 'kept' };
  if (LABEL_MODELS.has(from) && to === 'text') {
    const labels = (c.from.settings.labels as Label[] | undefined) ?? [];
    const values = rule.values.map((v) =>
      typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))
        ? (labels.find((l) => l.id === Number(v))?.label ?? String(v))
        : v,
    );
    return { rule: { ...rule, values }, change: 'mapped' };
  }
  if (from === 'number' && to === 'text')
    return {
      rule: { ...rule, values: rule.values.map((v) => (typeof v === 'number' ? String(v) : v)) },
      change: 'mapped',
    };
  return { rule: { ...rule, disabled: mark }, change: 'disabled' };
};

export const adaptFilter = (g: FilterGroup, id: string, c: ConvertedColumn, mark: string) => {
  const changes: RuleChange[] = [];
  const walk = (group: FilterGroup): FilterGroup => ({
    ...group,
    rules: group.rules.map((r) => {
      if (isGroup(r)) return walk(r);
      const out = adaptRule(r, id, c, mark);
      if (r.column_id === id) changes.push(out.change);
      return out.rule;
    }),
  });
  return { filter: walk(g), changes };
};

/** Takes this conversion's marks off (an undo when the view changed since): the rules work again. */
export const clearRuleMarks = (g: FilterGroup, mark: string): FilterGroup => ({
  ...g,
  rules: g.rules.map((r) => {
    if (isGroup(r)) return clearRuleMarks(r, mark);
    if (r.disabled !== mark) return r;
    const { disabled: _drop, ...rest } = r;
    return rest as FilterRule;
  }),
});

export type ViewImpact = {
  settings: Record<string, unknown>;
  rules: { kept: number; mapped: number; disabled: number };
  /** Footer / group summaries of the column that the new type does not offer (reset to the type's default). */
  summaries_reset: number;
  /** Other places in the view's settings that name the column (kanban lanes, calendar date, map…): review them. */
  references: string[];
  /** The view sorts / groups by the column: it keeps doing so, by the new type. */
  sorted: boolean;
  grouped: boolean;
};

const SKIP_PATHS = new Set([
  'query',
  'coloring',
  'summaries',
  'group_summary',
  'hidden_columns',
  'subitems_hidden_columns',
  'column_order',
  'column_widths',
]);

const refsIn = (v: unknown, key: string, path: string, out: string[]) => {
  if (typeof v === 'string') {
    if (v === key) out.push(path);
  } else if (Array.isArray(v)) v.forEach((x, i) => refsIn(x, key, `${path}.${i}`, out));
  else if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) refsIn(x, key, path ? `${path}.${k}` : k, out);
};

// The envs below only resolve fields and validate rules (no date is evaluated), so today / weekend / calendar are
// placeholders: the account's weekend and holidays cannot change the result.
const summaryAllowed = (c: ConvertedColumn, fn: string) => {
  try {
    const field = resolveField(c.key, {
      columns: [{ id: c.key, type: c.to.type, settings: c.to.settings }],
      meId: null,
      today: '2000-01-01',
      timezone: 'UTC',
      weekend: 'fri_sat',
      firstDay: 0,
    });
    return summaryOptions(field).includes(fn as SummaryFn);
  } catch {
    return false;
  }
};

/**
 * A saved view's settings after the conversion. `id` = how the view names the column (`sub:<key>` on the parent
 * board of a sub-board). Filter and colouring rules are adapted, summaries the new type lacks are dropped, the rest
 * is reported.
 */
export const adaptViewSettings = (
  raw: Record<string, unknown>,
  id: string,
  c: ConvertedColumn,
  mark: string,
): ViewImpact => {
  const settings = structuredClone(raw ?? {}) as Record<string, unknown>;
  const impact: ViewImpact = {
    settings,
    rules: { kept: 0, mapped: 0, disabled: 0 },
    summaries_reset: 0,
    references: [],
    sorted: false,
    grouped: false,
  };
  const count = (changes: RuleChange[]) => changes.forEach((ch) => impact.rules[ch]++);
  const query = settings.query as
    { filter?: FilterGroup; sort?: { column_id: string }[]; group_by?: { column_id: string } } | undefined;
  if (query?.filter) {
    const out = adaptFilter(query.filter, id, c, mark);
    query.filter = out.filter;
    count(out.changes);
  }
  impact.sorted = !!query?.sort?.some((s) => s.column_id === id);
  impact.grouped = query?.group_by?.column_id === id;
  if (Array.isArray(settings.coloring))
    settings.coloring = (settings.coloring as { rule: FilterRule }[]).map((r) => {
      if (r.rule?.column_id !== id) return r;
      const out = adaptRule(r.rule, id, c, mark);
      count([out.change]);
      return { ...r, rule: out.rule };
    });
  const summaries = settings.summaries as Record<string, string> | undefined;
  if (summaries && id in summaries && !summaryAllowed(c, summaries[id]!)) {
    delete summaries[id];
    impact.summaries_reset++;
  }
  const gs = settings.group_summary as { column_id?: string; fn?: string } | null | undefined;
  if (gs?.column_id === id && gs.fn && !summaryAllowed(c, gs.fn)) {
    delete gs.fn;
    impact.summaries_reset++;
  }
  for (const [k, v] of Object.entries(settings)) if (!SKIP_PATHS.has(k)) refsIn(v, id, k, impact.references);
  return impact;
};

/** Does the view's settings change at all (anything to write and to undo)? */
export const viewChanged = (i: ViewImpact) => i.rules.mapped + i.rules.disabled + i.summaries_reset > 0;

// ---- formulas ----

/** What a formula reads from a column of this type (03 §2.18): a number, a date, a range, a yes/no or text. */
export const formulaKindOf = (type: string): 'number' | 'date' | 'range' | 'boolean' | 'text' => {
  if (type === 'numbers' || type === 'rating') return 'number';
  if (type === 'date') return 'date';
  if (type === 'timeline') return 'range';
  if (type === 'checkbox') return 'boolean';
  return 'text';
};

/** The formula reads the column (`{key}`)? */
export const formulaReads = (src: string, key: string) => {
  try {
    return formulaRefs(parseFormula(src)).has(key);
  } catch {
    return src.includes(`{${key}}`);
  }
};

// ---- automations ----

/** Does the recipe name the column anywhere (trigger, conditions, actions, `{item.key}` templates)? */
export const recipeNames = (recipe: unknown, key: string) => {
  const json = JSON.stringify(recipe ?? {});
  return json.includes(`"${key}"`) || json.includes(`.${key}}`) || json.includes(`"sub:${key}"`);
};

/**
 * Whether an automation still fits the board after the conversion (`validateRecipe` + its conditions): the
 * problems it has only now — a trigger for status changes on a column that became text, a condition operator the
 * new type has no more… — mean it must be switched off (plan §6, product decision 6).
 */
export const recipeBreaks = (recipe: Recipe, before: RecipeBoard, after: RecipeBoard): string[] => {
  const was = new Set(validateRecipe(recipe, before).errors.map((e) => `${e.path}:${e.code}`));
  const now = validateRecipe(recipe, after).errors.filter((e) => !was.has(`${e.path}:${e.code}`));
  const out = now.map((e) => `${e.path}:${e.code}`);
  const env = (b: RecipeBoard): QueryEnv => ({
    columns: b.columns.map((c) => ({ id: c.key, type: c.type, settings: c.settings })),
    meId: null,
    today: '2000-01-01',
    timezone: 'UTC',
    weekend: 'fri_sat',
    firstDay: 0,
  });
  let conditionsBefore = true;
  try {
    validateConditions(recipe.conditions, env(before));
  } catch {
    conditionsBefore = false;
  }
  if (conditionsBefore)
    try {
      validateConditions(recipe.conditions, env(after));
    } catch (e) {
      out.push(`conditions:${(e as { code?: string }).code ?? 'invalid'}`);
    }
  return out;
};

// ---- dashboard widgets ----

const ROLES: ColumnRole[] = ['labels', 'number', 'date', 'people', 'any'];
/** The new type can stand in every role the old one could (a widget that used the column keeps working). */
export const sameWidgetRoles = (from: string, to: string) =>
  ROLES.every((r) => !columnFitsRole(from, r) || columnFitsRole(to, r));

type Ref = { type: string; title: string; keys?: Record<string, string> };
const isRef = (v: unknown): v is Ref =>
  !!v && typeof v === 'object' && typeof (v as Ref).type === 'string' && typeof (v as Ref).title === 'string';
const norm = (s: string) => s.trim().toLocaleLowerCase();

/**
 * A widget's settings after the conversion: column references (type + title, or this board's key) that meant this
 * column keep it when the new type fits the same roles (`updated`: this board's key is pinned, since type + title no
 * longer match); else they stop finding it — the widget asks to choose again (`needs_choice`).
 */
export const adaptWidgetSettings = (raw: Record<string, unknown>, boardId: string, c: ConvertedColumn) => {
  const settings = structuredClone(raw ?? {}) as Record<string, unknown>;
  let updated = 0;
  let needsChoice = 0;
  const fits = sameWidgetRoles(c.from.type, c.to.type);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    if (isRef(v)) {
      const manual = v.keys?.[boardId] === c.key;
      const mine = manual || (!v.keys?.[boardId] && v.type === c.from.type && norm(v.title) === norm(c.title));
      if (!mine) return v;
      if (!fits) {
        // The column no longer fits: the reference stops finding it here, and the widget asks to choose again.
        needsChoice++;
        if (!manual) return v;
        const keys = { ...v.keys };
        delete keys[boardId];
        return { ...v, keys };
      }
      if (manual) return v;
      // Other boards of the widget still match by type + title; this board names its column by key.
      updated++;
      return { ...v, keys: { ...v.keys, [boardId]: c.key } };
    }
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
  };
  const out = walk(settings) as Record<string, unknown>;
  return { settings: out, updated, needsChoice };
};
