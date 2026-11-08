// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { AI_IMAGE_QUALITY_RE, AI_IMAGE_SIZE_RE } from '../ai/models';
import {
  AI_FIDELITY_MODES,
  AI_NO_SOURCE_IMAGE_MODES,
  AI_PHOTO_MODES,
  AI_SOURCE_COLUMNS_MAX,
  AI_VARIATIONS_MAX,
  type AiNoSourceImageMode,
  type AiSourceCount,
  aiSourceCountSchema,
  aiStyleExamplesSchema,
} from '../columns/defs/ai';
import { filterGroupSchema } from '../query/filter';
import { COMPUTED_EXPRESSION_MAX, COMPUTED_ON_EMPTY } from './computed';

/**
 * 04-AUTOMATIONS §1 — a recipe is data: `{trigger, conditions, actions}`. This is the canonical (stored) form;
 * `normalize.ts` turns the seed shorthands into it. Nothing here knows a board, column or account: every
 * reference is a key of the automation's own board (D21).
 */

/** A column key of the board (ours `[a-z][a-z0-9_]{0,19}`; imported keys can be longer). */
export const columnRef = z.string().regex(/^[a-z][a-z0-9_]{0,49}$/);
/** A group id of the board, or `@top` / `@bottom` (the first / last group). */
export const groupRef = z.string().min(1).max(64);
/** A board id of the same account, or `@self`. */
export const boardRef = z.string().min(1).max(64);

/** Who: special refs, a people column, a relation's people column, a user / team id, or (send_email only) an address. */
export const PEOPLE_SPECIAL = ['@creator', '@actor', '@board_owners', '@subscribers', '@mentions'] as const;
export const peopleRef = z.union([
  z.enum(PEOPLE_SPECIAL),
  z.string().regex(/^column:[a-z][a-z0-9_]{0,49}$/),
  z.string().regex(/^mirror:[a-z][a-z0-9_]{0,49}\.[a-z][a-z0-9_]{0,49}$/),
  z.string().regex(/^user:[0-9A-Za-z-]{10,40}$/),
  z.string().regex(/^team:[0-9A-Za-z-]{10,40}$/),
  z.email(),
]);
export type PeopleRef = z.infer<typeof peopleRef>;

/**
 * Whose timer a start / stop time tracking action runs: `@actor` = whoever made the change (the
 * default for new automations), `column:<people column>` = every person in it, `user:<id>` = one person,
 * `@automation_owner` = the automation's owner. Unset = the owner (automations saved before the option existed keep
 * that behaviour). Stop also takes `@all`: every timer running on the item's column. `fallback` = a people column
 * used when no person made the change (a form, a schedule, an email, another automation, an agent, a webhook);
 * without it such a run is skipped with the reason in the run log.
 */
export const TIMER_WHO_SPECIAL = ['@actor', '@automation_owner'] as const;
export const timerWho = z.union([
  z.enum(TIMER_WHO_SPECIAL),
  z.string().regex(/^column:[a-z][a-z0-9_]{0,49}$/),
  z.string().regex(/^user:[0-9A-Za-z-]{10,40}$/),
]);
export const timerFallback = z.string().regex(/^column:[a-z][a-z0-9_]{0,49}$/);
export type TimerWho = z.infer<typeof timerWho> | '@all';

export const timeHHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const labelsOrAny = z.union([z.literal('any'), z.array(z.string().min(1)).min(1)]).default('any');

/**
 * Which items of the sub-board a subitem trigger hears (D14: subitems and sub-subitems share the sub-board and its
 * columns, `hierarchy_depth_max`). Unset = any level.
 */
export const SUB_LEVELS = ['any', 'subitem', 'sub_subitem'] as const;
export const subLevel = z.enum(SUB_LEVELS).optional();
export type SubLevel = z.infer<typeof subLevel>;

