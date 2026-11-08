// SPDX-License-Identifier: AGPL-3.0-only
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { AccountLogo } from '../admin/AccountLogo';
import { Link, useParams, useRouterState } from '@tanstack/react-router';
import {
  appNavPlace,
  NAV_LINK_SLOTS,
  NAV_SLOTS,
  t,
  type ExtensionAppPage,
  type MessageKey,
  type NavPlace,
  type NavSlot,
} from '@bines/shared';
import { cn, useLayer } from '@bines/ui';
import type { Me, MyAccount } from '../../lib/api';
import { useNavLayout } from '../../lib/nav-layout';
import { useRail, useSidebarTone } from '../../lib/theme';
import { PageTitleHost } from '../../lib/branding';
import { syncAppearance } from '../../lib/appearance';
import { useDesktop } from '../../lib/use-desktop';
import { Glyph, Icon, type IconName } from '../../lib/icons';
import { Bell } from '../notifications/Bell';
import { useInboxUnread } from '../search/InboxButton';
import { SearchPalette } from '../search/SearchPalette';
import { ProfileMenu } from './TopBar';
import { Sidebar, useCurrentWorkspace } from './Sidebar';
import { BottomNav, useScreen } from './BottomNav';
import { GuestHome, useGuestWithoutBoards } from './GuestHome';
import { MobileBarSlotContext } from './mobile-bar-slot';
import { HelpMenu } from '../support/HelpMenu';
import { TrialPill } from '../signup/TrialPill';
import { useHelpAccess } from '../support/kb-page';
import { OfflineBanner } from './OfflineBanner';
import { ItemTemplatesHost } from '../item-templates/ItemTemplatesHost';
import { AssistantHost, AssistantLauncher } from '../ai2/GlobalAssistant';
import { AppPageAnnouncer } from '../extensions/AppPage';
import { appPageIcon, appPageKey, appPageLabel, appPageName, badgeText, useAppPages } from '../extensions/app-pages';

/**
 * The account shell (F4, D24): the deep-green shell holds the sidebar, the page sits in one floating panel.
 * Desktop: the sidebar is full (248px) or collapsed to a rail of large icons (remembered per device). Prod
 * each general place (the account's mark, the destinations, search, the assistant, help, the bell) sits
 * in the sidebar or in a top bar across the window — the account's default, or the member's own (GET /me/nav).
 * Full sidebar (canvas option ד): the account with the assistant and the bell, a full-width search field and the
 * destinations as labelled tiles, then the workspace tree, and me (the avatar menu) with help and the collapse
 * toggle at the bottom. Top bar (option א): the account, the destinations as labelled tabs, the search field, the
 * assistant, help and the bell. A place may also be hidden (not on the phone either). The tree and me never move. The sidebar's tone (dark green / light) is the user's
 * choice (`data-sidebar`).
 * Mobile (< 768px): a top bar on the shell (drawer button, the screen's name, search, bell), the five-tab bottom
 * navigation (N1) under the panel, and the sidebar as a drawer. Exactly one search palette and one
 * bell are mounted (they own Ctrl+B and the live stream), so the two layouts are rendered, not just hidden.
 */

type NavKey = 'home' | 'myWork' | 'inbox' | 'automations' | 'flows' | 'agents' | 'help';
type NavTo =
  | '/a/$accountSlug'
  | '/a/$accountSlug/my-work'
  | '/a/$accountSlug/inbox'
  | '/a/$accountSlug/automations'
  | '/a/$accountSlug/flows'
  | '/a/$accountSlug/agents'
  | '/a/$accountSlug/help';
/**
 * `label`: the name when it is not `nav.<key>`; `makers`: admins and members only (not viewers, not guests);
 * `listOnly`: only in the phone drawer's list (the desktop bar has the "?" menu for it); `help`: only while the
 * knowledge center is on for this person.
 */
