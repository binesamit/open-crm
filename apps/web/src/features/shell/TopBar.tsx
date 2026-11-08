// SPDX-License-Identifier: AGPL-3.0-only
import { usePalette } from '../../lib/theme';
import { PaletteSwatch } from '../account/PalettePicker';
import { Link, useNavigate } from '@tanstack/react-router';
import { t, type MessageKey } from '@bines/shared';
import { Avatar, cn, Menu, PALETTES, useActionMenu, type MenuEntry } from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';
import type { Me, MyAccount } from '../../lib/api';
import { AccountLogo } from '../admin/AccountLogo';
import { legalHref, useLegalDocs } from '../legal/legal-links';
import { useUnreadErrorAlerts } from '../owner/errors/ErrorCount';
import { PHOTO_ACCEPT, SIDEBAR_TONES, THEMES, useProfile } from './use-profile';

/**
 * Top bar for the screens outside an account (account picker, owner console): the brand on the shell, the avatar
 * menu at the end. Inside an account the same menu sits at the top of the sidebar (AppShell).
 */
export const TopBar = ({ me, current }: { me: Me; current?: MyAccount }) => (
  <header
    data-shell-bar
    className="relative z-shell flex h-14 shrink-0 items-center justify-between px-4 text-shell-strong"
  >
    <Link to="/" className="flex items-center gap-2.5">
      <span className="grid size-8 place-items-center rounded-full bg-accent font-display text-base font-extrabold text-on-accent">
        {(current?.name ?? t('app.name')).trim().charAt(0).toUpperCase()}
      </span>
      <span className="font-display text-[1.0625rem] font-extrabold">{current?.name ?? t('app.name')}</span>
    </Link>
    <ProfileMenu me={me} current={current} align="end" />
  </header>
);

/**
 * The avatar and its menu (the shared `Menu`, round 9 — it closes on any press outside it, like every menu):
 * "הפרופיל שלי" (fix5: my details, notification settings, API tokens and appearance), "תמונת פרופיל" (a submenu:
 * upload / remove — round 9), "מראה" (a submenu: light / dark / system, and the sidebar's tone inside an account —
 * the same store as the profile page's appearance tab), the account switcher (D12; only with more than one
 * account), administration, trash and archive, the owner console and sign-out.
 * `align` = the edge the menu opens from; `placement="top"` opens it upwards (the sidebar's bottom, fix4).
 * `variant="row"` = the avatar with my name (the full sidebar's bottom). Guests get no trash / archive links (the
 * server refuses trash to guests).
 */
