// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes } from '../columns';
import type { QueryColumn } from '../query/plan';
import type { Trigger, TriggerType } from './schema';

/**
 * 04 §2 — the trigger registry. `match` is cheap and pure: it reads the activity event (and the board's column
 * settings for label texts), never the database. Checks that need data (all subitems done, all connected items
 * done) are flagged `deep` and finished by the runner on a fresh snapshot.
 */

/**
 * does a fire's payload carry the automation's trigger input values? Each stored value that is not
 * empty must equal the payload's value under the same key (as text). No values stored: every fire matches.
 */
export const extensionTriggerInputsMatch = (inputs: Record<string, string> | undefined, payload: unknown): boolean => {
  const want = Object.entries(inputs ?? {}).filter(([, v]) => v !== '');
  if (!want.length) return true;
  const p =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  return want.every(([k, v]) => {
    const got = p[k];
    return (typeof got === 'string' || typeof got === 'number' || typeof got === 'boolean') && String(got) === v;
  });
};

/** An activity_log row as the engine sees it. `sub`: the event happened on the board's sub-board (D14). */
export type AutomationEvent = {
  id: string;
  type: string;
  board_id: string | null;
  item_id: string | null;
  sub?: boolean;
  column_key?: string | null;
  column_type?: string | null;
  /** `payload.before` / `payload.after` of the activity row (cell events: `{value}`). */
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
  actor: { type: string; id: string | null; automation_id?: string | null; depth?: number };
  /** update.created: the update's plain text (the dispatcher adds it for `update_posted`). */
  update_text?: string;
};

export type TriggerContext = {
  automationId: string;
  /** Columns of the board the event happened on (the sub-board's for `sub` events). */
  columns: QueryColumn[];
};

export type TriggerCategory = 'status' | 'items' | 'dates' | 'columns' | 'subitems' | 'cross_board' | 'webhooks';

export type TriggerDef<T extends Trigger = Trigger> = {
  type: T['type'];
  category: TriggerCategory;
  /** activity_log types that can fire it; `schedule.fired` for scheduled ones. */
  events: string[];
  /** Fires on the board's sub-board events instead of its own (subitem triggers). */
  sub?: boolean;
  /** Column types its `column` may point at (the builder filters by them, the API validates). */
  columnTypes?: string[];
  scheduled?: boolean;
  /** Needs data the event lacks; the runner finishes the check (04 §2: all subitems / connected items). */
  deep?: boolean;
  /** Built but waiting for a later stage (form, button): rejected on save. */
  available?: boolean;
  /** Items the trigger provides; false = board-level runs (actions limited, 04 §2 `scope: board`). */
  hasItem: (t: T) => boolean;
  match: (t: T, ev: AutomationEvent, ctx: TriggerContext) => boolean;
};

type Label = { id: number; label: string; is_done?: boolean };
const labelsOf = (ctx: TriggerContext, key: string): Label[] => {
  const s = ctx.columns.find((c) => c.id === key)?.settings;
  return Array.isArray(s?.labels) ? (s.labels as Label[]) : [];
};
const valueOf = (x: unknown): unknown =>
  x && typeof x === 'object' && 'value' in x ? (x as { value: unknown }).value : null;
/** The cell's value before and after differ (key order aside); an event without both sides counts as a change. */
const valueChanged = (ev: AutomationEvent) =>
  ev.before === undefined || ev.after === undefined || canonical(valueOf(ev.before)) !== canonical(valueOf(ev.after));