/** A flow connection of the account (Administration → זרימות), or `any`. */
export const flowConnectionRef = z.union([z.literal('any'), z.string().regex(/^[0-9A-Za-z]{10,40}$/)]).default('any');
/** A flow's id on its platform (n8n workflow id, Make scenario id, Zap id). */
export const flowRef = z.string().trim().min(1).max(64);
/** The flow triggers (`{flow.*}` texts, board-level runs). */
export const FLOW_TRIGGER_TYPES = ['flow_failed', 'flow_recovered'] as const;
/** `{flow.<field>}`: what a flow trigger's run knows. `url` opens the flow in our flows screen. */
export const FLOW_TEMPLATE_FIELDS = [
  'name',
  'id',
  'platform',
  'connection',
  'status',
  'error',
  'step',
  'run_id',
  'run_url',
  'url',
  'started_at',
] as const;

/** A column a "when … changes" trigger hears, or the item's name. */
const watchedColumn = z.union([columnRef, z.literal('name')]);
/** every column a "when … changes" trigger hears (with `column`); unset = `column` alone. */
const watchedColumns = z.array(watchedColumn).min(1).max(20).optional();

// ---------- triggers (04 §2) ----------
export const triggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('item_created') }),
  z.object({ type: z.literal('item_created_in_group'), group: groupRef }),
  z.object({
    type: z.literal('status_changed'),
    column: columnRef,
    labels: labelsOrAny,
    from_labels: z.array(z.string().min(1)).optional(),
  }),
  /**
   * `column: "name"` = the item was renamed. `columns`: more columns heard by the same automation
   * any of them changing fires it (`column` is the first; `triggerColumns` reads both).
   */
  z.object({ type: z.literal('column_changed'), column: watchedColumn, columns: watchedColumns }),
  z.object({
    type: z.literal('date_arrived'),
    column: columnRef,
    /** + after, − before the date. */
    offset_days: z.number().int().min(-365).max(365).default(0),
    /** The offset counts working days of the account calendar (no weekend, holidays, days off). */
    workdays: z.boolean().optional(),
    time: timeHHMM.default('09:00'),
  }),
  z.object({
    type: z.literal('date_arrives_before'),
    column: columnRef,
    days: z.number().int().min(1).max(365),
    /** "N working days before": the days are counted in the account calendar. */
    workdays: z.boolean().optional(),
    time: timeHHMM.default('09:00'),
  }),
  z.object({
    type: z.literal('every_time_period'),
    period: z.enum(['hour', 'day', 'week', 'month']),
    time: timeHHMM.default('09:00'),
    weekday: z.enum(WEEKDAYS).optional(),
    day_of_month: z.number().int().min(1).max(28).optional(),
    scope: z.enum(['board', 'each_item']).default('each_item'),
  }),
  z.object({ type: z.literal('item_moved_to_group'), group: groupRef.default('any') }),
  z.object({
    type: z.literal('checkbox_checked'),
    column: columnRef,
    state: z.enum(['checked', 'unchecked']).default('checked'),
  }),
  z.object({ type: z.literal('update_posted'), contains: z.string().max(200).optional() }),
  z.object({ type: z.literal('subitem_created'), level: subLevel }),
  z.object({
    type: z.literal('subitem_status_changed'),
    column: columnRef,
    labels: labelsOrAny,
    /** true = runs on the parent once every subitem has one of the labels. */
    all_subitems: z.boolean().default(false),
    level: subLevel,
  }),
  /** Any column of the sub-board (or the name) changed on a subitem; `column` is a sub-board column key. */
  z.object({
    type: z.literal('subitem_column_changed'),
    column: watchedColumn,
    columns: watchedColumns,
    level: subLevel,
  }),
  z.object({
    type: z.literal('connected_items_all_done'),
    column: columnRef,
    done_column: columnRef.optional(),
    done_labels: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    type: z.literal('person_assigned'),
    column: columnRef,
    who: z.union([z.literal('any'), peopleRef]).default('any'),
  }),
  z.object({
    type: z.literal('number_threshold'),
    column: columnRef,
    operator: z.enum(['greater_than', 'greater_than_or_equal', 'lower_than', 'lower_than_or_equal']),
    value: z.number(),
  }),
  /**
   * A file was added to a file column of an item: `column` = that file column, unset = any file
   * column of the board. Uploads, links attached and AI-made images alike (an automation never hears its own).
   */
  z.object({ type: z.literal('file_added'), column: columnRef.optional() }),
  /** A button column was clicked on an item (M8 ד11, 03 §3.7). */
  z.object({ type: z.literal('button_clicked'), column: columnRef }),
  z.object({ type: z.literal('item_archived') }),
  z.object({ type: z.literal('item_deleted') }),
  z.object({ type: z.literal('item_restored') }),
  z.object({
    type: z.literal('webhook_in'),
    secret: z.string().min(16).max(128).optional(),
    item_lookup: z.object({ column: z.union([columnRef, z.literal('id')]), path: z.string().min(1) }).optional(),
  }),
  /**
   * An installed extension's trigger (D27 ת4): its server fires `<extension>.<feature>` with a signed call to
   * `POST /automations/triggers/:block/fire`; the call's `payload` is `{payload.*}`, its `item_id` the item (when
   * `with_item`).
   */
  z.object({
    type: z.literal('extension_trigger'),
    block: z.string().min(3).max(90),
    with_item: z.boolean().default(false),
    /**
     * values of the trigger's `inputs` (its manifest) — the automation runs only for fires whose
     * payload has the same value under each key. None (or empty values): every fire, as before.
     */
    inputs: z
      .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(500))
      .refine((r) => Object.keys(r).length <= 10, 'too_many_inputs')
      .optional(),
  }),
  /**
   * An external flow (n8n / Make / Zapier, Administration → זרימות) failed, or ran fine again after failing
   *. The flow connections' failure check fires it, account-wide, on every board whose active
   * automation listens. `connection` = one connection id or `any` (every connection the automation's owner may
   * see); `flow` = one flow of it (unset = every flow). Board-level runs; the texts read `{flow.*}`.
   */
  z.object({ type: z.literal('flow_failed'), connection: flowConnectionRef, flow: flowRef.optional() }),
  z.object({ type: z.literal('flow_recovered'), connection: flowConnectionRef, flow: flowRef.optional() }),
]);
export type Trigger = z.infer<typeof triggerSchema>;
export type TriggerType = Trigger['type'];