const NAV: {
  key: NavKey;
  /** Its place in the sidebar / top bar layout (help has none: on the desktop it is the "?" menu). */
  slot?: NavSlot;
  to: NavTo;
  testId?: string;
  icon: IconName;
  exact?: boolean;
  label?: MessageKey;
  makers?: boolean;
  listOnly?: boolean;
  help?: boolean;
}[] = [
  {
    key: 'home',
    slot: 'home',
    to: '/a/$accountSlug',
    exact: true,
    icon: 'home',
  },
  {
    key: 'myWork',
    slot: 'my_work',
    to: '/a/$accountSlug/my-work',
    testId: 'nav-my-work',
    icon: 'myWork',
  },
  {
    key: 'inbox',
    slot: 'inbox',
    to: '/a/$accountSlug/inbox',
    testId: 'nav-inbox',
    icon: 'inbox',
  },
  {
    key: 'automations',
    slot: 'automations',
    to: '/a/$accountSlug/automations',
    testId: 'nav-automations',
    icon: 'bolt',
  },
  {
    // External flows: admins and members — viewers and guests are sent home from it.
    key: 'flows',
    slot: 'flows',
    to: '/a/$accountSlug/flows',
    testId: 'nav-flows',
    label: 'flows.title' as MessageKey,
    makers: true,
    icon: 'flow',
  },
  {
    // Agents (AGENTS-MCP §6): admins and members — guests and viewers never see it.
    key: 'agents',
    slot: 'agents',
    to: '/a/$accountSlug/agents',
    testId: 'nav-agents',
    makers: true,
    icon: 'agent',
  },
  {
    // The knowledge center's page; on the desktop it is the first item of the "?" menu.
    key: 'help',
    to: '/a/$accountSlug/help',
    testId: 'nav-help',
    label: 'kb.title' as MessageKey,
    listOnly: true,
    help: true,
    icon: 'book',
  },
];

/** Product-tour anchors (`data-tour`) of the destinations a tour points at. */
const NAV_TOUR: Partial<Record<NavKey, string>> = { home: 'nav.home', myWork: 'nav.my-work', inbox: 'nav.inbox' };

/** The account's logo (Administration → כללי), or its first letter on the accent tile. */
const AccountMark = ({ account, size = 30 }: { account: MyAccount; size?: number }) => (
  <AccountLogo account={account} size={size} />
);

const Badge = ({ n, className, testId }: { n: number; className?: string; testId?: string }) =>
  n ? (
    <span
      data-testid={testId}
      className={cn(
        'grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-bold text-on-accent',
        className,
      )}
    >
      {n > 99 ? '99+' : n}
    </span>
  ) : null;

/** The destinations this person may open (makers-only ones, the knowledge center while it is on). */
const useShownNav = (account: MyAccount, list: boolean) => {
  const { hidden: noHelp, helpOn } = useHelpAccess(account);
  return NAV.filter(
    (n) =>
      (!n.makers || account.role === 'admin' || account.role === 'member') &&
      (!n.listOnly || list) &&
      (!n.help || (!noHelp && helpOn)),
  );
};

/**
 * The general destinations. `list` = labelled rows (the phone drawer), `rail` = large icons (collapsed rail),
 * `tiles` = labelled tiles, three a row, in the full sidebar (canvas option ד), `tabs` = labelled tabs in the top
 * bar (option א). `slots` = only the destinations placed there. The rail names the link for screen
 * readers and shows the name as a tooltip.
 */