const canonical = (v: unknown): string =>
  JSON.stringify(v ?? null, (_, x: unknown) =>
    x && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
const labelText = (ctx: TriggerContext, key: string, value: unknown): string => {
  const index = (value as { index?: number } | null)?.index;
  if (typeof index !== 'number') return '';
  return (
    labelsOf(ctx, key)
      .find((l) => l.id === index)
      ?.label.trim() ?? ''
  );
};
const labelMatches = (wanted: 'any' | string[], text: string) =>
  wanted === 'any' || wanted.some((w) => w.trim() === text);

const isCell = (ev: AutomationEvent, key: string) => ev.type === 'cell.changed' && ev.column_key === key;

/**
 * The columns a "when … changes" trigger hears: `column` and `columns`, once each. A write to any
 * other column — the one an automation computes, say — does not fire it.
 */
export const triggerColumns = (t: { column?: string; columns?: string[] }): string[] =>
  [...new Set([t.column, ...(t.columns ?? [])])].filter((c): c is string => !!c);
/** The event changed this column (`name` = the item was renamed). */
const columnChange = (ev: AutomationEvent, key: string) =>
  key === 'name' ? ev.type === 'item.renamed' : isCell(ev, key) && valueChanged(ev);
const own = (ev: AutomationEvent) => !ev.sub;

const personIds = (v: unknown): string[] =>
  ((v as { persons_and_teams?: { id: string; kind: string }[] } | null)?.persons_and_teams ?? []).map(
    (p) => `${p.kind === 'team' ? 'team' : 'user'}:${p.id}`,
  );

/** `user:<id>` / `team:<id>` refs added by a people cell change (`payload.before` / `payload.after`). */
export const addedPersonRefs = (before: unknown, after: unknown): string[] => {
  const was = new Set(personIds(valueOf(before)));
  return personIds(valueOf(after)).filter((p) => !was.has(p));
};

/** A `person_assigned` `who` the event alone cannot answer (the runner resolves it on the item). */
export const whoNeedsItem = (who: string) => who !== 'any' && who !== '@actor' && !/^(user|team):/.test(who);

const numberOf = (ctx: TriggerContext, key: string, v: unknown): number | null => {
  if (v === null || v === undefined) return null;
  const col = ctx.columns.find((c) => c.id === key);
  const def = col && columnTypes.get(col.type);
  try {
    const n = def?.toNumber ? def.toNumber(v, col!.settings) : typeof v === 'number' ? v : Number(v);
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
};
const compare = (op: string, a: number, b: number) =>
  op === 'greater_than' ? a > b : op === 'greater_than_or_equal' ? a >= b : op === 'lower_than' ? a < b : a <= b;

const scheduled = (ev: AutomationEvent, ctx: TriggerContext) =>
  ev.type === 'schedule.fired' && ev.meta?.automation_id === ctx.automationId;

const always = () => true;

/** Columns a "date arrives" trigger can watch: stored dates, and the computed "last updated" time (s4f). */
export const DATE_TRIGGER_COLUMN_TYPES = ['date', 'timeline', 'last_updated'];

type Defs = { [K in TriggerType]: TriggerDef<Extract<Trigger, { type: K }>> };

export const TRIGGERS: Defs = {
  item_created: {
    type: 'item_created',
    category: 'items',
    events: ['item.created'],
    hasItem: always,
    match: (_t, ev) => own(ev) && ev.type === 'item.created',
  },
  item_created_in_group: {
    type: 'item_created_in_group',
    category: 'items',
    events: ['item.created'],
    hasItem: always,
    match: (t, ev) =>
      own(ev) && ev.type === 'item.created' && (ev.after as { group_id?: string } | undefined)?.group_id === t.group,
  },
  status_changed: {
    type: 'status_changed',
    category: 'status',
    events: ['cell.changed'],
    columnTypes: ['status'],
    hasItem: always,
    match: (t, ev, ctx) => {
      if (!own(ev) || !isCell(ev, t.column)) return false;
      const now = labelText(ctx, t.column, valueOf(ev.after));
      const was = labelText(ctx, t.column, valueOf(ev.before));
      if (now === was) return false;
      if (t.from_labels?.length && !t.from_labels.some((l) => l.trim() === was)) return false;
      return labelMatches(t.labels, now);
    },
  },
  column_changed: {
    type: 'column_changed',
    category: 'columns',
    events: ['cell.changed', 'item.renamed'],
    hasItem: always,
    // A write that left the value as it was is no change (04 §2; audit 2026-10-10, automations #8): a daily
    // `set_column` to a constant used to fire `column_changed` on every item, every day.
    match: (t, ev) => own(ev) && triggerColumns(t).some((c) => columnChange(ev, c)),
  },
  date_arrived: {
    type: 'date_arrived',
    category: 'dates',
    events: ['schedule.fired'],
    // s4f: a last-updated column too (its computed time — of chosen columns when set), e.g. "3 days after …".
    columnTypes: DATE_TRIGGER_COLUMN_TYPES,
    scheduled: true,
    hasItem: always,
    match: (_t, ev, ctx) => scheduled(ev, ctx),
  },
  date_arrives_before: {
    type: 'date_arrives_before',
    category: 'dates',
    events: ['schedule.fired'],
    // s4f: a last-updated column too (its computed time — of chosen columns when set), e.g. "3 days after …".
    columnTypes: DATE_TRIGGER_COLUMN_TYPES,
    scheduled: true,
    hasItem: always,
    match: (_t, ev, ctx) => scheduled(ev, ctx),
  },
  every_time_period: {
    type: 'every_time_period',
    category: 'dates',
    events: ['schedule.fired'],
    scheduled: true,
    hasItem: (t) => t.scope === 'each_item',
    match: (_t, ev, ctx) => scheduled(ev, ctx),
  },
  item_moved_to_group: {
    type: 'item_moved_to_group',
    category: 'items',
    events: ['item.moved_to_group'],
    hasItem: always,
    match: (t, ev) =>
      own(ev) &&
      ev.type === 'item.moved_to_group' &&
      (t.group === 'any' || (ev.after as { group_id?: string } | undefined)?.group_id === t.group),
  },
  // a file added to a file column (any one when `column` is unset) — `file.added` carries the column.
  file_added: {
    type: 'file_added',
    category: 'columns',
    events: ['file.added'],
    columnTypes: ['file'],
    hasItem: always,
    match: (t, ev) => own(ev) && ev.type === 'file.added' && (!t.column || ev.column_key === t.column),
  },
  button_clicked: {
    type: 'button_clicked',
    category: 'columns',
    events: ['button.clicked'],
    columnTypes: ['button'],
    hasItem: always,
    match: (t, ev) => own(ev) && ev.type === 'button.clicked' && ev.column_key === t.column,
  },
  checkbox_checked: {
    type: 'checkbox_checked',
    category: 'columns',
    events: ['cell.changed'],
    columnTypes: ['checkbox'],
    hasItem: always,
    match: (t, ev) => {
      if (!own(ev) || !isCell(ev, t.column)) return false;
      const checked = (v: unknown) => (v as { checked?: boolean } | null)?.checked === true;
      const now = checked(valueOf(ev.after));
      return now !== checked(valueOf(ev.before)) && now === (t.state === 'checked');
    },
  },
  update_posted: {
    type: 'update_posted',
    category: 'items',
    events: ['update.created'],
    hasItem: always,
    // An update an automation posted never fires it (04 §5.4: `source: automation` updates are ignored — the
    // depth limit was the only thing stopping an A→B→A chain of updates; audit 2026-10-10 worker #12).
    match: (t, ev) =>
      own(ev) &&
      ev.type === 'update.created' &&
      !ev.actor.automation_id &&
      (!t.contains || (ev.update_text ?? '').toLowerCase().includes(t.contains.toLowerCase())),
  },
  subitem_created: {
    type: 'subitem_created',
    category: 'subitems',
    events: ['item.created'],
    sub: true,
    hasItem: always,
    match: (_t, ev) => !!ev.sub && ev.type === 'item.created',
  },
  subitem_status_changed: {
    type: 'subitem_status_changed',
    category: 'subitems',
    events: ['cell.changed'],
    sub: true,
    columnTypes: ['status'],
    deep: true,
    hasItem: always,
    match: (t, ev, ctx) => {
      if (!ev.sub || !isCell(ev, t.column)) return false;
      const now = labelText(ctx, t.column, valueOf(ev.after));
      return now !== labelText(ctx, t.column, valueOf(ev.before)) && labelMatches(t.labels, now);
    },
  },
  subitem_column_changed: {
    type: 'subitem_column_changed',
    category: 'subitems',
    events: ['cell.changed', 'item.renamed'],
    sub: true,
    hasItem: always,
    match: (t, ev) =>
      !!ev.sub && triggerColumns(t).some((c) => (c === 'name' ? ev.type === 'item.renamed' : isCell(ev, c))),
  },
  connected_items_all_done: {
    type: 'connected_items_all_done',
    category: 'cross_board',
    // A link change here, or a status change on a linked board (the dispatcher follows the relation back).
    events: ['cell.changed'],
    columnTypes: ['board_relation'],
    deep: true,
    hasItem: always,
    match: (t, ev) => ev.type === 'cell.changed' && (ev.column_key === t.column || ev.meta?.via_relation === t.column),
  },
  person_assigned: {
    type: 'person_assigned',
    category: 'columns',
    events: ['cell.changed'],
    columnTypes: ['people'],
    hasItem: always,
    // `who` = a person / team / the one who made the change is answered here; `@creator`, a people column, a
    // mirror… need the item, so the runner finishes the check (`deep`; audit 2026-10-10 worker #16 — before, any
    // such ref matched whoever was added).
    deep: true,
    match: (t, ev) => {
      if (!own(ev) || !isCell(ev, t.column)) return false;
      const added = addedPersonRefs(ev.before, ev.after);
      if (!added.length) return false;
      if (t.who === 'any' || whoNeedsItem(t.who)) return true;
      if (t.who === '@actor') return !!ev.actor.id && added.includes(`user:${ev.actor.id}`);
      return added.includes(t.who);
    },
  },
  number_threshold: {
    type: 'number_threshold',
    category: 'columns',
    events: ['cell.changed'],
    columnTypes: ['numbers', 'rating'],
    hasItem: always,
    match: (t, ev, ctx) => {
      if (!own(ev) || !isCell(ev, t.column)) return false;
      const now = numberOf(ctx, t.column, valueOf(ev.after));
      const was = numberOf(ctx, t.column, valueOf(ev.before));
      // Only on crossing: the new value satisfies it, the previous did not.
      return now !== null && compare(t.operator, now, t.value) && !(was !== null && compare(t.operator, was, t.value));
    },
  },
  item_archived: {
    type: 'item_archived',
    category: 'items',
    events: ['item.archived'],
    hasItem: always,
    match: (_t, ev) => own(ev) && ev.type === 'item.archived',
  },
  item_deleted: {
    type: 'item_deleted',
    category: 'items',
    events: ['item.deleted'],
    hasItem: always,
    match: (_t, ev) => own(ev) && ev.type === 'item.deleted',
  },
  item_restored: {
    type: 'item_restored',
    category: 'items',
    events: ['item.restored', 'item.unarchived'],
    hasItem: always,
    match: (_t, ev) => own(ev) && (ev.type === 'item.restored' || ev.type === 'item.unarchived'),
  },
  webhook_in: {
    type: 'webhook_in',
    category: 'webhooks',
    events: ['webhook_in.received'],
    hasItem: (t) => !!t.item_lookup,
    match: (_t, ev, ctx) => ev.type === 'webhook_in.received' && ev.meta?.automation_id === ctx.automationId,
  },
  // D27 ת4: offered in the builder per installed extension (not in the generic list).
  extension_trigger: {
    type: 'extension_trigger',
    category: 'webhooks',
    events: ['extension_trigger.fired'],
    hasItem: (t) => t.with_item,
    match: (t, ev) =>
      ev.type === 'extension_trigger.fired' &&
      ev.meta?.block === t.block &&
      extensionTriggerInputsMatch(t.inputs, ev.meta?.payload),
  },
  // external flows (Administration → זרימות). Board-level runs with `{flow.*}`.
  flow_failed: {
    type: 'flow_failed',
    category: 'webhooks',
    events: ['flow.failed'],
    hasItem: () => false,
    match: (t, ev, ctx) => flowEventMatches(t, ev, ctx, 'flow.failed'),
  },
  flow_recovered: {
    type: 'flow_recovered',
    category: 'webhooks',
    events: ['flow.recovered'],
    hasItem: () => false,
    match: (t, ev, ctx) => flowEventMatches(t, ev, ctx, 'flow.recovered'),
  },
};

/**
 * A flow event (`meta.flow`: connection_id, flow_id …) for this trigger: its connection (or any) and flow (or any).
 * `meta.automation_ids` = the automations whose owner may see that connection (the failure check decides it) — any
 * other automation never hears it.
 */
const flowEventMatches = (
  t: { connection?: string; flow?: string | undefined },
  ev: AutomationEvent,
  ctx: TriggerContext,
  type: string,
) => {
  if (ev.type !== type) return false;
  const flow = ev.meta?.flow as { connection_id?: string; flow_id?: string | null } | undefined;
  if (!flow) return false;
  const allowed = ev.meta?.automation_ids;
  if (Array.isArray(allowed) && !allowed.includes(ctx.automationId)) return false;
  if (t.connection && t.connection !== 'any' && flow.connection_id !== t.connection) return false;
  return !t.flow || flow.flow_id === t.flow;
};

export const triggerDef = <T extends Trigger>(t: T) => TRIGGERS[t.type as TriggerType] as unknown as TriggerDef<T>;

/** Every activity type some trigger listens to — the dispatcher ignores the rest. */
export const TRIGGER_EVENT_TYPES = new Set(Object.values(TRIGGERS).flatMap((d) => d.events));

export const matchTrigger = (t: Trigger, ev: AutomationEvent, ctx: TriggerContext): boolean => {
  const def = triggerDef(t);
  return def.events.includes(ev.type) && def.match(t, ev, ctx);
};

/**
 * D14 — where the run's item lives, and so which board's columns the recipe's conditions, `column` fields and
 * `{item.*}` mean: `sub` = a subitem trigger's item (the sub-board), `main` = the board's own items. "When all
 * subitems…" runs on the parent: the board's item, or a subitem when it listens to sub-subitems.
 */
export type ItemLevel = 'main' | 'sub';
export const recipeItemLevel = (t: Trigger): ItemLevel => {
  if (!TRIGGERS[t.type]?.sub) return 'main';
  if (t.type === 'subitem_status_changed' && t.all_subitems) return t.level === 'sub_subitem' ? 'sub' : 'main';
  return 'sub';
};
/**
 * The board of the run item's parent: a subitem's parent is the board's item, a sub-subitem's a subitem (the
 * sub-board). Null = the item has no parent (a board item). `any` level: checked against the board's items.
 */
export const recipeParentLevel = (t: Trigger): ItemLevel | null => {
  if (recipeItemLevel(t) === 'main') return null;
  const level = 'level' in t ? t.level : undefined;
  return level === 'sub_subitem' && !(t.type === 'subitem_status_changed' && t.all_subitems) ? 'sub' : 'main';
};
/** The sub-board depth a subitem trigger's event item must have (1 subitem, 2 sub-subitem), null = any. */
export const subTriggerDepth = (t: Trigger): number | null => {
  const level = 'level' in t ? t.level : undefined;
  return level === 'subitem' ? 1 : level === 'sub_subitem' ? 2 : null;
};