// ---------- actions (04 §4) ----------
/**
 * `today | now | clear | column:<key>` + optional `±N(h|d|wd|w|m)` + optional `@HH:MM`. `wd` = working days of the
 * account calendar.
 */
export const DATE_EXPR_RE =
  /^(today|now|clear|column:[a-z][a-z0-9_]{0,49})([+-]\d{1,4}(?:wd|[hdwm]))?(@([01]\d|2[0-3]):[0-5]\d)?$/;
export type DateExprUnit = 'h' | 'd' | 'wd' | 'w' | 'm';
/** `+3wd` → { n: 3, unit: 'wd' } (the shift group of DATE_EXPR_RE). */
export const dateExprShift = (shift: string): { n: number; unit: DateExprUnit } => {
  const unit = (shift.endsWith('wd') ? 'wd' : shift.slice(-1)) as DateExprUnit;
  return { n: Number(shift.slice(0, -unit.length)), unit };
};
export const dateExpr = z.string().regex(DATE_EXPR_RE);
const tmpl = z.string().max(5000);
/** `{target column key: source column key}`; `name` is the item name. */
const mapping = z.record(z.string(), z.string());
/** `{target column key: value or template}`. */
const fixed = z.record(z.string(), z.unknown());
const recipients = z.union([peopleRef, z.array(peopleRef).min(1).max(20)]);
/** Item templates: `{template variable key: column of the trigger item, or name}`. */
const templateVariables = z
  .record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), columnRef)
  .refine((r) => Object.keys(r).length <= 12, 'at most 12 variables');