const NavLinks = ({
  account,
  unread,
  mode,
  slots,
  noHelp = false,
  apps = [],
}: {
  account: MyAccount;
  unread: number;
  mode: 'list' | 'rail' | 'tiles' | 'tabs';
  slots?: readonly NavSlot[];
  /** The phone list without the knowledge center (help is hidden). */
  noHelp?: boolean;
  /** the extensions' pages placed here, after the destinations. */
  apps?: ExtensionAppPage[];
}) => {
  const iconOnly = mode === 'rail';
  const shown = useShownNav(account, mode === 'list').filter((n) =>
    n.slot ? !slots || slots.includes(n.slot) : !(noHelp && n.key === 'help'),
  );
  if (!shown.length && !apps.length) return null;
  return (
    <nav
      aria-label={mode === 'tabs' ? t('nav.top') : t('nav.menu')}
      data-testid={mode === 'tabs' ? 'top-nav' : mode === 'tiles' ? 'sidebar-tiles' : undefined}
      className={cn(
        mode === 'rail' && 'flex flex-col items-center gap-1',
        mode === 'tiles' && 'mx-3 mb-3 grid grid-cols-3 gap-1',
        mode === 'tabs' && 'flex min-w-0 items-center gap-0.5',
        mode === 'list' && 'flex flex-col gap-0.5',
      )}
    >
      {shown.map((n) => {
        const label = t(n.label ?? (`nav.${n.key}` as MessageKey));
        const count = n.key === 'inbox' ? unread : 0;
        return (
          <Link
            key={n.key}
            to={n.to}
            params={{ accountSlug: account.slug }}
            activeOptions={{ exact: !!n.exact }}
            data-testid={n.testId ?? `nav-${n.key}`}
            data-tour={NAV_TOUR[n.key]}
            aria-label={iconOnly ? label : undefined}
            title={iconOnly ? label : undefined}
            className={cn(
              'relative flex items-center text-shell-fg hover:bg-[var(--shell-hover)] hover:text-shell-strong focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
              mode === 'rail' && 'size-12 justify-center rounded-[14px]',
              mode === 'tiles' &&
                'h-[3.375rem] min-w-0 flex-col justify-center gap-[0.3125rem] rounded-[10px] px-1 text-[0.71875rem]',
              mode === 'tabs' && 'h-9 shrink-0 gap-2 rounded-[10px] px-3 text-sm',
              mode === 'list' && 'h-8 gap-2.5 rounded-[10px] px-2.5 text-sm',
            )}
            activeProps={{ className: '!bg-[var(--shell-active)] !text-shell-strong' }}
          >
            <Icon name={n.icon} size={mode === 'rail' ? 24 : mode === 'tiles' ? 19 : mode === 'tabs' ? 17 : 16} />
            {iconOnly ? (
              <Badge
                n={count}
                testId={n.key === 'inbox' ? 'inbox-count' : undefined}
                className="absolute -top-0.5 -end-0.5 border-2 border-shell"
              />
            ) : mode === 'tiles' ? (
              <>
                <span className="line-clamp-2 max-w-full text-center leading-[1.15]">{label}</span>
                {/* Beside the icon's top corner, toward the end. */}
                <Badge
                  n={count}
                  testId={n.key === 'inbox' ? 'inbox-count' : undefined}
                  className="absolute top-1 start-1/2 ms-1.5 h-4 min-w-4 border-2 border-shell text-[0.6875rem]"
                />
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate">{label}</span>
                <Badge n={count} testId={n.key === 'inbox' ? 'inbox-count' : undefined} />
              </>
            )}
          </Link>
        );
      })}
      {apps.map((p) => (
        <AppPageLink key={appPageKey(p)} account={account} page={p} mode={mode} />
      ))}
    </nav>
  );
};

/**
 * an extension's page in the sidebar / top bar / phone list — its icon and name like the destinations
 * and its count in a chip (weight 400). The count is in the link's name ("Conversations, 3 unread") — the chip itself
 * is hidden from screen readers, so nothing is said twice and nothing rests on its colour.
 */
