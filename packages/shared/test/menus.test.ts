// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  boardCapabilities,
  type BoardPermissionContext,
  columnMenu,
  folderMenu,
  groupMenu,
  itemMenu,
  menu,
  menuIds,
  SEP,
  action,
  batchMenu,
  cellMenu,
  sidebarBoardMenu,
  sidebarDocMenu,
  updateMenu,
  viewMenu,
  workspaceMenu,
} from '../src';

/** 14 §16: every menu × role, as a snapshot of the item ids (`!` = destructive, `▸` = submenu, `—` = separator). */
const ROLES: Record<string, BoardPermissionContext> = {
  admin: {
    accountRole: 'admin',
    workspaceVisible: true,
    board: { kind: 'main', permissionSet: 'edit_everything' },
    membership: null,
  },
  owner: {
    accountRole: 'member',
    workspaceVisible: true,
    board: { kind: 'main', permissionSet: 'edit_everything' },
    membership: { role: 'owner' },
  },
  member: {
    accountRole: 'member',
    workspaceVisible: true,
    board: { kind: 'main', permissionSet: 'edit_everything' },
    membership: null,
  },
  contributor: {
    accountRole: 'member',
    workspaceVisible: true,
    board: { kind: 'main', permissionSet: 'edit_content' },
    membership: null,
  },
  viewer: {
    accountRole: 'viewer',
    workspaceVisible: true,
    board: { kind: 'main', permissionSet: 'edit_everything' },
    membership: null,
  },
  guest: {
    accountRole: 'guest',
    workspaceVisible: true,
    board: { kind: 'shareable', permissionSet: 'edit_content' },
    membership: { role: 'subscriber' },
  },
};
const roles = Object.entries(ROLES).map(([role, ctx]) => ({ role, caps: boardCapabilities(ctx) }));

describe('menu()', () => {
  it('drops hidden entries and stray separators', () => {
    expect(
      menuIds(menu([SEP, false, action('a', 'menu.rename'), SEP, SEP, null, action('b', 'menu.delete'), SEP])),
    ).toEqual(['a', '—', 'b']);
  });
});

describe('board menus × role', () => {
  it.each(roles)('$role', ({ caps }) => {
    expect({
      item: menuIds(itemMenu({ caps, hasKey: true, canChangeGroup: true, canNest: true })),
      itemInCard: menuIds(itemMenu({ caps, hasKey: false, canChangeGroup: true, inCard: true })),
      itemFollow: menuIds(itemMenu({ caps, hasKey: false, canChangeGroup: false, following: null })),
      group: menuIds(groupMenu({ caps, collapsed: false, isFirst: false, isLast: false, isOnly: false })),
      column: menuIds(columnMenu({ caps, isName: false, hasSettings: true })),
      nameColumn: menuIds(columnMenu({ caps, isName: true, hasSettings: false })),
    }).toMatchSnapshot();
  });

  it('a viewer never sees a destructive or editing item', () => {
    const caps = boardCapabilities(ROLES.viewer!);
    const ids = [
      ...menuIds(itemMenu({ caps, hasKey: false, canChangeGroup: true })),
      ...menuIds(groupMenu({ caps, collapsed: false, isFirst: false, isLast: false, isOnly: false })),
      ...menuIds(columnMenu({ caps, isName: false, hasSettings: true })),
    ];
    expect(ids.filter((id) => id.endsWith('!') || /rename|add_|move_|settings|color|width/.test(id))).toEqual([]);
  });

  it('every row has "move to item" (under an item at every level, one level up for subitems); grouped by a column, moving is an edit', () => {
    const editor = boardCapabilities(ROLES.admin!);
    const viewer = boardCapabilities(ROLES.viewer!);
    const sub = (depth: number, caps = editor) =>
      menuIds(itemMenu({ caps, hasKey: false, canChangeGroup: false, isSubitem: depth > 0, depth }));
    // the batch bar's submenu, for one row — an item may only go under another item.
    expect(sub(0).filter((id) => id.startsWith('move_in_tree'))).toEqual(['move_in_tree▸', 'move_in_tree>move_under']);
    for (const depth of [1, 2]) {
      const ids = sub(depth);
      expect(ids.filter((id) => id.startsWith('move_in_tree'))).toEqual([
        'move_in_tree▸',
        'move_in_tree>move_under',
        'move_in_tree>move_up',
      ]);
      expect(ids.indexOf('move_in_tree>move_up')).toBe(ids.indexOf('to_item') - 1);
    }
    expect(
      menuIds(
        itemMenu({ caps: editor, hasKey: false, canChangeGroup: false, isSubitem: true, depth: 2, inCard: true }),
      ),
    ).toContain('move_in_tree>move_up');
    expect(sub(2, viewer).some((id) => id.startsWith('move_in_tree'))).toBe(false);
    const byValue = (caps: typeof editor) =>
      menuIds(itemMenu({ caps, hasKey: false, canChangeGroup: false, moveByValue: true }));
    expect(byValue(editor)).toContain('move_to_group▸');
    expect(byValue(viewer)).not.toContain('move_to_group▸');
  });

  it('the only group and the name column cannot be deleted; first/last groups move one way', () => {
    const caps = boardCapabilities(ROLES.admin!);
    const only = menuIds(groupMenu({ caps, collapsed: true, isFirst: true, isLast: true, isOnly: true }));
    expect(only).not.toContain('delete!');
    expect(only).not.toContain('move_up');
    expect(only).not.toContain('move_down');
    expect(only[0]).toBe('expand');
    expect(menuIds(columnMenu({ caps, isName: true, hasSettings: false }))).not.toContain('delete!');
  });
});

