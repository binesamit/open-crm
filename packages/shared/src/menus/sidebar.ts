// SPDX-License-Identifier: AGPL-3.0-only
import type { MessageKey } from '../i18n';
import { action, menu, type MenuNode, SEP, submenu } from './types';

/** Keys the lead merges into he/en.json from the docs area (M8). */
const k = (key: string) => key as MessageKey;

/**
 * Sidebar menus (14 §6–8): board, folder, workspace. Rights come from the workspace tree
 * (`can_update` / `can_delete` / `can_edit` / `can_create`), which the API computes per actor.
 */

export type SidebarBoardMenuCtx = { canUpdate: boolean; canDelete: boolean; canCreate?: boolean };

export const sidebarBoardMenu = (c: SidebarBoardMenuCtx): MenuNode[] =>
  menu([
    action('open_new_tab', 'menu.openNewTab'),
    action('copy_link', 'menu.copyLink'),
    action('copy_id', 'menu.copyId'),
    SEP,
    c.canUpdate && action('rename', 'menu.rename'),
    c.canUpdate && submenu('move_to', 'sidebar.moveTo'),
    c.canCreate && action('duplicate', 'menu.board.duplicate'),
    c.canUpdate && action('save_as_template', 'menu.board.saveAsTemplate'),
    SEP,
    c.canDelete && action('archive', 'menu.archive'),
    c.canDelete && action('delete', 'menu.delete', { danger: true }),
  ]);

export type FolderMenuCtx = { canCreate: boolean; canEdit: boolean; canNest: boolean };

export const folderMenu = (c: FolderMenuCtx): MenuNode[] =>
  menu([
    c.canCreate && action('new_board', 'sidebar.newBoardHere'),
    c.canCreate && action('new_doc', k('sidebar.newDocHere')),
    c.canCreate && action('new_dashboard', k('dashboards.newHere')),
    c.canCreate && c.canNest && action('new_subfolder', 'sidebar.newSubfolder'),
    c.canEdit && action('rename', 'menu.rename'),
    SEP,
    c.canEdit && action('delete', 'menu.delete', { danger: true }),
  ]);

export type WorkspaceMenuCtx = { canCreate: boolean; canEdit: boolean; canDelete: boolean };

export const workspaceMenu = (c: WorkspaceMenuCtx): MenuNode[] =>
  menu([
    c.canCreate && action('new_board', 'board.new'),
    c.canCreate && action('new_doc', k('docs.new')),
    c.canCreate && action('new_dashboard', k('dashboards.new')),
    c.canCreate && action('new_folder', 'sidebar.newFolder'),
    c.canEdit && action('rename', 'menu.rename'),
    SEP,
    c.canDelete && action('delete', 'sidebar.deleteWorkspace', { danger: true }),
  ]);

export type SidebarDocMenuCtx = { canUpdate: boolean; canDelete: boolean; canCreate?: boolean };

/** A doc in the sidebar (M8 ד1): like a board's, without what only boards have (templates, archive). */
export const sidebarDocMenu = (c: SidebarDocMenuCtx): MenuNode[] =>
  menu([
    action('open_new_tab', 'menu.openNewTab'),
    action('copy_link', 'menu.copyLink'),
    action('copy_id', 'menu.copyId'),
    SEP,
    c.canUpdate && action('rename', 'menu.rename'),
    c.canUpdate && submenu('move_to', 'sidebar.moveTo'),
    c.canCreate && action('duplicate', k('docs.duplicate')),
    SEP,
    c.canDelete && action('delete', 'menu.delete', { danger: true }),
  ]);

/** A dashboard in the sidebar (M8 ד4): like a doc's. */
export const sidebarDashboardMenu = (c: SidebarDocMenuCtx): MenuNode[] =>
  menu([
    action('open_new_tab', 'menu.openNewTab'),
    action('copy_link', 'menu.copyLink'),
    action('copy_id', 'menu.copyId'),
    SEP,
    c.canUpdate && action('rename', 'menu.rename'),
    c.canUpdate && submenu('move_to', 'sidebar.moveTo'),
    c.canCreate && action('duplicate', k('dashboards.duplicate')),
    SEP,
    c.canDelete && action('delete', 'menu.delete', { danger: true }),
  ]);
