// SPDX-License-Identifier: AGPL-3.0-only
import { Icon, type IconName } from './icons';

/** The F4 menus show an icon per action; registry ids (packages/shared/src/menus) map to icons here, in one place. */
const BY_ID: Record<string, IconName> = {
  open: 'ext',
  open_new_tab: 'ext',
  copy_link: 'link',
  copy_id: 'copy',
  copy_key: 'copy',
  copy_text: 'copy',
  follow: 'bell',
  rename: 'edit',
  edit: 'edit',
  add_below: 'plus',
  add_above: 'plus',
  add_subitem: 'plus',
  new_board: 'board',
  new_folder: 'folder',
  new_subfolder: 'folder',
  duplicate: 'duplicate',
  duplicate_with_updates: 'duplicate',
  move_to_group: 'move',
  move_to_board: 'move',
  move_to: 'move',
  to_subitem: 'move',
  to_item: 'move',
  move_under: 'nest',
  move_up: 'nest',
  outdent: 'nest',
  move_in_tree: 'nest',
  archive: 'archive',
  delete: 'trash',
  color: 'palette',
  collapse: 'collapse',
  expand: 'expand',
  collapse_all: 'collapse',
  expand_all: 'expand',
  settings: 'gear',
  save_template: 'board',
};

export const menuIcon = (id: string) => {
  const name = BY_ID[id];
  return name ? <Icon name={name} size={16} /> : undefined;
};