const AppPageLink = ({
  account,
  page,
  mode,
}: {
  account: MyAccount;
  page: ExtensionAppPage;
  mode: 'list' | 'rail' | 'tiles' | 'tabs';
}) => {
  const name = appPageName(page);
  const label = appPageLabel(page);
  const count = badgeText(page.badge);
  const chip = (className?: string) =>
    count ? (
      <span
        aria-hidden
        data-testid="app-page-count"
        className={cn(
          'grid h-[1.125rem] min-w-[1.125rem] place-items-center rounded-full bg-accent px-1 text-[0.6875rem] font-normal text-on-accent',
          className,
        )}
      >
        {count}
      </span>
    ) : null;
  return (
    <Link
      to="/a/$accountSlug/apps/$extensionKey/$featureKey"
      params={{ accountSlug: account.slug, extensionKey: page.extension_key, featureKey: page.feature }}
      data-testid="nav-app-page"
      data-app-page={appPageKey(page)}
      aria-label={label === name && mode !== 'rail' ? undefined : label}
      title={mode === 'rail' ? label : undefined}
      className={cn(
        'relative flex items-center text-shell-fg hover:bg-[var(--shell-hover)] hover:text-shell-strong focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
        mode === 'rail' && 'size-12 justify-center rounded-[14px]',
        mode === 'tiles' &&
          'h-[3.375rem] min-w-0 flex-col justify-center gap-[0.3125rem] rounded-[10px] px-1 text-[0.71875rem]',
        mode === 'tabs' && 'h-9 shrink-0 gap-2 rounded-[10px] px-3 text-sm',
        mode === 'list' && 'h-8 gap-2.5 rounded-[10px] px-2.5 text-sm',
      )}
      activeProps={{ className: '!bg-[var(--shell-active)] !text-shell-strong' }}
    >
      <Icon name={appPageIcon(page)} size={mode === 'rail' ? 24 : mode === 'tiles' ? 19 : mode === 'tabs' ? 17 : 16} />
      {mode === 'rail' ? (
        chip('absolute -top-0.5 -end-0.5 border-2 border-shell')
      ) : mode === 'tiles' ? (
        <>
          <span className="line-clamp-2 max-w-full text-center leading-[1.15]">{name}</span>
          {chip('absolute top-1 start-1/2 ms-1.5 h-4 min-w-4 border-2 border-shell text-[0.6875rem]')}
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {chip()}
        </>
      )}
    </Link>
  );
};

const CollapseButton = ({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) => {
  const label = collapsed ? t('sidebar.expand') : t('sidebar.collapse');
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-expanded={!collapsed}
      title={label}
      data-testid="sidebar-collapse"
      className={cn(
        'grid shrink-0 place-items-center text-shell-muted hover:bg-[var(--shell-hover)] hover:text-shell-strong focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
        collapsed ? 'size-12 rounded-[14px]' : 'size-8 rounded-[8px]',
      )}
    >
      {/* Panel-with-arrow: points into the content when open (RTL: the sidebar is on the right). */}
      <Glyph
        size={collapsed ? 22 : 18}
        parts={[
          ['b', <rect x="3" y="4" width="18" height="16" rx="3" />],
          ['k', <path d="M15 4v16" />],
          ['k*', <path d={collapsed ? 'M10 10l-2 2 2 2' : 'M8 10l2 2-2 2'} />],
        ]}
      />
    </button>
  );
};

/** The workspace's letter on the rail button; re-mounted (re-read) after the flyout closes, in case it switched. */
const WorkspaceMark = ({ accountId }: { accountId: string }) => {
  const ws = useCurrentWorkspace(accountId);
  return (
    <span
      aria-hidden
      className="grid size-[1.875rem] place-items-center rounded-[9px] bg-accent text-[0.875rem] font-bold text-on-accent"
    >
      {(ws?.name ?? t('nav.workspace')).trim().charAt(0)}
    </span>
  );
};

/**
 * Collapsed rail (fix1): the workspace and its boards stay one click away — a button with the workspace's letter
 * opens a flyout beside the rail holding the full sidebar tree (switcher, folders, boards, their menus). Choosing a
 * board navigates and closes it; so do Esc and a press outside (the shared layer stack; a dialog opened from the
 * tree counts as inside).
 */
