// SPDX-License-Identifier: AGPL-3.0-only
import { itemTemplateVarFits, type ItemTemplateVarType } from '../api/item-templates';
import { columnTypes } from '../columns';
import { ACTIONS, actionColumn, WRITES_CELL } from './actions';
import { COMPUTED_PARENT, computedProblem, parseComputed } from './computed';
import { type Action, FLOW_TEMPLATE_FIELDS, FLOW_TRIGGER_TYPES, type Recipe } from './schema';
import { templatePaths } from './template';
import { recipeItemLevel, recipeParentLevel, TRIGGERS, type ItemLevel } from './triggers';

/**
 * Save-time checks of a recipe against its board (04 §8.1: errors map to the builder's chips). Pure: the API
 * runs it with the board's columns and groups; cross-board references (boards of create_item / move_to_board)
 * are checked by the service against the account.
 */
export type RecipeBoard = {
  columns: { key: string; type: string; title: string; settings: Record<string, unknown> }[];
  groups: { id: string; title: string }[];
  /** The sub-board's columns (D14): subitem triggers and parent / subitem actions; undefined = no sub-board yet. */
  subColumns?: { key: string; type: string; title: string; settings: Record<string, unknown> }[];
  /**
   * Item templates the recipe's template actions may use (phase 2): the API passes the ones each
   * action names that fit it (its board, read by the saver); undefined = not checked.
   */
  itemTemplates?: { id: string; variables: { key: string; type: string }[] }[];
  /**
   * the columns of the board each relation column of the run's item links to (by relation key), for
   * `set_computed`'s `{<relation>.<key>}`; a relation missing here is not checked.
   */
  relationColumns?: Record<string, { key: string; type: string; title: string }[]>;
};

/** `path`: where in the recipe (`trigger.column`, `actions.1.label`); `code`: what is wrong. */
export type RecipeIssue = { path: string; code: string; detail?: string };

type Label = { id: number; label: string; is_deactivated?: boolean };
const labelsOf = (c: RecipeBoard['columns'][number] | undefined): Label[] =>
  Array.isArray(c?.settings.labels) ? (c.settings.labels as Label[]).filter((l) => !l.is_deactivated) : [];
const hasLabel = (c: RecipeBoard['columns'][number] | undefined, text: string) =>
  labelsOf(c).some((l) => l.label.trim() === text.trim());

const READ_ONLY_TRIGGER_TYPES = new Set([
  'formula',
  'mirror',
  'auto_number',
  'creation_log',
  'last_updated',
  'item_id',
  'progress',
  'button',
]);

/** Templates inside an action (strings, `fixed` / `payload` values). */
const templatesOf = (a: Action): [string, string][] => {
  const out: [string, string][] = [];
  const walk = (v: unknown, path: string) => {
    if (typeof v === 'string') out.push([path, v]);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
  };
  for (const k of [
    'name',
    'message',
    'subject',
    'body_html',
    'body',
    'url',
    'item_id',
    'fixed',
    'payload',
    'prompt',
  ] as const)
    if (k in a) walk((a as Record<string, unknown>)[k], k);
  return out;
};