describe('views, sidebar and updates', () => {
  it('view tab', () => {
    const base = { pinned: false, shared: true, isDefault: false, locked: false };
    expect({
      manager: menuIds(viewMenu({ ...base, canSave: true, canManage: true, canDelete: true })),
      editor: menuIds(viewMenu({ ...base, canSave: true, canManage: false, canDelete: false })),
      viewer: menuIds(viewMenu({ ...base, pinned: true, canSave: false, canManage: false, canDelete: false })),
      myPrivate: menuIds(viewMenu({ ...base, shared: false, canSave: true, canManage: true, canDelete: true })),
    }).toMatchSnapshot();
  });

  it('sidebar board / folder / workspace', () => {
    expect({
      boardOwner: menuIds(sidebarBoardMenu({ canUpdate: true, canDelete: true, canCreate: true })),
      boardReader: menuIds(sidebarBoardMenu({ canUpdate: false, canDelete: false })),
      folderCreator: menuIds(folderMenu({ canCreate: true, canEdit: true, canNest: true })),
      folderMember: menuIds(folderMenu({ canCreate: true, canEdit: false, canNest: false })),
      folderViewer: menuIds(folderMenu({ canCreate: false, canEdit: false, canNest: true })),
      workspaceAdmin: menuIds(workspaceMenu({ canCreate: true, canEdit: true, canDelete: true })),
      workspaceViewer: menuIds(workspaceMenu({ canCreate: false, canEdit: false, canDelete: false })),
      docOwner: menuIds(sidebarDocMenu({ canUpdate: true, canDelete: true, canCreate: true })),
      docReader: menuIds(sidebarDocMenu({ canUpdate: false, canDelete: false })),
    }).toMatchSnapshot();
  });

  it('batch (selected items)', () => {
    const all = { canEdit: true, canMoveGroup: true, canMoveBoard: true, canCreate: true, canDelete: true };
    expect({
      editor: menuIds(batchMenu(all)),
      contributor: menuIds(batchMenu({ ...all, canMoveBoard: false })),
      viewer: menuIds(
        batchMenu({ canEdit: false, canMoveGroup: false, canMoveBoard: false, canCreate: false, canDelete: false }),
      ),
    }).toMatchSnapshot();
    // the hierarchy moves sit right after "to board", as the same submenu as the row's.
    const tree = menuIds(batchMenu({ ...all, tree: { under: true, up: true } }));
    expect(tree.slice(tree.indexOf('move_to_board') + 1, tree.indexOf('move_to_board') + 4)).toEqual([
      'move_in_tree▸',
      'move_in_tree>move_under',
      'move_in_tree>move_up',
    ]);
  });

  it('cell', () => {
    expect({
      editable: menuIds(cellMenu({ editable: true, hasValue: true, link: false })),
      editableEmpty: menuIds(cellMenu({ editable: true, hasValue: false, link: false })),
      link: menuIds(cellMenu({ editable: true, hasValue: true, link: true })),
      readOnly: menuIds(cellMenu({ editable: false, hasValue: true, link: false })),
    }).toMatchSnapshot();
    // a row's cells offer "move to item" too, last.
    expect(
      menuIds(cellMenu({ editable: true, hasValue: true, link: false, tree: { under: true, up: false } })).slice(-2),
    ).toEqual(['move_in_tree▸', 'move_in_tree>move_under']);
  });

  it('update', () => {
    expect({
      author: menuIds(updateMenu({ canReply: true, isAuthor: true, canDelete: true })),
      boardOwner: menuIds(updateMenu({ canReply: true, isAuthor: false, canDelete: true })),
      reader: menuIds(updateMenu({ canReply: false, isAuthor: false, canDelete: false })),
    }).toMatchSnapshot();
    // a secret update has no "copy text" (its text is sealed); the rest stays.
    expect(menuIds(updateMenu({ canReply: true, isAuthor: false, canDelete: true, secret: true }))).toEqual(
      menuIds(updateMenu({ canReply: true, isAuthor: false, canDelete: true })).filter((id) => id !== 'copy_text'),
    );
  });
});
