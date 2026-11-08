// SPDX-License-Identifier: AGPL-3.0-only
import { useContext, useState } from 'react';
import { t } from '@bines/shared';
import { Menu, MenuTrigger, useActionMenu, type MenuEntry } from '@bines/ui';
import type { BoardDetail, Column } from '../board-api';
import { BoardAccountContext } from '../board-context';
import { NameSourceDialog } from './NameSourceDialog';

/**
 * The name column header's menu (NAME-API §6.1): "מקור שם הפריט" for those who may change columns — on the main
 * board's header and, separately, on the sub-board's (each board has its own name column and setting).
 */
export const NameHeaderMenu = ({ board, column }: { board: BoardDetail; column: Column }) => {
  const { id: accountId } = useContext(BoardAccountContext);
  const menu = useActionMenu();
  const [open, setOpen] = useState(false);
  if (!board.capabilities['column.update']) return null;
  const label = t('column.actions', { name: column.title });
  const items: MenuEntry[] = [
    { label: t('name.source.menu'), onSelect: () => setOpen(true), testId: 'name-source-menu' },
  ];
  return (
    <>
      <span data-testid="name-header-menu" className="inline-flex">
        <MenuTrigger label={label} onClick={menu.fromTrigger} />
      </span>
      <Menu at={menu.at} onClose={menu.close} items={items} label={label} />
      {open ? <NameSourceDialog accountId={accountId} board={board} onClose={() => setOpen(false)} /> : null}
    </>
  );
};
