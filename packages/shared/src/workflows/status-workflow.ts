// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { FilterOperator } from '../columns/types';
import { getLocale, t, type Locale, type MessageKey } from '../i18n';
import { filterGroupSchema, flattenRules, type FilterGroup } from '../query/filter';

/**
 * a workflow over a status column: which label may follow which, and what a move needs. It is an
 * optional layer kept in the column's settings (`workflow`); off or missing, the column behaves as before. The server
 * enforces it where every cell write passes (`writeCell`); the picker reads the same rules to grey out moves.
 */
export const WORKFLOW_MAX_TRANSITIONS = 400;

/**
 * phase 2 — a popup that asks for values before an action (a workflow move, a button click): columns of the
 * board (each optional or required) and a free note, saved on the item as an update. Values and the action are one
 * write: cancel the popup and nothing happens.
 */
export const POPUP_MAX_FIELDS = 20;
/** the most subitems one rule may ask for, and one popup may add or fill in at once. */
export const SUBITEMS_MAX = 50;
const popupFieldsSchema = z
  .array(z.object({ column_id: z.string().min(1).max(64), required: z.boolean().optional() }))
  .max(POPUP_MAX_FIELDS)
  .default([]);
export const popupSchema = z.object({
  title: z.string().trim().max(120).optional(),
  fields: popupFieldsSchema,
  note: z.enum(['off', 'optional', 'required']).optional(),
  /**
   * the item's subitems in the popup — the ones it has (to fill in) and new ones to add, each with these
   * columns of the sub-board ('name' = the subitem's name). `min` / `all` count like a move's subitems rule.
   */
  subitems: z
    .object({
      fields: popupFieldsSchema,
      min: z.number().int().min(0).max(SUBITEMS_MAX).optional(),
      all: z.boolean().optional(),
      /** P1-03: hide the subitems' name when the sub-board builds it from its columns (it is not typed here). */
      hide_name: z.boolean().optional(),
    })
    .optional(),
});
export type ItemPopup = z.infer<typeof popupSchema>;
export const POPUP_NOTE_MAX = 5000;

/**
 * a popup's subitems as written with its action, in the same request: new subitems of the item, and values
 * filled in on ones it has (its own subitems only). Cells are keyed by sub-board column id.
 */
export const popupSubitemsWriteSchema = z.object({
  create: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(255).optional(),
        cells: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .max(SUBITEMS_MAX)
    .optional(),
  update: z
    .array(z.object({ id: z.string().min(1).max(64), cells: z.record(z.string(), z.unknown()) }))
    .max(SUBITEMS_MAX)
    .optional(),
});
export type PopupSubitemsWrite = z.infer<typeof popupSubitemsWriteSchema>;

/** The popup's required columns. */
export const popupRequired = (p: ItemPopup | undefined) =>
  (p?.fields ?? []).filter((f) => f.required).map((f) => f.column_id);

/**
 * what an item's own subitems (one level down) need: at least `min` of them with a value in every
 * `required` sub-board column; with `all`, none may miss one. `conditions` (the sub-board's filter tree) narrows
 * which subitems count at all (e.g. not the cancelled ones).
 */
export const subitemsRuleSchema = z.object({
  min: z.number().int().min(0).max(SUBITEMS_MAX).default(1),
  required: z.array(z.string().max(100)).max(POPUP_MAX_FIELDS).default([]),
  all: z.boolean().optional(),
  conditions: filterGroupSchema.optional(),
  /** round 2: every subitem that counts must also meet these (e.g. its status is "approved"). */
  each: filterGroupSchema.optional(),
});
export type SubitemsRule = z.infer<typeof subitemsRuleSchema>;

/**
 * How the counted subitems stand: with every required value, and missing one; `failing` = counted ones that do not
 * meet the rule's `each` conditions (they are not complete either).
 */
export type SubitemsTally = { complete: number; incomplete: number; failing?: number };

export const subitemsPass = (rule: SubitemsRule, tally: SubitemsTally) =>
  tally.complete >= rule.min && (!rule.all || tally.incomplete === 0) && !tally.failing;