export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('set_status'), column: columnRef, label: z.string().min(1) }),
  z.object({ type: z.literal('set_column'), column: columnRef, value: z.unknown() }),
  z.object({ type: z.literal('set_date'), column: columnRef, value: dateExpr }),
  z.object({ type: z.literal('set_item_name'), name: tmpl }),
  z.object({ type: z.literal('increment_number'), column: columnRef, by: z.number().default(1) }),
  z.object({ type: z.literal('clear_column'), column: columnRef }),
  z.object({ type: z.literal('move_to_group'), group: groupRef }),
  z.object({
    type: z.literal('move_to_board'),
    board: boardRef,
    group: groupRef.optional(),
    mapping: mapping.optional(),
  }),
  z.object({
    type: z.literal('create_item'),
    board: boardRef,
    group: groupRef.optional(),
    name: tmpl.default('{item.name}'),
    mapping: mapping.optional(),
    fixed: fixed.optional(),
    /** Relation column on the trigger item that receives the new item. */
    connect_column: columnRef.optional(),
    /** Relation column on the new item pointing back (one-way relations). */
    connect_back_column: columnRef.optional(),
  }),
  z.object({ type: z.literal('create_subitem'), name: tmpl, fixed: fixed.optional(), mapping: mapping.optional() }),
  /**
   * Item templates (phase 2): a new item from a template of `board` — its whole tree, values, updates
   * and files — in `group` (the board's first group by default). `variables` = `{template variable: source}`, the
   * source a column of the trigger item or `name` (a date column → a date variable, a people column → a person
   * one, any column's text → a text one); unset variables take their default. `connect_column` (a relation column
   * of the trigger item) receives the new item; `connect_back_column` (a relation column of the new item) points
   * back. Applied as the automation's owner through the templates service: one undoable batch.
   */
  z.object({
    type: z.literal('create_item_from_template'),
    board: boardRef,
    template: z.string().min(1).max(26),
    group: groupRef.optional(),
    variables: templateVariables.optional(),
    connect_column: columnRef.optional(),
    connect_back_column: columnRef.optional(),
  }),
  /**
   * The template's subitems (every depth) under the trigger item — a template of the automation's board; the item's
   * empty cells take the template's values (filled ones are kept), as "subitems from a template" in the app.
   */
  z.object({
    type: z.literal('add_template_subitems'),
    template: z.string().min(1).max(26),
    variables: templateVariables.optional(),
  }),
  z.object({
    type: z.literal('duplicate_item'),
    with_updates: z.boolean().default(false),
    group: groupRef.optional(),
    name: tmpl.optional(),
  }),
  z.object({ type: z.literal('archive_item') }),
  z.object({ type: z.literal('delete_item') }),
  z.object({
    type: z.literal('assign'),
    column: columnRef,
    who: peopleRef,
    mode: z.enum(['add', 'replace']).default('add'),
  }),
  z.object({ type: z.literal('unassign'), column: columnRef, who: z.union([peopleRef, z.literal('all')]) }),
  z.object({ type: z.literal('notify'), to: recipients, message: tmpl }),
  z.object({
    type: z.literal('send_email'),
    to: recipients,
    subject: z.string().min(1).max(300),
    body_html: tmpl,
    reply_to: z.email().optional(),
  }),
  z.object({
    type: z.literal('webhook'),
    url: z.string().min(1).max(1000),
    method: z.enum(['POST', 'PUT']).default('POST'),
    /** "item" = the standard envelope with the item snapshot; an object = a template rendered recursively. */
    payload: z.union([z.literal('item'), z.record(z.string(), z.unknown())]).default('item'),
    /** Extra request headers: at most 20, names and values of a sane size (audit 2026-10-10 security #27). */
    headers: z
      .record(z.string().min(1).max(100), z.string().max(1000))
      .refine((h) => Object.keys(h).length <= 20, 'at most 20 headers')
      .optional(),
    secret: z.string().max(128).optional(),
  }),
  z.object({
    type: z.literal('start_time_tracking'),
    column: columnRef,
    who: timerWho.optional(),
    fallback: timerFallback.optional(),
  }),
  z.object({
    type: z.literal('stop_time_tracking'),
    column: columnRef,
    who: z.union([timerWho, z.literal('@all')]).optional(),
    fallback: timerFallback.optional(),
  }),
  z.object({ type: z.literal('create_update'), body: tmpl }),
  /**
   * Interactive documents: the item's document from a template — the open one made from it earlier
   * else a new one — and (with `send`) its link emailed to the document's contact.
   */
  z.object({ type: z.literal('send_document'), template: z.string().min(1).max(26), send: z.boolean().default(true) }),
  /**
   * An SMS to the number in a phone column of the item, through the account's SMS provider
   * `template` = the id of one of the account's SMS templates (Administration → SMS), else `message` (a template
   * over the item). Sent as the automation's owner — the account's "who may send SMS" applies to them — and logged
   * as an SMS update on the item.
   */
  z.object({
    type: z.literal('send_sms'),
    column: columnRef,
    template: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,40}$/)
      .optional(),
    message: tmpl.optional(),
  }),
  z.object({
    type: z.literal('connect_items'),
    column: columnRef,
    target: z.enum(['created', 'trigger_item']).default('created'),
    item_id: tmpl.optional(),
  }),
  /**
   * Copies a value from the item linked through `relation` (its first linked item) into `column` of this item:
   * `source` is a column of the linked board (or `name`). The value is converted to the target column's type.
   */
  z.object({
    type: z.literal('copy_from_linked'),
    relation: columnRef,
    source: z.union([columnRef, z.literal('name')]),
    column: columnRef,
  }),
  /**
   * Subitems (D14) — the parent item and its subitems, whose columns live on the sub-board. The item of the run is
   * the trigger's (a subitem for subitem triggers): `set_parent_column` / `copy_*_parent` reach its parent,
   * `set_subitems_column` / `copy_to_subitems` its direct children (optionally only those matching `where`, the
   * filter model over the sub-board's columns). `value` is a value or a template, like `set_column`.
   */
  z.object({ type: z.literal('set_parent_column'), column: columnRef, value: z.unknown() }),
  z.object({
    type: z.literal('set_subitems_column'),
    column: columnRef,
    value: z.unknown(),
    where: filterGroupSchema.optional(),
  }),
  /**
   * `column` = the result of `expression` — the formula column's language over the item's columns
   * its parent's (`{parent.<key>}`) and its linked items' (`{<relation>.<key>}`), see `computed.ts`. The column stays
   * a plain one people may edit. `round` = digits after the point; `on_empty` = what happens when a value the
   * expression reads is empty (and has no `|default`) or the result is not a value: skip (default), clear, or 0.
   */
  z.object({
    type: z.literal('set_computed'),
    column: columnRef,
    expression: z.string().trim().min(1).max(COMPUTED_EXPRESSION_MAX),
    round: z.number().int().min(0).max(10).optional(),
    on_empty: z.enum(COMPUTED_ON_EMPTY).optional(),
  }),
  /** `source` on the parent → `column` of this item (converted to its type). */
  z.object({
    type: z.literal('copy_from_parent'),
    source: z.union([columnRef, z.literal('name')]),
    column: columnRef,
  }),
  /** `source` of this item → `column` of its parent. */
  z.object({
    type: z.literal('copy_to_parent'),
    source: z.union([columnRef, z.literal('name')]),
    column: columnRef,
  }),
  /** `source` of this item → `column` of each of its subitems. */
  z.object({
    type: z.literal('copy_to_subitems'),
    source: z.union([columnRef, z.literal('name')]),
    column: columnRef,
    where: filterGroupSchema.optional(),
  }),
  /**
   * Starts a run of an agent of the account (D26 מ8): `prompt` is the task (a template over the item); the item
   * itself reaches the agent as data, never as instructions. Runs on its own (queued), as the agent.
   */
  z.object({
    type: z.literal('run_agent'),
    agent: z.string().min(1).max(26),
    prompt: z.string().min(1).max(8000),
  }),
  /**
   * AI images: an image described by `prompt` — a template over the item (`{item.<column>}` values) — made
   * by the account's image model (Administration → AI → images), or by `connection` / `model` when set, and saved as
   * a file in the file column `column`. Size / quality default to the account's. Needs the plan's `ai` feature.
   */
  z.object({
    type: z.literal('generate_image'),
    column: columnRef,
    prompt: z.string().min(1).max(4000),
    /**
     * Image to image: file columns of the item, in order, whose images the picture starts from (the
     * prompt says what to make of them; several columns add a line naming which pictures came from which).
     * Unset / empty = from the text only. Read with `generateImageSources`.
     */
    source_columns: z.array(columnRef).max(AI_SOURCE_COLUMNS_MAX).optional(),
    /** The first version's single source column (kept working: its newest image, as then). */
    source_column: columnRef.optional(),
    /** How many images of each source column: `'all'` (default; the provider's limit keeps the newest) or newest N. */
    source_count: aiSourceCountSchema.optional(),
    /** No image in the source columns: `text` (default) = from the description only, `skip` = the action is skipped. */
    when_no_source_image: z.enum(AI_NO_SOURCE_IMAGE_MODES).optional(),
    /**
     * Style examples (round 3): the newest `count` images of `column` on OTHER items of the board that
     * match `filter` (e.g. status = Approved), sent first as the style to follow — read as the automation's owner.
     */
    style_examples: aiStyleExamplesSchema.extend({ column: columnRef }).optional(),
    /**
     * Round 4, as the AI column: `each` = one image per source photo, `together` = one from all
     * (unset = `together`, the action's behaviour before — the builder sets `each` on a new action); `variations`
     * 1–4 per call (unset = 1); `fidelity` free (unset) | close | locked with `fidelity_base_column` (a file column of
     * the item; unset = the newest style example). The action always adds files (it keeps no record to version).
     */
    photo_mode: z.enum(AI_PHOTO_MODES).optional(),
    variations: z.number().int().min(1).max(AI_VARIATIONS_MAX).optional(),
    fidelity: z.enum(AI_FIDELITY_MODES).optional(),
    fidelity_base_column: columnRef.optional(),
    size: z.string().regex(AI_IMAGE_SIZE_RE).optional(),
    quality: z.string().regex(AI_IMAGE_QUALITY_RE).optional(),
    connection: z.string().max(26).optional(),
    model: z.string().max(80).optional(),
  }),
  /**
   * An installed extension's action (D27 ת4): `block` = `<extension>.<feature>`; a signed POST to the extension's
   * server with the item and the rendered `input`. `mcp:<tool>` (the old seed alias) is kept but not run.
   */
  z.object({
    type: z.literal('run_extension'),
    block: z.string().min(1).max(120),
    input: z.record(z.string(), z.unknown()).optional(),
  }),
  /**
   * Sends the item to every integration subscribed to the board's `automation_sent` webhook event (an n8n / Make
   * trigger registers it when its workflow is switched on). `channel` lets a subscription take only these actions.
   */
  z.object({
    type: z.literal('send_to_integrations'),
    channel: z.string().trim().max(80).optional(),
  }),
]);
export type Action = z.infer<typeof actionSchema>;
export type ActionType = Action['type'];

