// SPDX-License-Identifier: AGPL-3.0-only
import { action, type BoardCaps, menu, type MenuNode, submenu } from './types';

/**
 * Hierarchy moves — one entry in every menu that acts on rows: the batch bar and its
 * right-click menu, the row menu, the cell menu and the item card's ⋯. "Move to item ▸ Under an item… / One level
 * up", the same labels, icon and test ids everywhere; the UI runs both through the hierarchy service.
 */
export type TreeMoveRights = { under: boolean; up: boolean };

/**
 * What the actor may do with rows of a board: `onSubBoard` = the rows are subitems (their board is a sub-board).
 * Under an item: `item.update`, and for items of the board also `item.create` (they land on the sub-board). One
 * level up: subitems only, with `item.update` (a subitem becoming an item is checked again by the server).
 */
export const treeMoveRights = (caps: BoardCaps, onSubBoard: boolean): TreeMoveRights => ({
  under: !!caps['item.update'] && (onSubBoard || !!caps['item.create']),
  up: !!caps['item.update'] && onSubBoard,
});

/** The two actions (the batch bar's "move to item" button lists them as they are). */
export const treeMoveItems = (r: TreeMoveRights): MenuNode[] =>
  menu([
    r.under && action('move_under', 'batch.tree.under', { testId: 'menu-tree-under' }),
    r.up && action('move_up', 'batch.tree.up', { shortcut: 'Shift+Tab', testId: 'menu-tree-up' }),
  ]);

/** The submenu of the menus ("Move to item ▸"), or nothing when neither action is allowed. */
export const treeMoveMenu = (r: TreeMoveRights): MenuNode | false =>
  (r.under || r.up) && submenu('move_in_tree', 'batch.tree', treeMoveItems(r), { testId: 'menu-tree' });
