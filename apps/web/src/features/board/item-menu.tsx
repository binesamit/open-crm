// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState, type ReactNode } from 'react';
import { itemMenu, t } from '@bines/shared';
import { useActionMenu, type MenuEntry } from '@bines/ui';
import { useTreeMove } from './tree-move';
import { confirmDelete, promptDialog } from '../../lib/dialogs';
import { appLink, copyText, toMenuEntries } from '../../lib/entity-menu';
import type { BoardDetail, Item, useBoardMutations } from './board-api';
import { openItemTemplates } from '../item-templates/store';
import { BoardAccountContext } from './board-context';
import { useOpenItem } from './open-item';
import { ConvertDialog, MoveDialog } from './MoveDialog';
import { useFollow } from '../notifications/follow';
import { useExtensionActions } from '../extensions/ExtensionSlots';
import { showNameComputedToast } from './name-source/name-source-api';

/**
 * The item menu (14 §1) — one menu for the table row, Kanban/Cards tiles: right click, ⋯ and Shift+F10.
 * `m` = the view's board mutations (one set per board, not per row). `onRename` lets the row rename inline;
 * elsewhere a rename dialog opens.
 */
export const useItemMenu = (
  board: BoardDetail,
  item: Item,
  m: ReturnType<typeof useBoardMutations>,
  onRename?: () => void,
  onAddSubitem?: () => void,
  /**
   * Fix: b — the table is grouped by a column: "move to group" lists the view's sections instead (setting
   * that column's value, like dragging the row there). Null/omitted = the board's groups.
   */
  moveTargets?: MenuEntry[] | null,
  /**
   * the row's section in a view grouped by a column: "add item below" creates the item with that
   * section's value (the section's seed, like its "+ item" row), so it shows right under the row.
   */
  addCells?: Record<string, unknown>,
) => {
  const menu = useActionMenu();
  const { id: accountId, slug, meId } = useContext(BoardAccountContext);
  const [dialog, setDialog] = useState<'move' | 'to_subitem' | 'to_item' | null>(null);
  // A subitem opens over its root board's page (its own board is a hidden sub-board, D14).
  const rootId = board.parent_board_id ?? board.id;
  const open = useOpenItem(rootId);
  const path = `/a/${slug}/b/${rootId}/i/${item.id}`;
  const otherGroups = board.groups.filter((g) => g.id !== item.group_id);
  // Follow state is fetched when the menu opens (D15); the entry appears once it is known.
  const follow = useFollow(accountId, item.id, !!menu.at);
  // "move to item ▸" for this row — the batch bar's hook, with this one row.
  const tree = useTreeMove(accountId, board, m);
  const treeHandlers = tree.handlers({ ids: [item.id], name: item.name });
  // Installed extensions' item actions (D27 ת3), fetched when the menu opens (one list per board, shared).
  const ext = useExtensionActions({
    accountId,
    boardId: rootId,
    meId,
    where: 'item',
    itemIds: [item.id],
    onOpenItem: open,
    enabled: !!menu.at,
  });

  const addSubitem = async () => {
    const name = await promptDialog({ title: t('menu.item.addSubitem'), label: t('item.name') });
    if (name) m.createSubitem.mutate({ parentId: item.id, name });
  };
  const rename = async () => {
    const name = await promptDialog({ title: t('menu.rename'), label: t('item.name'), initial: item.name });
    if (name && name !== item.name) m.renameItem.mutate({ itemId: item.id, name });
  };

  const entries = toMenuEntries(
    itemMenu({
      caps: board.capabilities,
      hasKey: !!item.key,
      canChangeGroup: otherGroups.length > 0 && item.depth === 0,
      canNest: item.depth + 1 <= board.hierarchy_depth_max,
      isSubitem: item.depth > 0,
      depth: item.depth,
      following: follow.following ?? null,
      moveByValue: !!moveTargets,
    }),
    {
      open: () => open(item.id),
      open_new_tab: () => window.open(appLink(path), '_blank', 'noopener'),
      copy_link: () => copyText(appLink(path)),
      copy_id: () => copyText(item.id),
      copy_key: () => copyText(item.key ?? ''),
      follow: () => follow.set.mutate(!follow.following),
      // a computed name is not renamed — say why (the server's item_name_computed) instead.
      rename: item.name_computed ? showNameComputedToast : (onRename ?? (() => void rename())),
      add_subitem: onAddSubitem ?? (() => void addSubitem()),
      // A subitem's sibling is another subitem of the same parent (it has no group).
      add_below: () =>
        item.parent_item_id
          ? m.createSubitem.mutate({ parentId: item.parent_item_id, name: t('item.newName'), afterId: item.id })
          : m.createItem.mutate({
              name: t('item.newName'),
              groupId: item.group_id!,
              afterId: item.id,
              ...(addCells && Object.keys(addCells).length ? { cells: addCells } : {}),
            }),
      duplicate: () => m.duplicateItem.mutate({ id: item.id, name: item.name }),
      duplicate_with_updates: () => m.duplicateItem.mutate({ id: item.id, name: item.name, withUpdates: true }),
      // the item (and its subitems) as a template; a template's subitems under it.
      save_as_template: () =>
        openItemTemplates({ kind: 'save', boardId: rootId, itemId: item.id, itemName: item.name }),
      subitems_from_template: () => openItemTemplates({ kind: 'apply', boardId: rootId, parentItemId: item.id }),
      archive: () => m.archiveItem.mutate({ id: item.id, name: item.name }),
      move_to_board: () => setDialog('move'),
      to_subitem: () => setDialog('to_subitem'),
      to_item: () => setDialog('to_item'),
      ...treeHandlers,
      delete: () =>
        void confirmDelete(item.name).then((ok) => ok && m.deleteItem.mutate({ id: item.id, name: item.name })),
    },
    {
      move_to_group:
        moveTargets ??
        otherGroups.map((g) => ({
          label: g.title,
          onSelect: () => m.moveItem.mutate({ itemId: item.id, groupId: g.id }),
        })),
    },
  ).concat(ext.entries);
  const dialogs: ReactNode = ext.dialog ? (
    ext.dialog
  ) : tree.dialog ? (
    tree.dialog
  ) : dialog === 'move' ? (
    <MoveDialog
      accountId={accountId}
      board={board}
      title={t('move.title', { what: item.name })}
      onClose={() => setDialog(null)}
      onMove={(v) =>
        m.moveItemToBoard.mutateAsync({
          id: item.id,
          name: item.name,
          to: v.board,
          groupId: v.groupId,
          mapping: v.mapping,
        })
      }
    />
  ) : dialog ? (
    <ConvertDialog
      accountId={accountId}
      board={board}
      item={item}
      mode={dialog}
      onClose={() => setDialog(null)}
      onConvert={(v) => m.convertItem.mutateAsync({ id: item.id, name: item.name, ...v })}
    />
  ) : null;
  return { menu, entries, label: t('item.actions', { name: item.name }), dialogs, tree: { ...tree, treeHandlers } };
};