/**
 * `generate_image`'s photo sources as one shape: `source_columns`, else the old single
 * `source_column` (its newest image, as the first version sent); `'all'` and "from the description" by default.
 */
export const generateImageSources = (
  a: Pick<
    Extract<Action, { type: 'generate_image' }>,
    'source_columns' | 'source_column' | 'source_count' | 'when_no_source_image'
  >,
): { columns: string[]; count: AiSourceCount; whenNone: AiNoSourceImageMode } => {
  const legacy = !a.source_columns?.length && !!a.source_column;
  const columns = a.source_columns?.length ? [...new Set(a.source_columns)] : a.source_column ? [a.source_column] : [];
  return {
    columns,
    count: a.source_count ?? (legacy ? 1 : 'all'),
    whenNone: a.when_no_source_image ?? 'text',
  };
};

// ---------- recipe ----------
export const MAX_ACTIONS = 20;

export const recipeSchema = z
  .object({
    trigger: triggerSchema,
    /** "Only if": the query model's filter tree (13-FILTERS), evaluated on a fresh item snapshot (04 §3). */
    conditions: filterGroupSchema.optional(),
    actions: z.array(actionSchema).min(1).max(MAX_ACTIONS),
  })
  .meta({ id: 'AutomationRecipe' });
export type Recipe = z.infer<typeof recipeSchema>;
export type RecipeInput = z.input<typeof recipeSchema>;
