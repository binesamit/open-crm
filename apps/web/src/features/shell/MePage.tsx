// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { t, type MessageKey } from '@bines/shared';
import { Avatar, avatarColor, cn } from '@bines/ui';
import { Icon, type IconName } from '../../lib/icons';
import type { Me, MyAccount } from '../../lib/api';
import { useMyProfile } from '../account/ProfileDialog';
import { canHaveTokens, type ProfileTab } from '../account/ProfilePage';
import { useHelpAccess } from '../support/kb-page';
import { PHOTO_ACCEPT, useProfile } from './use-profile';

/**
 * "אני" (N1, the phone's fifth tab; works on desktop too): who I am, my profile and its tabs (fix5: details,
 * notification settings, API tokens, appearance — on the profile page), links, switching accounts and signing
 * out — everything the avatar menu does, as a screen.
 */
type LinkTo =
  | '/a/$accountSlug/automations'
  | '/a/$accountSlug/flows'
  | '/a/$accountSlug/trash'
  | '/a/$accountSlug/archive'
  | '/a/$accountSlug/help';

/**
 * `staff`: not for guests (fix4/fix5 — the server refuses trash to guests, and their archive is always empty).
 * `makers`: admins and members only (flows — viewers and guests are sent home from it).
 * `help`: while the knowledge center is on for this person (never guests nor a support grant).
 */
const LINKS: {
  to: LinkTo;
  icon: IconName;
  label: MessageKey;
  testId: string;
  staff?: boolean;
  makers?: boolean;
  help?: boolean;
}[] = [
  { to: '/a/$accountSlug/automations', icon: 'bolt', label: 'nav.automations', testId: 'me-automations' },
  { to: '/a/$accountSlug/flows', icon: 'link', label: 'flows.title' as MessageKey, testId: 'me-flows', makers: true },
  { to: '/a/$accountSlug/trash', icon: 'trash', label: 'trash.title', testId: 'me-trash', staff: true },
  { to: '/a/$accountSlug/archive', icon: 'archive', label: 'archive.title', testId: 'me-archive', staff: true },
  // The knowledge center's page.
  { to: '/a/$accountSlug/help', icon: 'book', label: 'kb.title' as MessageKey, testId: 'me-help', help: true },
];

/** The profile page's tabs, as rows of the "הפרופיל שלי" section. */
const PROFILE_ROWS: { tab: ProfileTab; icon: IconName; label: MessageKey; testId: string }[] = [
  { tab: 'profile', icon: 'edit', label: 'profile.edit' as MessageKey, testId: 'me-profile-edit' },
  { tab: 'notifications', icon: 'bell', label: 'notifications.settings', testId: 'me-notification-settings' },
  { tab: 'tokens', icon: 'key', label: 'tokens.title', testId: 'me-tokens' },
  { tab: 'appearance', icon: 'sun', label: 'theme.title', testId: 'me-appearance' },
];

const row =
  'flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-start text-[0.9375rem] text-fg hover:bg-surface-3 disabled:opacity-50';

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="space-y-1.5">
    <h2 className="px-1 text-xs font-semibold text-muted">{title}</h2>
    <div className="divide-y divide-[var(--line-soft)] overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
      {children}
    </div>
  </section>
);

// RTL: "forward" points to the inline end.
const Chevron = () => <Icon name="chevronEnd" size={16} className="ms-auto shrink-0 text-muted" />;