export const validateRecipe = (
  recipe: Recipe,
  board: RecipeBoard,
): { errors: RecipeIssue[]; warnings: RecipeIssue[] } => {
  const errors: RecipeIssue[] = [];
  const warnings: RecipeIssue[] = [];
  const t = recipe.trigger;
  const tdef = TRIGGERS[t.type];
  // D14: the run's item may be a subitem (the sub-board's columns), and parent / subitem actions reach the others.
  const itemLevel = recipeItemLevel(t);
  const parentLevel = recipeParentLevel(t);
  const colsOf = (level: ItemLevel | null) =>
    level === 'sub' ? (board.subColumns ?? []) : level === 'main' ? board.columns : [];
  const itemCols = colsOf(itemLevel);
  const col = (key: string) => itemCols.find((c) => c.key === key);
  const needSub = (path: string) => {
    if (board.subColumns) return false;
    errors.push({ path, code: 'no_subitems_board' });
    return true;
  };

  /**
   * A `column:<key>` people ref: a column of the run item's board, or — when the run item is a subitem of any depth
   * and its sub-board lacks the key — of the board's own columns (the engine climbs the ancestors to the nearest
   * one whose board has the key: a sub-subitem's parent shares the sub-board, so that is the board item). Other refs
   * (`@…`, `user:`, `team:`, `mirror:`, addresses) are not columns of this board.
   */
  const peopleColumn = (path: string, ref: string | undefined, types: string[], wrongType = 'not_a_people_column') => {
    if (!ref?.startsWith('column:')) return;
    const key = ref.slice(7);
    const c =
      itemCols.find((x) => x.key === key) ?? (itemLevel === 'sub' ? board.columns : []).find((x) => x.key === key);
    if (!c) errors.push({ path, code: 'column_not_found', detail: key });
    else if (!types.includes(c.type)) errors.push({ path, code: wrongType, detail: c.type });
  };

  if (tdef.available === false) errors.push({ path: 'trigger.type', code: 'not_available' });
  if (tdef.sub && needSub('trigger.type')) return { errors, warnings };
  if ('column' in t && typeof t.column === 'string' && t.column !== 'name') {
    const c = (tdef.sub ? colsOf('sub') : board.columns).find((x) => x.key === t.column);
    if (!c) errors.push({ path: 'trigger.column', code: 'column_not_found', detail: t.column });
    else if (tdef.columnTypes && !tdef.columnTypes.includes(c.type))
      errors.push({ path: 'trigger.column', code: 'column_type', detail: c.type });
    else if (
      (t.type === 'column_changed' || t.type === 'subitem_column_changed') &&
      READ_ONLY_TRIGGER_TYPES.has(c.type)
    )
      errors.push({ path: 'trigger.column', code: 'column_type', detail: c.type });
    if (c && (t.type === 'status_changed' || t.type === 'subitem_status_changed') && t.labels !== 'any')
      t.labels.forEach(
        (l, i) => !hasLabel(c, l) && errors.push({ path: `trigger.labels.${i}`, code: 'label_not_found', detail: l }),
      );
  }
  // every other column a "when … changes" trigger hears.
  if ((t.type === 'column_changed' || t.type === 'subitem_column_changed') && t.columns)
    t.columns.forEach((key, i) => {
      if (key === 'name') return;
      const c = (tdef.sub ? colsOf('sub') : board.columns).find((x) => x.key === key);
      if (!c) errors.push({ path: `trigger.columns.${i}`, code: 'column_not_found', detail: key });
      else if (READ_ONLY_TRIGGER_TYPES.has(c.type))
        errors.push({ path: `trigger.columns.${i}`, code: 'column_type', detail: c.type });
    });
  if (t.type === 'item_created_in_group' || (t.type === 'item_moved_to_group' && t.group !== 'any')) {
    if (!board.groups.some((g) => g.id === t.group))
      errors.push({ path: 'trigger.group', code: 'group_not_found', detail: t.group });
  }
  const boardLevel = !tdef.hasItem(t as never);

  recipe.actions.forEach((a, i) => {
    const def = ACTIONS[a.type];
    const at = (k: string) => `actions.${i}.${k}`;
    if (def.available === false) warnings.push({ path: at('type'), code: 'not_available' });
    if (boardLevel && def.needsItem) errors.push({ path: at('type'), code: 'needs_item' });
    const key = actionColumn(a);
    // connect_items → trigger_item: the column lives on the created item's board (checked when it runs).
    const sameBoard = !(a.type === 'connect_items' && a.target === 'trigger_item');
    // Parent / subitem actions (D14): the column (and the copied source) live on that item's board.
    const sideCols = (on: 'item' | 'parent' | 'subitems' | undefined, path: string) => {
      if (on === 'parent') {
        if (!parentLevel) {
          errors.push({ path, code: 'no_parent' });
          return null;
        }
        return parentLevel === 'sub' && needSub(path) ? null : colsOf(parentLevel);
      }
      if (on === 'subitems') return needSub(path) ? null : colsOf('sub');
      return itemCols;
    };
    if ('source' in a && def.sourceOn && a.source !== 'name') {
      const cols = sideCols(def.sourceOn, at('source'));
      if (cols && !cols.some((c) => c.key === a.source))
        errors.push({ path: at('source'), code: 'column_not_found', detail: a.source });
    }
    if (key && sameBoard) {
      const cols = sideCols(def.columnOn, at('column'));
      const c = cols?.find((x) => x.key === key);
      if (!cols) {
        // reported by sideCols
      } else if (!c) errors.push({ path: at('column'), code: 'column_not_found', detail: key });
      else if (def.columnTypes && !def.columnTypes.includes(c.type))
        errors.push({ path: at('column'), code: 'column_type', detail: c.type });
      else if (WRITES_CELL.has(a.type)) {
        const ct = columnTypes.get(c.type);
        if (!ct || ct.readOnly || ct.storage !== 'cell')
          errors.push({ path: at('column'), code: 'column_read_only', detail: c.type });
      }
      if (c && a.type === 'set_status' && !hasLabel(c, a.label))
        errors.push({ path: at('label'), code: 'label_not_found', detail: a.label });
    }
    // Subitems have no groups (D14).
    if (itemLevel === 'sub' && (a.type === 'move_to_group' || (a.type === 'duplicate_item' && a.group)))
      errors.push({ path: at('group'), code: 'subitem_no_group' });
    else if ((a.type === 'move_to_group' || a.type === 'duplicate_item') && a.group && !a.group.startsWith('@')) {
      if (!board.groups.some((g) => g.id === a.group || g.title.trim() === a.group!.trim()))
        errors.push({ path: at('group'), code: 'group_not_found', detail: a.group });
    }
    if ((a.type === 'create_item' || a.type === 'create_item_from_template') && a.connect_column) {
      const c = col(a.connect_column);
      if (!c) errors.push({ path: at('connect_column'), code: 'column_not_found', detail: a.connect_column });
      else if (c.type !== 'board_relation')
        errors.push({ path: at('connect_column'), code: 'column_type', detail: c.type });
    }
    // Item templates (phase 2): the template exists for this action, and each variable takes its
    // answer from the trigger item's name or a column of a fitting type.
    if (a.type === 'create_item_from_template' || a.type === 'add_template_subitems') {
      const tpl = board.itemTemplates?.find((x) => x.id === a.template);
      if (board.itemTemplates && !tpl)
        errors.push({ path: at('template'), code: 'item_template_not_found', detail: a.template });
      const sources = Object.entries(a.variables ?? {});
      if (sources.length && boardLevel) errors.push({ path: at('variables'), code: 'needs_item' });
      else
        for (const [key, source] of sources) {
          const v = tpl?.variables.find((x) => x.key === key);
          if (tpl && !v) {
            errors.push({ path: at(`variables.${key}`), code: 'item_template_unknown_variable', detail: key });
            continue;
          }
          const fits = (type: string) => !v || itemTemplateVarFits(v.type as ItemTemplateVarType, type);
          if (source === 'name') {
            if (!fits('name')) errors.push({ path: at(`variables.${key}`), code: 'column_type', detail: 'name' });
            continue;
          }
          const c = col(source);
          if (!c) errors.push({ path: at(`variables.${key}`), code: 'column_not_found', detail: source });
          else if (!fits(c.type)) errors.push({ path: at(`variables.${key}`), code: 'column_type', detail: c.type });
        }
    }
    // Image to image: the pictures come from file columns of the run's item.
    if (a.type === 'generate_image') {
      const sources: (readonly [field: 'source_column' | 'source_columns', key: string])[] = [
        ...(a.source_column ? [['source_column', a.source_column] as const] : []),
        ...(a.source_columns ?? []).map((k) => ['source_columns', k] as const),
      ];
      for (const [field, key] of sources) {
        const c = col(key);
        if (!c) errors.push({ path: at(field), code: 'column_not_found', detail: key });
        else if (c.type !== 'file') errors.push({ path: at(field), code: 'column_type', detail: c.type });
      }
      // Style examples (round 3): a file column of the board (the filter is checked when it runs, as the owner).
      const style = a.style_examples?.column;
      if (style) {
        const c = col(style);
        if (!c) errors.push({ path: at('style_examples'), code: 'column_not_found', detail: style });
        else if (c.type !== 'file') errors.push({ path: at('style_examples'), code: 'column_type', detail: c.type });
      }
      // Round 4: the locked base is a file column of the item.
      if (a.fidelity_base_column) {
        const c = col(a.fidelity_base_column);
        if (!c)
          errors.push({ path: at('fidelity_base_column'), code: 'column_not_found', detail: a.fidelity_base_column });
        else if (c.type !== 'file')
          errors.push({ path: at('fidelity_base_column'), code: 'column_type', detail: c.type });
      }
    }
    if (a.type === 'set_computed') {
      const problem = computedProblem(a.expression);
      if (problem) errors.push({ path: at('expression'), code: 'expression_invalid', detail: problem.code });
      else
        for (const ref of parseComputed(a.expression).refs) {
          const where = ref.scope === 'self' ? ref.column : `${ref.relation ?? COMPUTED_PARENT}.${ref.column}`;
          if (ref.scope === 'self') {
            if (ref.column !== 'name' && !col(ref.column))
              errors.push({ path: at('expression'), code: 'column_not_found', detail: where });
          } else if (ref.scope === 'parent') {
            if (!parentLevel) errors.push({ path: at('expression'), code: 'no_parent', detail: where });
            else if (ref.column !== 'name' && !colsOf(parentLevel).some((c) => c.key === ref.column))
              errors.push({ path: at('expression'), code: 'column_not_found', detail: where });
          } else {
            const r = col(ref.relation!);
            if (!r) errors.push({ path: at('expression'), code: 'column_not_found', detail: ref.relation });
            else if (r.type !== 'board_relation')
              errors.push({ path: at('expression'), code: 'not_a_relation', detail: ref.relation });
            else {
              const linked = board.relationColumns?.[ref.relation!];
              if (linked && ref.column !== 'name' && !linked.some((c) => c.key === ref.column))
                errors.push({ path: at('expression'), code: 'column_not_found', detail: where });
            }
          }
        }
    }
    if (a.type === 'copy_from_linked') {
      const r = col(a.relation);
      if (!r) errors.push({ path: at('relation'), code: 'column_not_found', detail: a.relation });
      else if (r.type !== 'board_relation') errors.push({ path: at('relation'), code: 'column_type', detail: r.type });
    }
    // Whose timer: a people column of the item's board. A clock has no person who made a change.
    if ((a.type === 'start_time_tracking' || a.type === 'stop_time_tracking') && a.who === '@actor' && !a.fallback)
      if (['every_time_period', 'date_arrived', 'date_arrives_before'].includes(t.type))
        warnings.push({ path: at('who'), code: 'timer_no_actor' });
    if (a.type === 'start_time_tracking' || a.type === 'stop_time_tracking')
      for (const [field, ref] of [
        ['who', a.who],
        ['fallback', a.fallback],
      ] as const)
        peopleColumn(at(field), ref, ['people'], 'column_type');
    // Recipients / assignees: a people column (or, for an email, an email column) of the run
    // item's board — or, for a subitem trigger, of its parent's board.
    if (a.type === 'notify' || a.type === 'send_email')
      (Array.isArray(a.to) ? a.to : [a.to]).forEach((ref, j) =>
        peopleColumn(
          Array.isArray(a.to) ? at(`to.${j}`) : at('to'),
          ref,
          a.type === 'send_email' ? ['people', 'email'] : ['people'],
        ),
      );
    if (a.type === 'assign' || a.type === 'unassign') peopleColumn(at('who'), a.who, ['people']);
    if (a.type === 'send_sms' && !a.template && !a.message?.trim())
      errors.push({ path: at('message'), code: 'required' });
    if (a.type === 'webhook' && !/^https?:\/\//i.test(a.url))
      errors.push({ path: at('url'), code: 'url_invalid', detail: a.url });
    // Templates: `{item.<key>}` must name a column of the board (or a built-in field).
    for (const [path, text] of templatesOf(a))
      for (const p of templatePaths(text)) {
        const [root, key] = p.split('.');
        // `{flow.*}`: only a flow trigger's run knows a flow.
        if (root === 'flow') {
          if (!(FLOW_TRIGGER_TYPES as readonly string[]).includes(t.type))
            warnings.push({ path: at(path), code: 'flow_vars_without_flow_trigger', detail: p });
          else if (!key || !(FLOW_TEMPLATE_FIELDS as readonly string[]).includes(key))
            warnings.push({ path: at(path), code: 'unknown_template', detail: p });
          continue;
        }
        const cols =
          root === 'item'
            ? itemCols
            : root === 'parent'
              ? colsOf(parentLevel)
              : root === 'subitem'
                ? (board.subColumns ?? [])
                : null;
        if (cols && key && !BUILTIN_ITEM_FIELDS.has(key) && !cols.some((c) => c.key === key))
          warnings.push({ path: at(path), code: 'unknown_template', detail: p });
      }
  });
  return { errors, warnings };
};

const BUILTIN_ITEM_FIELDS = new Set(['name', 'id', 'url', 'group', 'group_id', 'created_at', 'creator']);
