// SPDX-License-Identifier: AGPL-3.0-only
import { t, type MyAccount } from '@bines/shared';
import { Sidebar } from './Sidebar';

/**
 * "לוחות" (N1, the phone's fourth tab; works on desktop too): the workspace's tree full-screen — the workspace
 * switcher, folders and boards with their ⋯ menus, and "+" for a new board. Tapping a board opens it.
 */
export const BoardsPage = ({ account }: { account: MyAccount }) => (
  <main data-testid="boards-page" className="mx-auto w-full max-w-[640px] space-y-3 px-4 py-5 md:px-6">
    <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
      {t('nav.boards')}
    </h1>
    <Sidebar account={account} variant="page" />
  </main>
);
