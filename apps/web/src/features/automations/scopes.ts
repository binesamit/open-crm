// SPDX-License-Identifier: AGPL-3.0-only
import {
  ACTIONS,
  columnTypes,
  TRIGGERS,
  type ActionType,
  type ItemLevel,
  type TriggerCategory,
  type TriggerType,
} from '@bines/shared';

/**
 * r17ui ("subitem columns in automations — I don't see the option in the trigger, nor in actions")
 * the builder's pickers say where subitems live.
 * - The trigger and action menus come in sections (by category), with subitems in a section of their own.
 * - A column blank lists the columns of every item the run can reach, in sections — the item's own, its subitems',
 *   its parent's — and picking one in another section switches the trigger / action to its subitem / parent
 *   variant (`column_changed` ↔ `subitem_column_changed`, `set_column` ↔ `set_subitems_column` ↔
 *   `set_parent_column`). Everything here is pure: the builder renders it.
 */

/** Order of the trigger menu's sections. */
export const TRIGGER_SECTIONS: TriggerCategory[] = [
  'status',
  'columns',
  'items',
  'subitems',
  'dates',
  'cross_board',
  'webhooks',
];

/** Trigger types grouped in menu sections (empty sections left out), in registry order inside a section. */
export const triggerSections = (types: TriggerType[]) =>
  TRIGGER_SECTIONS.map((section) => ({
    section,
    types: types.filter((k) => (TRIGGERS[k]?.category ?? 'items') === section),
  })).filter((s) => s.types.length);

/** The action menu's sections: the registry's categories, plus "subitems & parent" for the D14 actions. */
export type ActionSection =
  'columns' | 'items' | 'subitems' | 'people' | 'communication' | 'cross_board' | 'integrations';
export const ACTION_SECTIONS: ActionSection[] = [
  'columns',
  'items',
  'subitems',
  'people',
  'communication',
  'cross_board',
  'integrations',
];

/** Whether an action works on another level than the run's item (its subitems, its parent) or creates one. */
export const isSubitemAction = (type: ActionType) => {
  const def = ACTIONS[type];
  return type === 'create_subitem' || type === 'add_template_subitems' || !!def?.columnOn || !!def?.sourceOn;
};

export const actionSections = (types: ActionType[]) =>
  ACTION_SECTIONS.map((section) => ({
    section,
    types: types.filter((k) =>
      section === 'subitems' ? isSubitemAction(k) : !isSubitemAction(k) && ACTIONS[k]?.category === section,
    ),
  })).filter((s) => s.types.length);

/** Where a column blank's column lives, seen from the run's item. */
export type ColumnScope = 'item' | 'subitems' | 'parent';

/** Types that are one blank in different places: picking a column of another scope switches between them. */
const FAMILIES: { trigger: boolean; scopes: Partial<Record<ColumnScope, string>> }[] = [
  { trigger: true, scopes: { item: 'column_changed', subitems: 'subitem_column_changed' } },
  { trigger: true, scopes: { item: 'status_changed', subitems: 'subitem_status_changed' } },
  { trigger: false, scopes: { item: 'set_column', subitems: 'set_subitems_column', parent: 'set_parent_column' } },
];

const familyOf = (type: string, isTrigger: boolean) =>
  FAMILIES.find((f) => f.trigger === isTrigger && Object.values(f.scopes).includes(type)) ?? null;

/** Whether a column fits a blank of this type (allowed types, writable cells; the name only where it may). */
export const columnFits = (type: string, isTrigger: boolean, column: { type: string }) => {
  if (column.type === 'name') return isTrigger && (type === 'column_changed' || type === 'subitem_column_changed');
  const allowed = isTrigger ? TRIGGERS[type as TriggerType]?.columnTypes : ACTIONS[type as ActionType]?.columnTypes;
  if (allowed) return allowed.includes(column.type);
  const def = columnTypes.get(column.type);
  // set_column / clear_column write cells; column_changed listens to stored values.
  return !!def && !def.readOnly && def.storage === 'cell';
};

/** What the builder knows about levels: the run item's board, its parent's, and the boards' columns. */
export type LevelCtx<C> = {
  itemLevel: ItemLevel;
  parentLevel: ItemLevel | null;
  /** The board's own columns and the sub-board's (empty = no sub-board yet). */
  main: C[];
  sub: C[];
  /** The board allows sub-subitems (hierarchy deeper than 1). */
  subLevels: boolean;
};

