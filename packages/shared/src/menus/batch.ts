// SPDX-License-Identifier: AGPL-3.0-only
import { action, menu, type MenuNode, SEP, submenu } from './types';
import { type TreeMoveRights, treeMoveMenu } from './tree';

/**
 * Several selected items (14 §2): the batch bar's actions, also on a right click on a selected row or card.
 * Submenus are filled by the UI (columns, date columns, groups).
 */
export type BatchMenuCtx = {
  canEdit: boolean;
  canMoveGroup: boolean;
  canMoveBoard: boolean;
  canCreate: boolean;
  canDelete: boolean;
  /** Hierarchy moves: `treeMoveRights` of the selection's board. */
  tree?: TreeMoveRights;
};

export const batchMenu = (c: BatchMenuCtx): MenuNode[] =>
  menu([
    c.canEdit && submenu('set_value', 'batch.edit'),
    c.canEdit && submenu('shift_dates', 'batch.shiftDates'),
    c.canMoveGroup && submenu('move_to_group', 'batch.move'),
    c.canMoveBoard && action('move_to_board', 'batch.moveToBoard'),
    c.tree && treeMoveMenu(c.tree),
    c.canCreate && action('duplicate', 'batch.duplicate'),
    c.canDelete && action('archive', 'batch.archive'),
    SEP,
    c.canDelete && action('delete', 'batch.delete', { shortcut: 'Delete', danger: true }),
    SEP,
    action('clear_selection', 'batch.clear', { shortcut: 'Esc' }),
  ]);