const RailBoards = ({ account }: { account: MyAccount }) => {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const [openAt, setOpenAt] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  const open = openAt === path; // navigating anywhere closes it
  const panel = useRef<HTMLElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const label = t('nav.workspace');
  const close = (refocus = false) => {
    setOpenAt(null);
    setEpoch((n) => n + 1);
    if (refocus) button.current?.focus();
  };
  useEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);
  // A shared layer (round 9): a press anywhere outside closes it and still does its own thing (no overlay swallowing
  // it); a press inside closes only a tree menu open above it, and one in a dialog opened from the tree counts as
  // inside. Esc in an inline rename field stays with the field.
  useLayer(
    panel,
    open,
    () => close(),
    () => {
      if ((document.activeElement as HTMLElement | null)?.matches('input, textarea')) return false;
      close(true);
    },
    () => button.current,
  );
  return (
    <>
      <button
        ref={button}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="rail-boards"
        data-tour="nav.boards"
        onClick={() => (open ? close() : setOpenAt(path))}
        className={cn(
          'grid size-12 place-items-center rounded-[14px] hover:bg-[var(--shell-hover)] focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]',
          open && 'bg-[var(--shell-active)]',
        )}
      >
        <WorkspaceMark key={epoch} accountId={account.id} />
      </button>
      {open ? (
        <aside
          ref={panel}
          tabIndex={-1}
          aria-label={label}
          data-testid="rail-boards-panel"
          onClick={(e) => {
            // The open board too (same path): the choice is made, the flyout goes.
            if ((e.target as HTMLElement).closest('[data-testid="board-row"] a')) close();
          }}
          className="anim-from-start shell-scroll fixed top-[calc(var(--shell-top,0px)+0.75rem)] bottom-3 start-[80px] z-flyout flex w-[264px] flex-col rounded-[16px] bg-shell pt-3 shadow-[var(--shadow-pop)] ring-1 ring-[var(--shell-line)] outline-none"
        >
          <Sidebar account={account} />
        </aside>
      ) : null}
    </>
  );
};

