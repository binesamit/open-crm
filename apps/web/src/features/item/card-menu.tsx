// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState, type ReactNode } from 'react';
import { itemMenu, t } from '@bines/shared';
import { type MenuEntry, useActionMenu } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { saveCardWidth, useMyCardWidth } from '../../lib/card-width';
import { confirmDelete, promptDialog } from '../../lib/dialogs';
import { appLink, copyText, toMenuEntries } from '../../lib/entity-menu';
import type { BoardDetail, Item, useBoardMutations } from '../board/board-api';
import { ConvertDialog, MoveDialog } from '../board/MoveDialog';
import { useTreeMove } from '../board/tree-move';
import { openItemTemplates } from '../item-templates/store';
import { BoardAccountContext } from '../board/board-context';
import { useExtensionActions } from '../extensions/ExtensionSlots';
import { showNameComputedToast } from '../board/name-source/name-source-api';
import { InboundAddressDialog, useItemInboundAvailable } from '../inbound-email/InboundAddress';

/**
 * The item's "⋯" in the card header (N10): the same item menu as the table row (`itemMenu` registry, 14 §1) with
 * `inCard` (no "open", no "add below"). Actions that take the item away from here (delete, archive, move,
 * convert) close the card once they are done. `refresh` re-reads the card's item after a rename / group move.
 */
export const useCardItemMenu = ({
  accountId,
  slug,
  board,
  item,
  m,
  refresh,
  close,
  resetWidth = false,
  inboundEmail = false,
}: {
  accountId: string;
  slug: string;
  board: BoardDetail;
  item: Item;
  m: ReturnType<typeof useBoardMutations>;
  refresh: () => void;
  close: () => void;
  /** F9 cardw: offer "reset width" (desktop / tablet, where the card can be resized). */
  resetWidth?: boolean;
  /** may this person use the item's email address (members who may post; the server decides too). */
  inboundEmail?: boolean;
}) => {
  const menu = useActionMenu();
  const [dialog, setDialog] = useState<'move' | 'to_subitem' | 'to_item' | 'email' | null>(null);
  const emailOn = useItemInboundAvailable(accountId, item.id, inboundEmail);
  const emailEntries: MenuEntry[] = emailOn
    ? [
        { kind: 'separator' },
        {
          label: t('inboundEmail.item.toggle'),
          icon: <Icon name="mail" size={16} />,
          testId: 'item-inbound-address',
          onSelect: () => setDialog('email'),
        },
      ]
    : [];
  const rootId = board.parent_board_id ?? board.id;
  const path = `/a/${slug}/b/${rootId}/i/${item.id}`;
  const otherGroups = board.groups.filter((g) => g.id !== item.group_id);
  // "move to item ▸" — the row menu's hook; the card stays open on the item and re-reads it.
  const tree = useTreeMove(accountId, board, m, refresh);
  // Installed extensions' item actions (D27 ת3): a modal frame with this item as context.
  const { meId } = useContext(BoardAccountContext);
  const myWidth = useMyCardWidth();
  const widthEntries: MenuEntry[] = resetWidth
    ? [
        { kind: 'separator' },
        {
          label: t('cardw.reset'),
          icon: <Icon name="expand" size={16} />,
          // Always in place (a menu must not change while open); off while the default width is in use.
          disabled: myWidth === null,
          testId: 'card-width-reset',
          onSelect: () => void saveCardWidth(null, accountId),
        },
      ]
    : [];
  const ext = useExtensionActions({
    accountId,
    boardId: rootId,
    meId,
    where: 'item',
    itemIds: [item.id],
  });

  const rename = async () => {
    const name = await promptDialog({ title: t('menu.rename'), label: t('item.name'), initial: item.name });
    if (name && name !== item.name) m.renameItem.mutate({ itemId: item.id, name }, { onSuccess: refresh });
  };
  const addSubitem = async () => {
    const name = await promptDialog({ title: t('menu.item.addSubitem'), label: t('item.name') });
    if (name) m.createSubitem.mutate({ parentId: item.id, name });
  };

  const entries = toMenuEntries(
    itemMenu({
      caps: board.capabilities,
      hasKey: !!item.key,
      canChangeGroup: otherGroups.length > 0 && item.depth === 0,
      canNest: item.depth + 1 <= board.hierarchy_depth_max,
      isSubitem: item.depth > 0,
      depth: item.depth,
      inCard: true,
    }),
    {
      open_new_tab: () => window.open(appLink(path), '_blank', 'noopener'),
      copy_link: () => copyText(appLink(path)),
      copy_id: () => copyText(item.id),
      copy_key: () => copyText(item.key ?? ''),
      rename: () => (item.name_computed ? showNameComputedToast() : void rename()),
      add_subitem: () => void addSubitem(),
      duplicate: () => m.duplicateItem.mutate({ id: item.id, name: item.name }),
      duplicate_with_updates: () => m.duplicateItem.mutate({ id: item.id, name: item.name, withUpdates: true }),
      // the item (and its subitems) as a template; a template's subitems under it.
      save_as_template: () =>
        openItemTemplates({ kind: 'save', boardId: rootId, itemId: item.id, itemName: item.name }),
      subitems_from_template: () => openItemTemplates({ kind: 'apply', boardId: rootId, parentItemId: item.id }),
      archive: () => m.archiveItem.mutate({ id: item.id, name: item.name }, { onSuccess: close }),
      move_to_board: () => setDialog('move'),
      to_subitem: () => setDialog('to_subitem'),
      to_item: () => setDialog('to_item'),
      ...tree.handlers({ ids: [item.id], name: item.name }),
      delete: () =>
        void confirmDelete(item.name).then(
          (ok) => ok && m.deleteItem.mutate({ id: item.id, name: item.name }, { onSuccess: close }),
        ),
    },
    {
      move_to_group: otherGroups.map((g) => ({
        label: g.title,
        onSelect: () => m.moveItem.mutate({ itemId: item.id, groupId: g.id }, { onSuccess: refresh }),
      })),
    },
  ).concat(emailEntries, ext.entries, widthEntries);

  const dialogs: ReactNode = ext.dialog ? (
    ext.dialog
  ) : tree.dialog ? (
    tree.dialog
  ) : dialog === 'email' ? (
    <InboundAddressDialog accountId={accountId} kind="item" id={item.id} onClose={() => setDialog(null)} />
  ) : dialog === 'move' ? (
    <MoveDialog
      accountId={accountId}
      board={board}
      title={t('move.title', { what: item.name })}
      onClose={() => setDialog(null)}
      onMove={(v) =>
        m.moveItemToBoard
          .mutateAsync({ id: item.id, name: item.name, to: v.board, groupId: v.groupId, mapping: v.mapping })
          .then(close)
      }
    />
  ) : dialog ? (
    <ConvertDialog
      accountId={accountId}
      board={board}
      item={item}
      mode={dialog}
      onClose={() => setDialog(null)}
      onConvert={(v) => m.convertItem.mutateAsync({ id: item.id, name: item.name, ...v }).then(close)}
    />
  ) : null;

  return { menu, entries, label: t('item.actions', { name: item.name }), dialogs };
};