/** A popup's own subitems rule (its subitem fields marked required, its `min` / `all`); null = it asks nothing. */
export const popupSubitemsRule = (p: ItemPopup | undefined | null): SubitemsRule | null => {
  const s = p?.subitems;
  if (!s) return null;
  const required = s.fields.filter((f) => f.required).map((f) => f.column_id);
  const min = s.min ?? 0;
  return min > 0 || (s.all && required.length) ? { min, required, all: s.all } : null;
};

/** One rule from a move's own and its popup's (the stricter of each). */
const mergeSubitemsRules = (a: SubitemsRule | null | undefined, b: SubitemsRule | null): SubitemsRule | null => {
  if (!a) return b;
  if (!b) return a;
  return {
    min: Math.max(a.min, b.min),
    required: [...new Set([...a.required, ...b.required])],
    all: a.all || b.all,
    conditions: a.conditions,
    each: a.each,
  };
};

export const workflowTransitionSchema = z.object({
  /** The label the item leaves; null = any label (and an empty cell). */
  from: z.number().int().min(0).nullable(),
  to: z.number().int().min(0),
  /** Column keys that must have a value for the move. */
  required: z.array(z.string().max(100)).max(30).optional(),
  /** Only these people / teams may make the move (empty = everyone who may edit the cell). */
  who: z
    .object({ users: z.array(z.string()).max(100).default([]), teams: z.array(z.string()).max(100).default([]) })
    .optional(),
  /**
   * "Conditions for the move" (was "only if") on the item's values, the automations' filter tree. A blocked move
   * names each one that is not met, with the item's value now.
   */
  conditions: filterGroupSchema.optional(),
  /** round 2: the board's own words when the move is blocked, shown above what is missing. */
  message: z.string().trim().max(300).optional(),
  /** Phase 2: a popup the move opens in the app; its required fields and note count as the move's own. */
  popup: popupSchema.optional(),
  /** what the item's subitems need for the move (checked on the server, filled in from the popup). */
  subitems: subitemsRuleSchema.optional(),
});
export type WorkflowTransition = z.infer<typeof workflowTransitionSchema>;

/** The move's subitems rule: its own with its popup's; null = the move does not look at subitems. */
export const transitionSubitemsRule = (t: Pick<WorkflowTransition, 'subitems' | 'popup'>) =>
  mergeSubitemsRules(t.subitems, popupSubitemsRule(t.popup));

export const statusWorkflowSchema = z.object({
  enabled: z.boolean(),
  transitions: z.array(workflowTransitionSchema).max(WORKFLOW_MAX_TRANSITIONS),
  /** An empty cell (a new item) may take any label. */
  free_start: z.boolean().optional(),
  /** The cell may be cleared from any label. */
  allow_clear: z.boolean().optional(),
  /** Board owners and admins may make a blocked move on purpose (it is logged). */
  allow_override: z.boolean().optional(),
  /** Automations that change the label follow the workflow ('obey', the default) or pass it ('bypass'). */
  automations: z.enum(['obey', 'bypass']).optional(),
});
export type StatusWorkflow = z.infer<typeof statusWorkflowSchema>;

export const DEFAULT_STATUS_WORKFLOW: StatusWorkflow = {
  enabled: true,
  transitions: [],
  free_start: true,
  allow_clear: true,
  allow_override: true,
  automations: 'obey',
};

/** Why a move is blocked; `required` names the empty column keys. `message` = the move's own words, if it has any. */
export type WorkflowBlock = (
  | { reason: 'not_allowed' }
  | { reason: 'who' }
  | { reason: 'required'; columns: string[] }
  /**
   * `have` = the subitems that count and have every `columns` value; `min` is the rule's. `failing` = counted ones
   * that do not meet the rule's `each` conditions.
   */
  | {
      reason: 'subitems';
      min: number;
      have: number;
      incomplete: number;
      all: boolean;
      columns: string[];
      failing: number;
    }
  | { reason: 'note' }
  | { reason: 'conditions' }
) & { message?: string };

/**
 * round 2 — one condition of a move that the item does not meet, as the server reports it (409 details
 * `failed`): the column, the operator, the values asked for in words (labels by name) and the item's value now.
 * A nested group is one entry: `operator` 'group' and its whole text in `title`.
 */
