// SPDX-License-Identifier: AGPL-3.0-only
import type { MessageKey } from '../i18n';
import { action, type BoardCaps, menu, type MenuNode, SEP, submenu } from './types';
import { treeMoveMenu, treeMoveRights } from './tree';

/**
 * Menus of what lives inside a board (14 §1, §4, §5, §9): item, group, column, view tab.
 * Only actions that exist today; duplicate / archive / move to board / subitems join with M3 steps 3–5.
 */

export type ItemMenuCtx = {
  caps: BoardCaps;
  /** The board has a custom item key (e.g. `BT-0042`). */
  hasKey: boolean;
  /** Other groups to move to exist. */
  canChangeGroup: boolean;
  /** Opened from the item card itself: no "open". */
  inCard?: boolean;
  /** Another level fits under this item (`depth + 1 ≤ hierarchy_depth_max`, D14). */
  canNest?: boolean;
  /** A subitem (D14): it converts back to an item; it does not move between boards on its own. */
  isSubitem?: boolean;
  /** Do I follow it (D15)? `null` while loading (the entry shows, disabled); omitted → no follow entry. */
  following?: boolean | null;
  /** Its level (0 = item). A sub-subitem (depth > 1) can go one level up (`outdent`, Fix: ). */
  depth?: number;
  /**
   * The view is grouped by a column (Fix: b): "move to group" lists the view's sections and sets that
   * column's value — an edit (`item.update`), not a group move. The UI fills the submenu (empty → hidden).
   */
  moveByValue?: boolean;
};

export const itemMenu = (c: ItemMenuCtx): MenuNode[] =>
  menu([
    !c.inCard && action('open', 'menu.item.open', { shortcut: 'Enter' }),
    action('open_new_tab', 'menu.openNewTab', { shortcut: 'Ctrl+Enter' }),
    action('copy_link', 'menu.copyLink'),
    action('copy_id', 'menu.copyId'),
    c.hasKey && action('copy_key', 'menu.item.copyKey'),
    c.following !== undefined && action('follow', 'menu.item.follow', { checked: c.following }),
    SEP,
    c.caps['item.update'] && action('rename', 'menu.rename', { shortcut: 'F2' }),
    !c.inCard && c.caps['item.create'] && action('add_below', 'menu.item.addBelow'),
    c.canNest && c.caps['item.create'] && action('add_subitem', 'menu.item.addSubitem'),
    c.caps['item.create'] && action('duplicate', 'menu.duplicate'),
    c.caps['item.create'] && action('duplicate_with_updates', 'menu.item.duplicateWithUpdates'),
    // an item (and its subitems) as a template of the board; a template's subitems under this one.
    !c.isSubitem && c.caps['column.create'] && action('save_as_template', 'menu.item.saveAsTemplate'),
    c.canNest && c.caps['item.create'] && action('subitems_from_template', 'menu.item.subitemsFromTemplate'),
    (c.moveByValue ? c.caps['item.update'] : c.canChangeGroup && c.caps['item.move_group']) &&
      submenu('move_to_group', 'menu.item.moveToGroup'),
    !c.isSubitem && c.caps['item.move_group'] && action('move_to_board', 'menu.moveToBoard'),
    !c.isSubitem && c.caps['item.update'] && c.caps['item.create'] && action('to_subitem', 'menu.item.toSubitem'),
    // the batch bar's "move to item ▸ under an item… / one level up" for this one row, at every
    // level — beside "make it an item", which asks for the group and the column mapping.
    treeMoveMenu(treeMoveRights(c.caps, !!c.isSubitem)),
    c.isSubitem && c.caps['item.update'] && c.caps['item.create'] && action('to_item', 'menu.item.toItem'),
    SEP,
    c.caps['item.delete'] && action('archive', 'menu.archive'),
    c.caps['item.delete'] && action('delete', 'menu.delete', { shortcut: 'Delete', danger: true }),
  ]);

