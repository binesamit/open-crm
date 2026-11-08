// SPDX-License-Identifier: AGPL-3.0-only
import { t } from '@bines/shared';
import { EmptyState } from '@bines/ui';
import type { MyAccount } from '../../lib/api';
import { Icon } from '../../lib/icons';
import { useWorkspaces } from '../board/board-api';

/**
 * A guest sees only the boards shared with them (05 §4) — the workspaces list holds just the workspaces of those
 * boards. True once it is known that there are none (fix4): the guest still signs in, the sidebar shows no tree and
 * home says nothing is shared yet.
 */
export const useGuestWithoutBoards = (account: MyAccount) => {
  const workspaces = useWorkspaces(account.id);
  return account.role === 'guest' && workspaces.isSuccess && !workspaces.data.data.length;
};

const SharedIcon = () => <Icon name="board" size={30} />;

/** Home of a guest nothing is shared with yet: who to ask instead of an empty account page. */
export const GuestHome = ({ account }: { account: MyAccount }) => (
  <main data-testid="guest-home" className="flex flex-1 items-center justify-center px-4 py-5 md:px-6">
    <EmptyState testId="guest-no-boards" icon={<SharedIcon />} title={t('guest.noBoards.title')}>
      {t('guest.noBoards.body', { account: account.name })}
    </EmptyState>
  </main>
);