export const AppShell = ({ me, account, children }: { me: Me; account: MyAccount; children: ReactNode }) => {
  const desktop = useDesktop();
  const [collapsed, toggleRail] = useRail();
  const [tone] = useSidebarTone();
  const unread = useInboxUnread(account);
  const path = useRouterState({ select: (s) => s.location.pathname });
  // The drawer remembers the page it was opened on, so navigating anywhere closes it.
  const [drawerAt, setDrawerAt] = useState<string | null>(null);
  const drawer = drawerAt === path;
  const setDrawer = (open: boolean) => setDrawerAt(open ? path : null);
  const role = t(`role.${account.role}` as MessageKey);
  const screen = useScreen(account);
  // A guest nothing is shared with yet (fix4): signed in, no workspace tree, and home says so.
  const noBoards = useGuestWithoutBoards(account);
  const home = path.replace(/\/+$/, '') === `/a/${account.slug}`;
  // Round 13: the user's text size and table density from the server (every device; this one may keep its own).
  const userId = me.user.id;
  const accountId = account.id;
  useEffect(() => {
    void syncAppearance(accountId);
  }, [userId, accountId]);
  // what sits in the sidebar and what in the top bar (desktop only).
  const { layout } = useNavLayout(accountId);
  const onTop = (s: NavSlot) => layout[s] === 'top';
  const inSide = (s: NavSlot) => layout[s] === 'side';
  // the extensions' pages, placed like the destinations (the sidebar unless someone chose otherwise).
  const appPages = useAppPages(accountId).data?.data ?? [];
  const appsAt = (place: NavPlace) => appPages.filter((p) => appNavPlace(layout, appPageKey(p)) === place);
  const topApps = appsAt('top');
  const sideApps = appsAt('side');
  const shownApps = appPages.filter((p) => appNavPlace(layout, appPageKey(p)) !== 'hidden');
  const hasTop = NAV_SLOTS.some(onTop) || topApps.length > 0;
  const topLinks = NAV_LINK_SLOTS.filter(onTop);
  const sideLinks = NAV_LINK_SLOTS.filter(inSide);
  // A hidden place shows nowhere — not on the phone either (its page stays reachable by link).
  const shown = (s: NavSlot) => layout[s] !== 'hidden';
  const shownLinks = NAV_LINK_SLOTS.filter(shown);

  // The board's phone bar is portaled into the top bar (mobile-bar-slot.ts).
  const params = useParams({ strict: false }) as { boardId?: string; itemId?: string };
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  const contentRoot = useCallback(() => document.getElementById('main-content'), []);
  // Prod (WCAG 2.4.1 / 2.4.2): "skip to the content" first in the tab order, and a tab title per screen.
  const skip = (
    <a
      href="#main-content"
      data-testid="skip-to-content"
      className="sr-only z-system rounded-[10px] bg-surface px-4 py-2 text-sm text-heading shadow-[var(--shadow-pop)] focus:not-sr-only focus:fixed focus:start-3 focus:top-3 focus:outline-2 focus:outline-[var(--focus-ring)]"
    >
      {t('a11y.skipToContent')}
    </a>
  );
  const panel = (
    <main
      id="main-content"
      tabIndex={-1}
      className={cn('flex min-h-0 min-w-0 flex-1 p-2 pt-0 outline-none md:p-3 md:ps-0', desktop && hasTop && 'md:pt-0')}
    >
      <PageTitleHost root={contentRoot} />
      <div className="app-panel flex min-h-0 min-w-0 flex-1 flex-col overflow-auto">
        <OfflineBanner />
        {noBoards && home ? <GuestHome account={account} /> : children}
      </div>
    </main>
  );

  if (!desktop) {
    // Prod fix (mobilehead): a board's compact bar takes the title's place (never over an open item card).
    const boardBar = !!params.boardId && !params.itemId;
    return (
      <div className="flex h-dvh flex-col bg-shell" data-sidebar={tone}>
        {skip}
        {/* The shell's layer (`z-shell`, layers.css): over the page, under an item card or any other panel. */}
        <header
          data-shell-bar
          className="relative z-shell flex h-14 shrink-0 items-center gap-1 px-2 text-shell-strong"
        >
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label={t('nav.menu')}
            aria-expanded={drawer}
            data-testid="nav-drawer-open"
            className="grid size-10 place-items-center rounded-[10px] hover:bg-[var(--shell-hover)]"
          >
            <Icon name="menu" size={20} />
          </button>
          {/* The current screen's name in the centre (canvas `.mtop .ttl`); the "אני" tab holds the profile. */}
          {/* On a board the title gives way to the board's bar once it is portaled in (`data-board-bar`). */}
          <div className="flex min-w-0 flex-1 items-center [&:has([data-board-bar])>p]:hidden">
            <p
              data-testid="mobile-title"
              className="min-w-0 flex-1 truncate text-center font-display text-[1.0625rem] font-extrabold"
            >
              {screen.title}
            </p>
            {boardBar ? <div ref={setBarSlot} data-testid="mobile-bar-slot" className="contents" /> : null}
          </div>
          <div className="flex items-center">
            {/* On a board the bar has its own search icon — one search icon in the bar, not two side by side. */}
            {boardBar || !shown('search') ? null : <SearchPalette account={account} variant="icon" />}
            {shown('assistant') ? <AssistantLauncher account={account} variant="header" /> : null}
            {shown('help') ? <HelpMenu account={account} /> : null}
            {shown('bell') ? <Bell account={account} align="end" /> : null}
          </div>
        </header>
        <MobileBarSlotContext.Provider value={boardBar ? barSlot : null}>{panel}</MobileBarSlotContext.Provider>
        <BottomNav account={account} unread={unread} tab={screen.tab} />
        <AssistantHost account={account} />
        <ItemTemplatesHost account={account} />
        <AppPageAnnouncer accountId={account.id} />
        {drawer ? (
          <div className="anim-scrim fixed inset-0 z-panel flex bg-[var(--scrim)]" onMouseDown={() => setDrawer(false)}>
            <aside
              aria-label={t('nav.menu')}
              onMouseDown={(e) => e.stopPropagation()}
              className="anim-from-start flex h-full w-[min(300px,86vw)] flex-col bg-shell pt-3 shadow-[var(--shadow-panel)]"
            >
              <div className="flex items-center justify-between px-3 pb-3">
                <div className="flex min-w-0 items-center gap-2.5 text-shell-strong">
                  <AccountMark account={account} />
                  <div className="min-w-0">
                    <p className="truncate font-display text-base font-extrabold">{account.name}</p>
                    <p className="text-xs text-shell-muted">{role}</p>
                    <TrialPill account={account} className="mt-1.5" />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setDrawer(false)}
                  aria-label={t('nav.closeMenu')}
                  className="grid size-10 place-items-center rounded-[10px] text-shell-fg hover:bg-[var(--shell-hover)]"
                >
                  <Icon name="x" size={20} />
                </button>
              </div>
              <div className="px-3 pb-2">
                <NavLinks
                  account={account}
                  unread={unread}
                  mode="list"
                  slots={shownLinks}
                  noHelp={!shown('help')}
                  apps={shownApps}
                />
              </div>
              <Sidebar account={account} />
            </aside>
          </div>
        ) : null}
      </div>
    );
  }

  const accountName = (
    <span className="min-w-0">
      <span className="block truncate font-display text-base font-extrabold">{account.name}</span>
      <span className="block text-xs text-shell-muted">{role}</span>
    </span>
  );
  const railLine = <span aria-hidden className="my-1.5 h-px w-8 bg-[var(--shell-line)]" />;

  // The top bar (canvas option א), across the window above the sidebar and the panel.
  const topTools = onTop('assistant') || onTop('help') || onTop('bell');
  const topBar = hasTop ? (
    <header
      data-testid="top-bar"
      data-shell-bar
      className="relative z-shell flex h-[3.75rem] shrink-0 items-center gap-1.5 pe-3.5 text-shell-strong"
    >
      {onTop('account') ? (
        <Link
          to="/a/$accountSlug"
          params={{ accountSlug: account.slug }}
          data-testid="top-bar-account"
          data-tour="nav.account"
          aria-label={collapsed ? account.name : undefined}
          title={collapsed ? `${account.name} · ${role}` : undefined}
          className={cn(
            'flex h-full w-[var(--sidebar-w)] shrink-0 items-center gap-2.5',
            collapsed ? 'justify-center' : 'px-5',
          )}
        >
          <AccountMark account={account} size={collapsed ? 36 : 30} />
          {collapsed ? null : accountName}
        </Link>
      ) : (
        <span aria-hidden className="w-3 shrink-0" />
      )}
      <NavLinks account={account} unread={unread} mode="tabs" slots={topLinks} apps={topApps} />
      <div className="flex-1" />
      {onTop('search') ? (
        <SearchPalette account={account} variant="field" className="mb-0 h-9 w-[16.25rem] shrink-0" />
      ) : null}
      {onTop('search') && topTools ? <span aria-hidden className="mx-1.5 h-6 w-px bg-[var(--shell-line)]" /> : null}
      {onTop('assistant') ? <AssistantLauncher account={account} variant="icon" className="size-9" /> : null}
      {onTop('help') ? <HelpMenu account={account} className="size-9 rounded-[10px]" /> : null}
      {onTop('bell') ? <Bell account={account} align="end" className="size-9" /> : null}
    </header>
  ) : null;

  // The full sidebar's head (canvas option ד): the account with the assistant and the bell, search, the tiles.
  const sideHead = inSide('account') || inSide('assistant') || inSide('bell');
  const sideTools = sideHead || inSide('search') || sideLinks.length > 0 || sideApps.length > 0;

  return (
    <div
      className="flex h-dvh flex-col bg-shell"
      data-sidebar={tone}
      // `--shell-top`: the top bar's height (none = 0) — fixed surfaces of the shell start under it, never under it.
      style={
        { '--sidebar-w': collapsed ? '76px' : '248px', '--shell-top': hasTop ? '3.75rem' : '0px' } as CSSProperties
      }
    >
      {skip}
      {topBar}
      <div className="flex min-h-0 flex-1">
        {collapsed ? (
          <aside
            aria-label={t('nav.menu')}
            data-tour="nav.sidebar"
            className={cn(
              'relative flex w-[4.75rem] shrink-0 flex-col items-center gap-1 pb-3',
              hasTop ? 'pt-1' : 'pt-3',
            )}
          >
            {inSide('account') ? (
              <>
                <Link
                  to="/a/$accountSlug"
                  params={{ accountSlug: account.slug }}
                  aria-label={account.name}
                  title={`${account.name} · ${role}`}
                  data-tour="nav.account"
                  className="mb-1 grid size-12 place-items-center"
                >
                  <AccountMark account={account} size={36} />
                </Link>
                {railLine}
              </>
            ) : null}
            <NavLinks account={account} unread={unread} mode="rail" slots={sideLinks} apps={sideApps} />
            {inSide('search') ? <SearchPalette account={account} variant="rail" /> : null}
            {inSide('assistant') ? <AssistantLauncher account={account} variant="rail" /> : null}
            {inSide('help') ? <HelpMenu account={account} /> : null}
            {inSide('bell') ? <Bell account={account} align="start" rail /> : null}
            {noBoards ? null : (
              <>
                {sideTools || inSide('help') ? railLine : null}
                <RailBoards account={account} />
              </>
            )}
            <div className="flex-1" />
            <ProfileMenu me={me} current={account} align="start" placement="top" size={34} />
            <CollapseButton collapsed onClick={toggleRail} />
          </aside>
        ) : (
          <aside
            aria-label={t('nav.menu')}
            data-tour="nav.sidebar"
            className={cn('relative flex w-[248px] shrink-0 flex-col', hasTop ? 'pt-1' : 'pt-4')}
          >
            {sideTools ? (
              <div data-testid="sidebar-quick" className="flex flex-col">
                {sideHead ? (
                  <div className="mx-3 mb-3 flex min-w-0 items-center gap-1 ps-2">
                    {inSide('account') ? (
                      <Link
                        to="/a/$accountSlug"
                        params={{ accountSlug: account.slug }}
                        data-tour="nav.account"
                        className="flex min-w-0 flex-1 items-center gap-2.5 text-shell-strong"
                      >
                        <AccountMark account={account} />
                        {accountName}
                      </Link>
                    ) : (
                      <span className="flex-1" />
                    )}
                    {inSide('assistant') ? (
                      <AssistantLauncher account={account} variant="icon" className="size-[2.125rem]" />
                    ) : null}
                    {inSide('bell') ? <Bell account={account} align="start" className="size-[2.125rem]" /> : null}
                  </div>
                ) : null}
                {/* Self sign-up trials (D32): "N trial days left · upgrade". */}
                <TrialPill account={account} className="mx-5 mb-3 self-start" />
                {inSide('search') ? (
                  <SearchPalette account={account} variant="field" className="mx-3 mb-2.5 h-9 w-auto" />
                ) : null}
                <NavLinks account={account} unread={unread} mode="tiles" slots={sideLinks} apps={sideApps} />
                <span aria-hidden className="mx-5 mb-2.5 h-px bg-[var(--shell-line)]" />
              </div>
            ) : (
              <TrialPill account={account} className="mx-5 mb-3 self-start" />
            )}
            <Sidebar account={account} />
            {/* Me at the bottom: the avatar menu (profile, appearance, settings, sign out), help and the collapse toggle. */}
            <div className="flex items-center gap-0.5 border-t border-[var(--shell-line)] px-3 py-2.5">
              <ProfileMenu me={me} current={account} align="start" placement="top" variant="row" />
              {inSide('help') ? <HelpMenu account={account} className="size-8 rounded-[8px]" /> : null}
              <CollapseButton collapsed={false} onClick={toggleRail} />
            </div>
          </aside>
        )}
        {panel}
      </div>
      <AssistantHost account={account} />
      <ItemTemplatesHost account={account} />
      <AppPageAnnouncer accountId={account.id} />
    </div>
  );
};