export const ProfileMenu = ({
  me,
  current,
  align,
  size = 32,
  box,
  placement = 'bottom',
  variant = 'avatar',
}: {
  me: Me;
  current?: MyAccount;
  align: 'start' | 'end';
  placement?: 'top' | 'bottom';
  variant?: 'avatar' | 'row';
  size?: number;
  /** A square hit area around the avatar (the sidebar header: a 24px avatar in a 32px button). */
  box?: number;
}) => {
  const menu = useActionMenu();
  const navigate = useNavigate();
  const { theme, chooseTheme, tone, chooseTone, list, switchTo, signOut, fileInput, onFile, photo, displayName } =
    useProfile(me, current);
  const [palette, choosePalette] = usePalette();
  const guest = current?.role === 'guest';
  // Errors hub: no icon in the top bar — the unread error alerts show on the console's entry here and on
  // its "Errors & health" tab. Owner and support staff only (no call for anyone else).
  const errorAlerts = useUnreadErrorAlerts(me);
  const statement = !!useLegalDocs().data?.some((d) => d.slug === 'accessibility');
  const row = variant === 'row';
  const open = !!menu.at;
  const icon = (name: IconName) => <Icon name={name} size={16} />;

  const go = (to: string) => () => {
    if (current) void navigate({ to, params: { accountSlug: current.slug } });
  };

  const appearance: MenuEntry[] = [
    ...THEMES.map((k): MenuEntry => ({
      label: t(`theme.${k}` as MessageKey),
      checked: theme === k,
      onSelect: () => chooseTheme(k),
      // r17ui: appearance choices keep the menu open — try one, compare, then click away.
      keepOpen: true,
      testId: `menu-theme-${k}`,
    })),
    // Round 12: the colour theme (palette).
    { kind: 'separator' },
    { kind: 'label', label: t('r12.palette.title') },
    ...PALETTES.map((p): MenuEntry => ({
      label: t(p.label as MessageKey),
      checked: palette === p.id,
      icon: <PaletteSwatch palette={p} />,
      onSelect: () => choosePalette(p.id),
      keepOpen: true,
      testId: `menu-palette-${p.id}`,
    })),
    // The sidebar's tone (fix4) belongs to the shell inside an account.
    ...(current
      ? ([
          { kind: 'separator' },
          { kind: 'label', label: t('sidebar.tone.title') },
          ...SIDEBAR_TONES.map((k): MenuEntry => ({
            label: t(`theme.${k}` as MessageKey),
            checked: tone === k,
            onSelect: () => chooseTone(k),
            keepOpen: true,
            testId: `menu-sidebar-tone-${k}`,
          })),
        ] satisfies MenuEntry[])
      : []),
  ];

  const photoItems: MenuEntry[] = [
    {
      label: t('profile.photo.upload'),
      icon: icon('upload'),
      disabled: photo.isPending,
      onSelect: () => fileInput.current?.click(),
      testId: 'menu-photo-upload',
    },
    ...(me.user.avatar_url
      ? [
          {
            label: t('profile.photo.remove'),
            icon: icon('x'),
            disabled: photo.isPending,
            onSelect: () => photo.mutate(null),
            testId: 'menu-photo-remove',
          },
        ]
      : []),
  ];

  const items: MenuEntry[] = [
    ...(current
      ? ([
          {
            label: t('profile.mine'),
            icon: icon('person'),
            onSelect: go('/a/$accountSlug/profile'),
            testId: 'menu-my-profile',
          },
          {
            kind: 'submenu',
            label: t('profile.photo'),
            icon: icon('upload'),
            testId: 'menu-photo',
            items: photoItems,
          },
        ] satisfies MenuEntry[])
      : []),
    {
      kind: 'submenu',
      label: t('theme.title'),
      icon: icon(theme === 'dark' ? 'moon' : 'sun'),
      testId: 'menu-appearance',
      items: appearance,
    },
    // "החלפת חשבון" (Fix: , product decision): one item whose submenu lists my accounts — each with its logo, the one
    // I am in marked — instead of every account in the main menu.
    ...(list.length > 1
      ? ([
          { kind: 'separator' },
          {
            kind: 'submenu',
            label: t('account.switcher.title'),
            icon: icon('building'),
            testId: 'menu-switch-account',
            items: list.map((a): MenuEntry => {
              const here = a.id === current?.id;
              return {
                label: a.name,
                icon: <AccountLogo account={a} size={22} />,
                // The current one: a check before its role (a radio row would hide the logo).
                shortcut: `${here ? '✓ ' : ''}${t(`role.${a.role}` as MessageKey)}`,
                onSelect: () => {
                  if (!here) void switchTo(a);
                },
                testId: `menu-account-${a.slug}`,
              };
            }),
          },
        ] satisfies MenuEntry[])
      : []),
    // Guests: no administration, trash or archive (the server refuses them).
    ...(current && !guest
      ? ([
          { kind: 'separator' },
          ...(current.role === 'admin'
            ? [
                {
                  label: t('admin.title'),
                  icon: icon('gear'),
                  onSelect: go('/a/$accountSlug/admin'),
                  testId: 'menu-admin',
                },
              ]
            : []),
          { label: t('trash.title'), icon: icon('trash'), onSelect: go('/a/$accountSlug/trash'), testId: 'menu-trash' },
          {
            label: t('archive.title'),
            icon: icon('archive'),
            onSelect: go('/a/$accountSlug/archive'),
            testId: 'menu-archive',
          },
        ] satisfies MenuEntry[])
      : []),
    // Support staff see the console too — only its Support section.
    ...(me.user.is_platform_owner || me.user.support_role
      ? [
          {
            label: t('owner.title'),
            icon: icon('shield'),
            onSelect: () =>
              void navigate(
                me.user.is_platform_owner ? { to: '/owner' } : { to: '/owner', search: { section: 'support' } },
              ),
            ...(errorAlerts ? { shortcut: t('errors.alerts.count', { n: errorAlerts }) } : {}),
            testId: 'menu-owner',
          },
        ]
      : []),
    { kind: 'separator' },
    // the accessibility statement from every screen — here too, so hiding "Help" in the bar never
    // hides it (while it is published).
    ...(statement
      ? ([
          {
            label: t('legal.menu.accessibility'),
            icon: icon('person'),
            onSelect: () => void window.open(legalHref('accessibility'), '_blank', 'noopener'),
            testId: 'menu-accessibility',
          },
        ] satisfies MenuEntry[])
      : []),
    { label: t('auth.signOut'), icon: icon('logout'), onSelect: () => void signOut(), testId: 'menu-sign-out' },
  ];

  const header = (
    <div className="flex items-center gap-2.5 p-2.5" data-testid="profile-menu-header">
      <Avatar name={displayName} url={me.user.avatar_url} size={40} />
      <div className="min-w-0">
        <p className="truncate text-[0.8125rem] font-semibold" dir="auto">
          {displayName}
        </p>
        {me.user.name ? (
          <p className="truncate text-[0.6875rem] text-muted" dir="ltr">
            {me.user.email}
          </p>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className={cn('relative', row && 'min-w-0 flex-1')}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-busy={photo.isPending || undefined}
        data-testid="profile-menu"
        data-tour="nav.profile"
        onClick={(e) => (placement === 'top' ? menu.above(e, align === 'end') : menu.fromTrigger(e))}
        aria-label={displayName}
        title={row ? displayName : undefined}
        style={box ? { width: box, height: box } : undefined}
        className={cn(
          'rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]',
          !!box && 'grid place-items-center rounded-[8px] hover:bg-[var(--shell-hover)]',
          row &&
            'flex h-10 w-full min-w-0 items-center gap-2.5 rounded-[10px] px-2 text-start text-shell-fg hover:bg-[var(--shell-hover)] hover:text-shell-strong',
          row && open && 'bg-[var(--shell-active)] text-shell-strong',
          photo.isPending && 'animate-pulse',
        )}
      >
        <Avatar name={displayName} url={me.user.avatar_url} size={row ? 28 : size} />
        {row ? (
          <>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" dir="auto" data-testid="profile-menu-name">
              {displayName}
            </span>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
              className="shrink-0 text-shell-muted"
            >
              <path d="M6 15l6-6 6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </>
        ) : null}
      </button>
      {/* Outside the menu: it stays mounted while the file dialog is open (the menu has closed by then). */}
      {current ? (
        <input ref={fileInput} type="file" accept={PHOTO_ACCEPT} hidden data-testid="avatar-input" onChange={onFile} />
      ) : null}
      <Menu
        at={menu.at}
        onClose={menu.close}
        label={displayName}
        items={items}
        header={header}
        searchable={false}
        testId="profile-menu-panel"
      />
    </div>
  );
};