export type GroupMenuCtx = {
  caps: BoardCaps;
  collapsed: boolean;
  /** Every group is collapsed: "expand all" replaces "collapse all" (the toolbar's toggle moved here, r15board). */
  allCollapsed?: boolean;
  isFirst: boolean;
  isLast: boolean;
  /** The board's only group cannot be deleted (`last_group`). */
  isOnly: boolean;
};

export const groupMenu = (c: GroupMenuCtx): MenuNode[] =>
  menu([
    action(c.collapsed ? 'expand' : 'collapse', c.collapsed ? 'menu.group.expand' : 'menu.group.collapse'),
    c.allCollapsed
      ? action('expand_all', 'toolbar.expandAll')
      : action('collapse_all', 'menu.group.collapseAll', { shortcut: 'Ctrl+G' }),
    SEP,
    c.caps['group.update'] && action('rename', 'menu.rename'),
    c.caps['group.update'] && action('color', 'menu.group.color'),
    c.caps['group.create'] && action('add_above', 'menu.group.addAbove'),
    c.caps['group.create'] && action('add_below', 'menu.group.addBelow'),
    c.caps['group.create'] && action('duplicate', 'menu.group.duplicate'),
    c.caps['group.reorder'] && !c.isFirst && action('move_up', 'menu.group.moveUp'),
    c.caps['group.reorder'] && !c.isLast && action('move_down', 'menu.group.moveDown'),
    c.caps['group.delete'] && !c.isOnly && action('move_to_board', 'menu.moveToBoard'),
    SEP,
    c.caps['group.delete'] && !c.isOnly && action('archive', 'menu.archive'),
    c.caps['group.delete'] && !c.isOnly && action('delete', 'board.deleteGroup', { danger: true }),
  ]);

export type ColumnMenuCtx = {
  caps: BoardCaps;
  isName: boolean;
  /** The type has a settings panel (labels, formula, relation…). */
  hasSettings: boolean;
  /**
   * D28 "שינוי סוג עמודה": the board's owners and admins, on a column whose type has targets it can convert to.
   * `conversions`: the column has a type-change history (its report, undo, restore from backup).
   */
  canConvert?: boolean;
  conversions?: boolean;
};

export const columnMenu = (c: ColumnMenuCtx): MenuNode[] =>
  menu([
    c.caps['column.update'] && action('rename', 'menu.rename', { shortcut: 'F2' }),
    c.caps['column.update'] && c.hasSettings && action('settings', 'board.columnSettings'),
    c.caps['column.create'] && submenu('add_before', 'column.addBefore'),
    c.caps['column.create'] && submenu('add_after', 'column.addAfter'),
    // Widths are personal; an editor can make theirs the board default for everyone.
    c.caps['column.update'] && action('width_for_all', 'column.widthForAll'),
    c.caps['column.update'] && !c.isName && c.canConvert && action('convert', 'column.convert' as MessageKey),
    c.caps['column.update'] && !c.isName && c.conversions && action('conversions', 'column.conversions' as MessageKey),
    action('copy_id', 'column.copyId'),
    SEP,
    c.caps['column.delete'] && !c.isName && action('delete', 'board.deleteColumn', { danger: true }),
  ]);

export type ViewMenuCtx = {
  pinned: boolean;
  shared: boolean;
  isDefault: boolean;
  locked: boolean;
  canSave: boolean;
  canManage: boolean;
  canDelete: boolean;
};

export const viewMenu = (c: ViewMenuCtx): MenuNode[] =>
  menu([
    action(c.pinned ? 'unpin' : 'pin', c.pinned ? 'view.unpin' : 'view.pin'),
    c.canSave && action('rename', 'view.rename'),
    action('duplicate', 'view.duplicate'),
    action('copy_to_board', 'view.copyToBoard'),
    c.canManage && c.shared && !c.isDefault && action('make_default', 'view.makeDefault'),
    c.canManage && c.shared && action(c.locked ? 'unlock' : 'lock', c.locked ? 'view.unlock' : 'view.lock'),
    c.canManage && !c.shared && action('make_shared', 'view.makeShared'),
    SEP,
    c.canDelete && action('delete', 'view.delete', { danger: true }),
  ]);
