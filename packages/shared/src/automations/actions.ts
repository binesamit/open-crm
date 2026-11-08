// SPDX-License-Identifier: AGPL-3.0-only
import { COMPUTED_TARGET_TYPES } from './computed';
import type { Action, ActionType } from './schema';

/**
 * 04 §4 — the action registry: what each action needs and touches. The `run` side lives with the services
 * (apps/api automations runner, D21) — this half is what the builder, the validator and the runner's
 * dependency rules share.
 */
export type ActionCategory = 'columns' | 'items' | 'people' | 'communication' | 'cross_board' | 'integrations';

export type ActionDef = {
  type: ActionType;
  category: ActionCategory;
  /** Needs the trigger item (not allowed on board-level runs: `every_time_period scope: board`, webhook without lookup). */
  needsItem: boolean;
  /** Writes through the services (emits events, can chain other automations). */
  writes: boolean;
  /** Quota bucket (04 §5.8). */
  bucket: 'automation' | 'integration';
  /** Column types `column` may point at. */
  columnTypes?: string[];
  /** Allowed on an item that was deleted / archived (04 §2 item_deleted). */
  onGoneItem?: boolean;
  /** Stored but not executed (rejected nowhere, skipped by the runner). */
  available?: boolean;
  /**
   * D14 — the board `column` is on: the run item's (default), its parent's, or its subitems' (the sub-board).
   * `source` (copy actions) is on the other side.
   */
  columnOn?: 'parent' | 'subitems';
  sourceOn?: 'item' | 'parent';
};

const d = (type: ActionType, category: ActionCategory, rest: Partial<ActionDef> = {}): ActionDef => ({
  type,
  category,
  needsItem: true,
  writes: true,
  bucket: 'automation',
  ...rest,
});

export const ACTIONS: Record<ActionType, ActionDef> = {
  set_status: d('set_status', 'columns', { columnTypes: ['status'] }),
  set_column: d('set_column', 'columns'),
  set_date: d('set_date', 'columns', { columnTypes: ['date', 'timeline'] }),
  set_item_name: d('set_item_name', 'columns'),
  increment_number: d('increment_number', 'columns', { columnTypes: ['numbers'] }),
  // a value computed from the item, its parent and its linked items, written to a plain column.
  set_computed: d('set_computed', 'columns', { columnTypes: COMPUTED_TARGET_TYPES }),
  clear_column: d('clear_column', 'columns'),
  move_to_group: d('move_to_group', 'items'),
  move_to_board: d('move_to_board', 'cross_board'),
  create_item: d('create_item', 'cross_board', { needsItem: false }),
  create_subitem: d('create_subitem', 'items'),
  // Item templates (phase 2): a new item (any board's template) / subitems under the trigger item.
  create_item_from_template: d('create_item_from_template', 'cross_board', { needsItem: false }),
  add_template_subitems: d('add_template_subitems', 'items'),
  duplicate_item: d('duplicate_item', 'items'),
  archive_item: d('archive_item', 'items'),
  delete_item: d('delete_item', 'items'),
  assign: d('assign', 'people', { columnTypes: ['people'] }),
  unassign: d('unassign', 'people', { columnTypes: ['people'] }),
  notify: d('notify', 'communication', { needsItem: false, writes: false, onGoneItem: true }),
  send_email: d('send_email', 'communication', {
    needsItem: false,
    writes: false,
    bucket: 'integration',
    onGoneItem: true,
  }),
  webhook: d('webhook', 'integrations', { needsItem: false, writes: false, bucket: 'integration', onGoneItem: true }),
  start_time_tracking: d('start_time_tracking', 'columns', { columnTypes: ['time_tracking'] }),
  stop_time_tracking: d('stop_time_tracking', 'columns', { columnTypes: ['time_tracking'] }),
  create_update: d('create_update', 'communication', { onGoneItem: true }),
  // makes / sends the item's interactive document (an email to the client → the integration bucket).
  send_document: d('send_document', 'communication', { bucket: 'integration' }),
  // Plan: SMS to the item's phone column (account SMS provider); costs money → the integration bucket.
  send_sms: d('send_sms', 'communication', { columnTypes: ['phone'], bucket: 'integration' }),
  connect_items: d('connect_items', 'cross_board', { columnTypes: ['board_relation'] }),
  copy_from_linked: d('copy_from_linked', 'cross_board'),
  set_parent_column: d('set_parent_column', 'items', { columnOn: 'parent' }),
  set_subitems_column: d('set_subitems_column', 'items', { columnOn: 'subitems' }),
  copy_from_parent: d('copy_from_parent', 'items', { sourceOn: 'parent' }),
  copy_to_parent: d('copy_to_parent', 'items', { columnOn: 'parent', sourceOn: 'item' }),
  copy_to_subitems: d('copy_to_subitems', 'items', { columnOn: 'subitems', sourceOn: 'item' }),
  run_agent: d('run_agent', 'integrations', {
    needsItem: false,
    writes: false,
    bucket: 'integration',
    onGoneItem: true,
  }),
  // AI images: a model call that costs money → the integration bucket; the image lands in a file column.
  generate_image: d('generate_image', 'columns', { columnTypes: ['file'], bucket: 'integration' }),
  // D27 ת4: a signed call to an installed extension's server; its writes come back through the API ("via app X").
  run_extension: d('run_extension', 'integrations', {
    needsItem: false,
    writes: false,
    bucket: 'integration',
    onGoneItem: true,
  }),
  // Subscribed integrations (n8n, Make): a signed delivery to each, like a board webhook.
  send_to_integrations: d('send_to_integrations', 'integrations', {
    needsItem: false,
    writes: false,
    bucket: 'integration',
    onGoneItem: true,
  }),
};