export const MePage = ({ me, account }: { me: Me; account: MyAccount }) => {
  const { list, switchTo, signOut, fileInput, onFile, photo, displayName } = useProfile(me, account);
  const guest = account.role === 'guest';
  const maker = account.role === 'admin' || account.role === 'member';
  const help = useHelpAccess(account);
  const helpOn = !help.hidden && help.helpOn;
  const icon = (name: IconName) => <Icon name={name} size={18} className="shrink-0 text-muted" />;
  const profile = useMyProfile(account.id).data;
  // What colleagues see about me (fix2); empty fields are left out.
  const details: { label: MessageKey; value: string | null | undefined; ltr?: boolean; testId: string }[] = [
    { label: 'profile.jobTitle' as MessageKey, value: profile?.title, testId: 'me-title' },
    { label: 'profile.department' as MessageKey, value: profile?.department, testId: 'me-department' },
    { label: 'profile.phone' as MessageKey, value: profile?.phone, ltr: true, testId: 'me-phone' },
    {
      label: 'profile.birthday' as MessageKey,
      value: profile?.birthday?.split('-').reverse().join('/'),
      ltr: true,
      testId: 'me-birthday',
    },
  ];

  return (
    <main data-testid="me-page" className="mx-auto w-full max-w-[640px] space-y-5 px-4 py-5 md:px-6">
      <header className="flex items-center gap-3.5">
        <Avatar name={displayName} url={me.user.avatar_url} size={64} />
        <div className="min-w-0">
          <h1
            className="truncate font-display text-2xl leading-tight font-extrabold tracking-[-0.4px] text-heading"
            dir="auto"
          >
            {displayName}
          </h1>
          {me.user.name ? (
            <p className="truncate text-sm text-muted" dir="ltr">
              {me.user.email}
            </p>
          ) : null}
          <p className="text-xs text-muted">
            {[profile?.title, account.name, t(`role.${account.role}` as MessageKey)].filter(Boolean).join(' · ')}
          </p>
        </div>
      </header>

      <Section title={t('profile.mine')}>
        {details
          .filter((d) => d.value)
          .map((d) => (
            <div key={d.testId} className={cn(row, 'cursor-default hover:bg-transparent')} data-testid={d.testId}>
              <span className="w-28 shrink-0 text-sm text-muted">{t(d.label)}</span>
              <span className="min-w-0 flex-1 truncate" dir={d.ltr ? 'ltr' : 'auto'}>
                {d.value}
              </span>
            </div>
          ))}
        {PROFILE_ROWS.filter((r) => r.tab !== 'tokens' || canHaveTokens(account)).map((r) => (
          <Link
            key={r.tab}
            to="/a/$accountSlug/profile"
            params={{ accountSlug: account.slug }}
            search={r.tab === 'profile' ? {} : { tab: r.tab }}
            data-testid={r.testId}
            className={row}
          >
            {icon(r.icon)}
            {t(r.label)}
            <Chevron />
          </Link>
        ))}
      </Section>

      <Section title={t('profile.photo')}>
        <input
          ref={fileInput}
          type="file"
          accept={PHOTO_ACCEPT}
          hidden
          data-testid="me-avatar-input"
          onChange={onFile}
        />
        <button
          type="button"
          disabled={photo.isPending}
          onClick={() => fileInput.current?.click()}
          className={row}
          data-testid="me-photo-upload"
        >
          {icon('upload')}
          {t('profile.photo.upload')}
        </button>
        {me.user.avatar_url ? (
          <button
            type="button"
            disabled={photo.isPending}
            onClick={() => photo.mutate(null)}
            className={row}
            data-testid="me-photo-remove"
          >
            {icon('x')}
            {t('profile.photo.remove')}
          </button>
        ) : null}
      </Section>

      <Section title={t('me.settings')}>
        {account.role === 'admin' ? (
          <Link
            to="/a/$accountSlug/admin"
            params={{ accountSlug: account.slug }}
            data-testid="me-admin"
            className={row}
          >
            {icon('gear')}
            {t('admin.title')}
            <Chevron />
          </Link>
        ) : null}
        {LINKS.filter((l) => !(guest && l.staff) && !(l.makers && !maker) && !(l.help && !helpOn)).map((l) => (
          <Link key={l.to} to={l.to} params={{ accountSlug: account.slug }} data-testid={l.testId} className={row}>
            {icon(l.icon)}
            {t(l.label)}
            <Chevron />
          </Link>
        ))}
        {me.user.is_platform_owner || me.user.support_role ? (
          <Link
            to="/owner"
            search={me.user.is_platform_owner ? {} : { section: 'support' }}
            data-testid="me-owner"
            className={row}
          >
            {icon('shield')}
            {t('owner.title')}
            <Chevron />
          </Link>
        ) : null}
      </Section>

      {list.length > 1 ? (
        <Section title={t('account.switcher.title')}>
          {list.map((a) => {
            const on = a.id === account.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => void switchTo(a)}
                aria-current={on ? 'true' : undefined}
                data-testid={`me-account-${a.slug}`}
                className={cn(row, on && 'bg-surface-3 font-semibold')}
              >
                <span
                  aria-hidden
                  style={on ? undefined : { backgroundColor: avatarColor(a.name) }}
                  className={cn(
                    'grid size-7 shrink-0 place-items-center rounded-full font-display text-xs font-extrabold',
                    on ? 'bg-accent text-on-accent' : 'text-white',
                  )}
                >
                  {a.name.trim().charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="text-xs font-normal text-muted">{t(`role.${a.role}` as MessageKey)}</span>
              </button>
            );
          })}
        </Section>
      ) : null}

      <div className="overflow-hidden rounded-[var(--radius-lg)] border border-line bg-surface">
        <button
          type="button"
          onClick={() => void signOut()}
          data-testid="me-sign-out"
          className={cn(row, 'text-danger-fg [&>svg]:text-danger-fg')}
        >
          {icon('logout')}
          {t('auth.signOut')}
        </button>
      </div>
    </main>
  );
};