/** Label keys of the sections (i18n fragment r17ui). */
export type ColumnSectionLabel =
  'auto.cols.item' | 'auto.cols.subitem' | 'auto.cols.subSubitem' | 'auto.cols.parentItem' | 'auto.cols.parentSubitem';

export type ColumnSection<C> = {
  scope: ColumnScope;
  label: ColumnSectionLabel;
  /** The type the owner becomes when a column of this section is picked. */
  type: string;
  columns: C[];
};

/**
 * The sections of a column blank, or null when the blank is not part of a family (the plain list stays). A trigger
 * family is seen from the board (its item, the subitems); an action family from the run's item (itself, its
 * subitems when that level exists, its parent when it has one). Sections without a fitting column are left out.
 */
export const columnSections = <C extends { type: string }>(
  type: string,
  isTrigger: boolean,
  ctx: LevelCtx<C>,
): ColumnSection<C>[] | null => {
  const family = familyOf(type, isTrigger);
  if (!family) return null;
  const at = (l: ItemLevel | null) => (l === 'sub' ? ctx.sub : l === 'main' ? ctx.main : []);
  const out: ColumnSection<C>[] = [];
  const add = (scope: ColumnScope, label: ColumnSectionLabel, columns: C[]) => {
    const t = family.scopes[scope];
    if (!t) return;
    const fit = columns.filter((c) => columnFits(t, isTrigger, c));
    if (fit.length) out.push({ scope, label, type: t, columns: fit });
  };
  if (isTrigger) {
    add('item', 'auto.cols.item', ctx.main);
    add('subitems', 'auto.cols.subitem', ctx.sub);
    return out;
  }
  const sub = ctx.itemLevel === 'sub';
  add('item', sub ? 'auto.cols.subitem' : 'auto.cols.item', at(ctx.itemLevel));
  // A subitem's own subitems are sub-subitems: only on boards that allow them.
  if (!sub || ctx.subLevels) add('subitems', sub ? 'auto.cols.subSubitem' : 'auto.cols.subitem', ctx.sub);
  if (ctx.parentLevel)
    add('parent', ctx.parentLevel === 'sub' ? 'auto.cols.parentSubitem' : 'auto.cols.parentItem', at(ctx.parentLevel));
  return out;
};

/**
 * The patch that picks `column` in a section: the column, the section's type when it differs, and — between a
 * trigger's board and subitem variants — the fields only one side has (`level`, `all_subitems`).
 */
export const pickInSection = (
  owner: { type: string } & Record<string, unknown>,
  section: { type: string },
  column: string,
): Record<string, unknown> => {
  if (section.type === owner.type) return { column };
  const patch: Record<string, unknown> = { type: section.type, column };
  const toSub = !!TRIGGERS[section.type as TriggerType]?.sub;
  const fromSub = !!TRIGGERS[owner.type as TriggerType]?.sub;
  if (fromSub && !toSub) Object.assign(patch, { level: undefined, all_subitems: undefined });
  if (section.type === 'subitem_status_changed') patch.all_subitems = owner.all_subitems ?? false;
  // A status trigger's labels are texts of the old column's labels: they rarely fit another column.
  if (owner.labels !== undefined && owner.column !== column) patch.labels = 'any';
  // `where` (which subitems) means nothing on the item itself or its parent.
  if (owner.type === 'set_subitems_column') patch.where = undefined;
  return patch;
};

/** "when a column changes" triggers hear several columns — their column blank picks with checks. */
export const MULTI_COLUMN_TRIGGERS = new Set(['column_changed', 'subitem_column_changed']);

/**
 * A check on a column of a "when … changes" trigger: in its own section, the column joins or leaves `columns` (the
 * last one stays — a trigger hears at least one); in another section (item ↔ subitem) the trigger moves there with
 * that column alone.
 */
export const toggleTriggerColumn = (
  owner: { type: string } & Record<string, unknown>,
  section: { type: string },
  column: string,
): Record<string, unknown> => {
  if (section.type !== owner.type) return { ...pickInSection(owner, section, column), columns: undefined };
  const current = [owner.column, ...((owner.columns as string[] | undefined) ?? [])].filter(
    (c, i, all): c is string => typeof c === 'string' && all.indexOf(c) === i,
  );
  const next = current.includes(column) ? current.filter((c) => c !== column) : [...current, column];
  if (!next.length) return {};
  return { column: next[0], columns: next.length > 1 ? next : undefined };
};