export const actionDef = (a: Action) => ACTIONS[a.type];

/** The action's own column on the trigger board (validated against the board's columns on save). */
export const actionColumn = (a: Action): string | null =>
  'column' in a && typeof a.column === 'string' ? a.column : null;

/** Actions that write into another item's cells (the parent / the subitems): read-only target columns are refused. */
export const WRITES_CELL = new Set<ActionType>([
  'set_column',
  'set_computed',
  'clear_column',
  'copy_from_linked',
  'set_parent_column',
  'set_subitems_column',
  'copy_from_parent',
  'copy_to_parent',
  'copy_to_subitems',
]);

/** The time tracking actions (whose timer: `who`). */
export const TIMER_ACTIONS = new Set<string>(['start_time_tracking', 'stop_time_tracking']);
const TIMER_SHORTHANDS: Record<string, string> = {
  time_tracking_start: 'start_time_tracking',
  time_tracking_stop: 'stop_time_tracking',
};
const timerType = (a: unknown) => {
  const type = (a as { type?: unknown } | null)?.type;
  return typeof type === 'string' ? (TIMER_SHORTHANDS[type] ?? type) : null;
};

/**
 * A new timer action without `who` gets the default for new automations, `@actor` (whoever made the change). One
 * that was already saved without it — the same type and column in `previous` — keeps the owner's timer, so an
 * automation made before the option existed never changes silently. Works on the raw recipe (shorthands too).
 */
export const applyTimerDefaults = (raw: unknown, previous?: { actions?: unknown[] } | null): unknown => {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { actions?: unknown }).actions)) return raw;
  const legacy = new Set(
    (previous?.actions ?? [])
      .filter((a) => TIMER_ACTIONS.has(timerType(a) ?? '') && (a as { who?: unknown }).who === undefined)
      .map((a) => `${timerType(a)}:${String((a as { column?: unknown }).column)}`),
  );
  const actions = ((raw as { actions: unknown[] }).actions ?? []).map((a) => {
    const type = timerType(a);
    if (!type || !TIMER_ACTIONS.has(type) || (a as { who?: unknown }).who !== undefined) return a;
    if (legacy.has(`${type}:${String((a as { column?: unknown }).column)}`)) return a;
    return { ...(a as object), who: '@actor' };
  });
  return { ...(raw as object), actions };
};