export type ConditionFailure = {
  column_id: string;
  title: string;
  operator: FilterOperator | 'group';
  negate?: boolean;
  values: string[];
  /** The item's value now in words (null = empty); left out when it cannot be told (a system field). */
  current?: string | null;
};

/** A failed condition in words: "Finance status must be: Paid in full (now: Deposit)". */
export const conditionFailureText = (f: ConditionFailure, locale: Locale = getLocale()): string => {
  if (f.operator === 'group') return f.title;
  const flip: Partial<Record<FilterOperator, FilterOperator>> = {
    any_of: 'not_any_of',
    not_any_of: 'any_of',
    is_empty: 'is_not_empty',
    is_not_empty: 'is_empty',
  };
  const op = f.negate ? (flip[f.operator] ?? f.operator) : f.operator;
  const values = f.values.join(t('auto.word.or', undefined, locale));
  const vars = { column: f.title, values, op: t(`filter.op.${op}` as MessageKey, undefined, locale) };
  const key: MessageKey =
    op === 'any_of' || op === 'not_any_of' || op === 'is_empty' || op === 'is_not_empty'
      ? `workflow.failed.${op}`
      : f.negate && !flip[f.operator]
        ? 'workflow.failed.not'
        : 'workflow.failed.other';
  const text = t(key, vars, locale).trim();
  if (f.current === undefined) return text;
  const now = f.current?.trim() ? f.current : t('workflow.failed.nowEmpty', undefined, locale);
  return `${text} ${t('workflow.failed.now', { value: now }, locale)}`;
};

export type WorkflowCheckCtx = {
  userId: string;
  teamIds: readonly string[];
  /** An automation's write: the `who` limits are not applied (it acts as its owner). */
  automation?: boolean;
  /** Whether the item has a value in this column key right now. */
  filled: (columnKey: string) => boolean;
  /** A note came with the write (a popup's note). */
  note?: boolean;
  /** how the item's subitems stand against a rule; left out (the picker), subitems are not checked. */
  subitems?: (rule: SubitemsRule) => SubitemsTally;
  /** Evaluates "only if"; left out (the picker), conditions are not checked here. */
  matches?: (conditions: FilterGroup) => boolean;
};

export const workflowOn = (wf: StatusWorkflow | undefined | null): wf is StatusWorkflow => !!wf?.enabled;

/** The labels the workflow names (in a move, from or to). An item on any other label is "outside the workflow". */
export const workflowStates = (wf: StatusWorkflow) => {
  const ids = new Set<number>();
  for (const t of wf.transitions) {
    if (t.from !== null) ids.add(t.from);
    ids.add(t.to);
  }
  return ids;
};

export const isOutsideWorkflow = (wf: StatusWorkflow, label: number | null) =>
  label !== null && workflowOn(wf) && !workflowStates(wf).has(label);

const whoAllows = (t: WorkflowTransition, ctx: WorkflowCheckCtx) => {
  const users = t.who?.users ?? [];
  const teams = t.who?.teams ?? [];
  if (ctx.automation || (!users.length && !teams.length)) return true;
  return users.includes(ctx.userId) || teams.some((id) => ctx.teamIds.includes(id));
};

/**
 * Checks one move. The moves that fit (from the label or from any) are tried in order; the first that passes wins,
 * otherwise the block of the closest one is returned (who → required → conditions), so the message is useful.
 */
