// SPDX-License-Identifier: AGPL-3.0-only
import { action, menu, type MenuNode, SEP } from './types';
import { type TreeMoveRights, treeMoveMenu } from './tree';

/**
 * Table cell (14 §3): edit, copy / cut / paste (also for a selected range), clear, and open the item. `editable`
 * already accounts for rights, read-only types and column restrictions.
 */
export type CellMenuCtx = {
  editable: boolean;
  hasValue: boolean;
  link: boolean;
  /** the row's hierarchy moves ("move to item ▸"), on a right click on any of its cells too. */
  tree?: TreeMoveRights;
};

export const cellMenu = (c: CellMenuCtx): MenuNode[] =>
  menu([
    c.editable && action('edit', 'menu.cell.edit', { shortcut: 'Enter' }),
    c.link && c.hasValue && action('open_link', 'menu.cell.openLink'),
    SEP,
    action('copy', 'menu.cell.copy', { shortcut: 'Ctrl+C' }),
    c.editable && c.hasValue && action('cut', 'menu.cell.cut', { shortcut: 'Ctrl+X' }),
    c.editable && action('paste', 'menu.cell.paste', { shortcut: 'Ctrl+V' }),
    c.editable && c.hasValue && action('clear', 'menu.cell.clear', { shortcut: 'Delete' }),
    SEP,
    action('open_item', 'menu.cell.openItem'),
    c.tree && treeMoveMenu(c.tree),
  ]);
