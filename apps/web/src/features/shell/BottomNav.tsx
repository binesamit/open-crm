// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { appPageName, useAppPages } from '../extensions/app-pages';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import { t, type MessageKey, type MyAccount } from '@bines/shared';
import { cn } from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';
import { useKeyboardOpen } from '../../lib/use-keyboard';
import { useBoard } from '../board/board-api';

/**
 * Phone navigation (N1, canvas `.mnav`): five tabs on the shell under the panel — home, my work, updates (with the
 * unread count), boards and "me". The tab of the current screen is white with an amber icon. Settings-like screens
 * (notifications, tokens, trash, archive, automations) belong to "me"; a board belongs to "boards".
 */
export type TabKey = 'home' | 'my-work' | 'inbox' | 'boards' | 'me';
type TabTo =
  | '/a/$accountSlug'
  | '/a/$accountSlug/my-work'
  | '/a/$accountSlug/inbox'
  | '/a/$accountSlug/boards'
  | '/a/$accountSlug/me';

const icon = (name: IconName) => <Icon name={name} size={21} />;

/** Product-tour anchors (`data-tour`) of the tabs: the phone's twins of the desktop shell's places. */
const TAB_TOUR: Record<TabKey, string> = {
  home: 'nav.home',
  'my-work': 'nav.my-work',
  inbox: 'nav.inbox',
  boards: 'nav.boards',
  me: 'nav.profile',
};

const TABS: { key: TabKey; to: TabTo; label: MessageKey; icon: ReactNode }[] = [
  {
    key: 'home',
    to: '/a/$accountSlug',
    label: 'nav.home',
    icon: icon('home'),
  },
  {
    key: 'my-work',
    to: '/a/$accountSlug/my-work',
    label: 'nav.myWork',
    icon: icon('myWork'),
  },
  {
    key: 'inbox',
    to: '/a/$accountSlug/inbox',
    label: 'nav.updates' as MessageKey,
    icon: icon('inbox'),
  },
  {
    key: 'boards',
    to: '/a/$accountSlug/boards',
    label: 'nav.boards' as MessageKey,
    icon: icon('board'),
  },
  {
    key: 'me',
    to: '/a/$accountSlug/me',
    label: 'nav.me' as MessageKey,
    icon: icon('person'),
  },
];

/** The screen the phone is on: which tab is lit and the name in the top bar's centre (the board's name on a board). */
export const useScreen = (account: MyAccount): { tab: TabKey | null; title: string } => {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const { boardId } = useParams({ strict: false }) as { boardId?: string };
  const board = useBoard(account.id, boardId ?? '');
  const appPages = useAppPages(account.id);
  const base = `/a/${account.slug}`;
  const rest = (path.startsWith(base) ? path.slice(base.length) : path).replace(/\/+$/, '');
  if (boardId) return { tab: 'boards', title: board.data?.name ?? '' };
  const screens: [string, TabKey, MessageKey][] = [
    ['/my-work', 'my-work', 'nav.myWork'],
    ['/inbox', 'inbox', 'nav.inbox'],
    ['/boards', 'boards', 'nav.boards' as MessageKey],
    ['/me', 'me', 'nav.me' as MessageKey],
    ['/profile', 'me', 'profile.mine' as MessageKey],
    ['/settings/notifications', 'me', 'notifications.settings'],
    ['/settings/tokens', 'me', 'tokens.title'],
    ['/trash', 'me', 'trash.title'],
    ['/archive', 'me', 'archive.title'],
    ['/automations', 'me', 'nav.automations'],
    ['/flows', 'me', 'flows.title' as MessageKey],
    ['/help', 'me', 'kb.title' as MessageKey],
  ];
  // an extension's page — its own name.
  const app = /^\/apps\/([^/]+)\/([^/]+)$/.exec(rest);
  const page = app ? appPages.data?.data.find((p) => p.extension_key === app[1] && p.feature === app[2]) : undefined;
  if (app) return { tab: null, title: page ? appPageName(page) : account.name };
  const hit = screens.find(([p]) => rest === p || rest.startsWith(`${p}/`));
  if (hit) return { tab: hit[1], title: t(hit[2]) };
  if (rest === '') return { tab: 'home', title: t('nav.home') };
  return { tab: null, title: account.name };
};

/**
 * The tabs step aside while the on-screen keyboard is open (a field — also one inside an extension's frame — being
 * typed in), so the screen keeps the room and the tabs never ride on top of the keyboard. Read from the viewport
 * shrinking only (`useKeyboardOpen`), never from a focused field alone.
 */
export const BottomNav = ({ account, unread, tab }: { account: MyAccount; unread: number; tab: TabKey | null }) =>
  useKeyboardOpen() ? null : <Tabs account={account} unread={unread} tab={tab} />;

const Tabs = ({ account, unread, tab }: { account: MyAccount; unread: number; tab: TabKey | null }) => (
  <nav
    aria-label={t('nav.bottom')}
    data-testid="bottom-nav"
    // Safe area: the home indicator of a phone never covers the tabs, and the panel above never hides behind them.
    className="flex shrink-0 justify-around bg-shell px-2 pt-1.5 pb-[calc(10px+env(safe-area-inset-bottom))]"
  >
    {TABS.map((n) => {
      const on = n.key === tab;
      return (
        <Link
          key={n.key}
          to={n.to}
          params={{ accountSlug: account.slug }}
          data-testid={`bottom-nav-${n.key}`}
          data-tour={TAB_TOUR[n.key]}
          aria-current={on ? 'page' : undefined}
          className={cn(
            'relative flex h-12 min-w-0 flex-1 flex-col items-center justify-center gap-[0.1875rem] rounded-[12px] text-[0.6875rem] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
            on ? 'font-semibold text-shell-strong [&>svg]:text-accent' : 'text-shell-muted',
          )}
        >
          {n.icon}
          {/* Five equal tabs that always fit the phone's width — also at the largest text size (round 13). */}
          <span className="max-w-full truncate px-0.5">{t(n.label)}</span>
          {n.key === 'inbox' && unread ? (
            <span
              data-testid="bottom-nav-inbox-count"
              className="absolute top-0.5 end-3 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-on-accent"
            >
              {unread > 99 ? '99+' : unread}
            </span>
          ) : null}
        </Link>
      );
    })}
  </nav>
);