export const checkTransition = (
  wf: StatusWorkflow,
  from: number | null,
  to: number | null,
  ctx: WorkflowCheckCtx,
): { ok: true } | { ok: false; block: WorkflowBlock; transition?: WorkflowTransition } => {
  if (!workflowOn(wf) || from === to) return { ok: true };
  if (to === null) return wf.allow_clear === false ? { ok: false, block: { reason: 'not_allowed' } } : { ok: true };
  if (from === null && wf.free_start !== false) return { ok: true };
  const fits = wf.transitions.filter((t) => t.to === to && (t.from === null || t.from === from));
  if (!fits.length) return { ok: false, block: { reason: 'not_allowed' } };
  let best: WorkflowBlock | null = null;
  let bestT: WorkflowTransition | undefined;
  const rank = { not_allowed: 0, who: 1, required: 2, subitems: 3, note: 4, conditions: 5 } as const;
  for (const t of fits) {
    let block: WorkflowBlock | null = null;
    const missing = [...new Set([...(t.required ?? []), ...popupRequired(t.popup)])].filter((k) => !ctx.filled(k));
    const rule = ctx.subitems ? transitionSubitemsRule(t) : null;
    const tally = rule ? ctx.subitems!(rule) : null;
    if (!whoAllows(t, ctx)) block = { reason: 'who' };
    else if (missing.length) block = { reason: 'required', columns: missing };
    else if (rule && tally && !subitemsPass(rule, tally))
      block = {
        reason: 'subitems',
        min: rule.min,
        have: tally.complete,
        incomplete: tally.incomplete,
        all: !!rule.all,
        columns: rule.required,
        failing: tally.failing ?? 0,
      };
    else if (t.popup?.note === 'required' && !ctx.note && !ctx.automation) block = { reason: 'note' };
    else if (t.conditions && flattenRules(t.conditions).length && ctx.matches && !ctx.matches(t.conditions))
      block = { reason: 'conditions' };
    if (!block) return { ok: true };
    if (t.message) block = { ...block, message: t.message };
    if (!best || rank[block.reason] > rank[best.reason]) {
      best = block;
      bestT = t;
    }
  }
  return { ok: false, block: best!, transition: bestT };
};

/** Whether a popup asks anything (a field or a note). */
export const popupAsks = (p: ItemPopup | undefined | null): p is ItemPopup =>
  !!p && (p.fields.length > 0 || (p.note ?? 'off') !== 'off' || !!p.subitems);

/**
 * The popup a move opens: its own, and — — when the move has a subitems rule, a subitems section that asks
 * at least the rule's columns (required), even if the move has no popup of its own.
 */
export const transitionPopup = (t: WorkflowTransition): ItemPopup | null => {
  const rule = t.subitems ? transitionSubitemsRule(t) : null;
  if (!rule) return popupAsks(t.popup) ? t.popup : null;
  const base: ItemPopup = t.popup ?? { fields: [], note: 'off' };
  const fields = [...(base.subitems?.fields ?? [])].map((f) =>
    rule.required.includes(f.column_id) ? { ...f, required: true } : f,
  );
  for (const k of rule.required)
    if (!fields.some((f) => f.column_id === k)) fields.push({ column_id: k, required: true });
  return { ...base, subitems: { fields, min: rule.min, ...(rule.all ? { all: true } : {}) } };
};

/** The popup a pick from `from` to `to` opens, if any; a move from this very label wins over one from any label. */
export const movePopup = (wf: StatusWorkflow | undefined, from: number | null, to: number): ItemPopup | null => {
  if (!workflowOn(wf)) return null;
  const t =
    wf.transitions.find((x) => x.to === to && x.from === from && transitionPopup(x)) ??
    wf.transitions.find((x) => x.to === to && x.from === null && transitionPopup(x));
  return t ? transitionPopup(t) : null;
};

/**
 * round 2 — the move a pick from `from` to `to` makes, the way the popup picks it (this very label first)
 * the app reads its conditions and required columns to show what is missing before the move is sent.
 */
export const moveTransition = (
  wf: StatusWorkflow | undefined,
  from: number | null,
  to: number,
): WorkflowTransition | null => {
  if (!workflowOn(wf)) return null;
  return (
    wf.transitions.find((x) => x.to === to && x.from === from) ??
    wf.transitions.find((x) => x.to === to && x.from === null) ??
    null
  );
};

/**
 * The labels a move from `from` may reach (the picker), or null = any (a free start). With `ctx`, moves limited to
 * other people are left out; without it they count (the server answers for them). Required fields and conditions are
 * not checked here.
 */
export const reachableLabels = (
  wf: StatusWorkflow,
  from: number | null,
  ctx?: Pick<WorkflowCheckCtx, 'userId' | 'teamIds'>,
): Set<number> | null => {
  if (!workflowOn(wf) || (from === null && wf.free_start !== false)) return null;
  const out = new Set<number>(from === null ? [] : [from]);
  for (const t of wf.transitions)
    if ((t.from === null || t.from === from) && (!ctx || whoAllows(t, { ...ctx, filled: () => true }))) out.add(t.to);
  return out;
};
