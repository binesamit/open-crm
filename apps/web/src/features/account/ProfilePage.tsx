// SPDX-License-Identifier: AGPL-3.0-only
import { useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { t, type MessageKey } from '@bines/shared';
import { Avatar, Button, cn, Segmented, Tabs } from '@bines/ui';
import { Icon } from '../../lib/icons';
import { errorMessage, type Me, type MyAccount } from '../../lib/api';
import { NotificationSettingsPage } from '../notifications/NotificationSettingsPage';
import { TokensPage } from '../tokens/TokensPage';
import { ProfileNavLayout } from '../shell/NavLayoutSettings';
import { PHOTO_ACCEPT, photoProblem, SIDEBAR_TONES, THEMES, useProfile } from '../shell/use-profile';
import { Popover } from '../board/cells/Popover';
import { showToast } from '../../lib/toast';
import { PhotoCropDialog } from './PhotoCropDialog';
import { AvatarPickerDialog } from './AvatarPickerDialog';
import { ProfileForm } from './ProfileDialog';
import { SecuritySection } from './SecuritySection';
import { TwoFactorSection } from './TwoFactor';
import { MyDataSection } from './MyDataSection';
import { PalettePicker } from './PalettePicker';
import { AppearanceSettings } from './AppearanceSettings';
import { PhonePrefsSection } from '../phone/PhonePrefsSection';
import { TourPrefs } from '../tours/TourSettings';

export const PROFILE_TABS = ['profile', 'security', 'notifications', 'tokens', 'appearance'] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];
export const isProfileTab = (v: unknown): v is ProfileTab => PROFILE_TABS.includes(v as ProfileTab);

/** Guests and viewers cannot create API tokens (the server refuses them), so they get no tokens tab. */
export const canHaveTokens = (account: MyAccount) => account.role !== 'guest' && account.role !== 'viewer';

const Group = ({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) => (
  <section role="group" aria-label={title} data-testid={testId} className="max-w-[480px] space-y-2">
    <h2 className="font-display text-base leading-snug font-bold text-heading">{title}</h2>
    {children}
  </section>
);

/**
 * "הפרופיל שלי" (fix5, product owner: "תכניס את הטוקן שלי ואת הגדרות ההתראות שלי — לפרופיל"): one page with tabs —
 * פרופיל (my details and photo), התראות (my notification settings), טוקני API (my own tokens; not for guests and
 * viewers) and מראה (theme and the sidebar's tone). /settings/notifications and /settings/tokens redirect into
 * their tab; the account-wide token management stays in Administration → חיבורים.
 */
export const ProfilePage = ({ me, account, tab }: { me: Me; account: MyAccount; tab?: ProfileTab }) => {
  const navigate = useNavigate();
  const { theme, chooseTheme, tone, chooseTone, fileInput, photo, displayName } = useProfile(me, account);
  const [dragging, setDragging] = useState(false);
  const [photoMenu, setPhotoMenu] = useState(false);
  /** The photo in the crop dialog (picked, dropped, or the current one to re-frame). */
  const [cropping, setCropping] = useState<Blob | null>(null);
  const [pickingAvatar, setPickingAvatar] = useState(false);
  const choose = (file: File | undefined) => {
    if (!file) return;
    setPhotoMenu(false);
    const problem = photoProblem(file);
    if (problem) return void showToast({ message: errorMessage({ code: problem }), tone: 'error' });
    setCropping(file);
  };
  // Re-frame the current photo; when it cannot be read back (another site's photo, storage without CORS) the
  // file picker opens instead.
  const editCurrent = async () => {
    setPhotoMenu(false);
    const url = me.user.avatar_url;
    const blob = url
      ? await fetch(url)
          .then((r) => (r.ok ? r.blob() : null))
          .catch(() => null)
      : null;
    if (blob && blob.type.startsWith('image/')) setCropping(blob);
    else fileInput.current?.click();
  };
  const tokens = canHaveTokens(account);
  const active: ProfileTab = !tab || (tab === 'tokens' && !tokens) ? 'profile' : tab;
  const pick = (next: ProfileTab) =>
    void navigate({
      to: '/a/$accountSlug/profile',
      params: { accountSlug: account.slug },
      search: next === 'profile' ? {} : { tab: next },
      replace: true,
    });
  const tabs: { value: ProfileTab; label: string; testId: string }[] = [
    { value: 'profile', label: t('profile.tab.profile'), testId: 'profile-tab-profile' },
    // fix8: set / change my password — a way in that does not depend on email.
    { value: 'security', label: t('profile.tab.security'), testId: 'profile-tab-security' },
    {
      value: 'notifications',
      label: t('profile.tab.notifications'),
      testId: 'profile-tab-notifications',
    },
    ...(tokens ? [{ value: 'tokens' as const, label: t('tokens.title'), testId: 'profile-tab-tokens' }] : []),
    { value: 'appearance', label: t('theme.title'), testId: 'profile-tab-appearance' },
  ];

  return (
    <main data-testid="profile-page" data-tab={active} className="w-full space-y-4 px-4 py-5 md:px-6">
      {/* My photo (round 9, r15): a click on the avatar opens a small panel (upload / edit / remove, and the hint
          that a photo can be dropped here); a new or edited photo goes through the round crop dialog first. */}
      <header
        className={cn(
          'flex items-center gap-3.5 rounded-[16px] transition-shadow',
          dragging && 'ring-2 ring-[var(--focus-ring)] ring-offset-4 ring-offset-[var(--surface)]',
        )}
        data-testid="profile-photo-drop"
        data-dragging={dragging || undefined}
        onDragOver={(e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          choose(e.dataTransfer.files[0]);
        }}
      >
        <input
          ref={fileInput}
          type="file"
          accept={PHOTO_ACCEPT}
          hidden
          data-testid="profile-avatar-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            choose(file);
          }}
        />
        <span className="relative shrink-0">
          <button
            type="button"
            onClick={() => setPhotoMenu((v) => !v)}
            disabled={photo.isPending}
            aria-haspopup="dialog"
            aria-expanded={photoMenu}
            aria-label={t('profile.photo')}
            title={t('profile.photo')}
            data-testid="profile-avatar"
            className="group relative block rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus-ring)]"
          >
            <Avatar
              name={displayName}
              url={me.user.avatar_url}
              size={64}
              className={cn(photo.isPending && 'animate-pulse')}
            />
            <span
              aria-hidden
              className="absolute -end-0.5 -bottom-0.5 grid size-6 place-items-center rounded-full border-2 border-[var(--surface)] bg-surface text-fg shadow-[var(--shadow-pop)] group-hover:bg-surface-2"
            >
              <Icon name="edit" size={12} />
            </span>
          </button>
          <Popover open={photoMenu} onClose={() => setPhotoMenu(false)} className="w-64 space-y-1">
            <div data-testid="profile-photo-menu" className="space-y-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setPhotoMenu(false);
                  fileInput.current?.click();
                }}
                data-testid="profile-photo-upload"
              >
                <Icon name="upload" size={14} />
                {t('profile.photo.upload')}
              </Button>
              {/* one of our animals instead of a photo. */}
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  setPhotoMenu(false);
                  setPickingAvatar(true);
                }}
                data-testid="profile-photo-avatar"
              >
                <Icon name="smile" size={14} />
                {t('profile.photo.avatar')}
              </Button>
              {me.user.avatar_url ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => void editCurrent()}
                    data-testid="profile-photo-edit"
                  >
                    <Icon name="edit" size={14} />
                    {t('profile.photo.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-danger-fg"
                    onClick={() => {
                      setPhotoMenu(false);
                      photo.mutate(null);
                    }}
                    data-testid="profile-photo-remove"
                  >
                    <Icon name="trash" size={14} />
                    {t('profile.photo.remove')}
                  </Button>
                </>
              ) : null}
              <p className="border-t border-line-soft px-2.5 pt-2 text-xs text-muted">{t('profile.photo.hint')}</p>
            </div>
          </Popover>
        </span>
        <div className="min-w-0">
          <h1 className="font-display text-[1.875rem] leading-tight font-extrabold tracking-[-0.6px] text-heading max-md:text-2xl">
            {t('profile.title')}
          </h1>
          <p className="truncate text-sm text-muted" dir="ltr">
            {me.user.email}
          </p>
        </div>
      </header>
      {cropping ? (
        <PhotoCropDialog
          source={cropping}
          busy={photo.isPending}
          onCancel={() => setCropping(null)}
          onSave={async (file) => {
            await photo.mutateAsync(file).then(
              () => setCropping(null),
              () => undefined, // the hook's toast says what went wrong; the dialog stays open
            );
          }}
        />
      ) : null}
      {pickingAvatar ? (
        <AvatarPickerDialog
          busy={photo.isPending}
          onCancel={() => setPickingAvatar(false)}
          onSave={async (file) => {
            await photo.mutateAsync(file).then(
              () => setPickingAvatar(false),
              () => undefined, // the hook's toast says what went wrong; the dialog stays open
            );
          }}
        />
      ) : null}
      <Tabs value={active} onChange={pick} tabs={tabs} />

      {active === 'profile' ? (
        <div className="space-y-5">
          <ProfileForm accountId={account.id} />
          {/* Plan: what a click on a phone number does for me. */}
          <Group title={t('phone.prefs.title')} testId="profile-phone">
            <PhonePrefsSection />
          </Group>
        </div>
      ) : active === 'security' ? (
        <>
          <SecuritySection />
          <TwoFactorSection />
          <MyDataSection accountId={account.id} />
        </>
      ) : active === 'notifications' ? (
        <NotificationSettingsPage account={account} embedded />
      ) : active === 'tokens' ? (
        <TokensPage account={account} personal />
      ) : (
        <div className="space-y-6" data-testid="profile-appearance">
          <Group title={t('theme.title')}>
            <Segmented
              label={t('theme.title')}
              value={theme}
              onChange={chooseTheme}
              className="flex w-full [&>button]:flex-1"
              options={THEMES.map((k) => ({
                value: k,
                label: t(`theme.${k}` as MessageKey),
                icon: k === 'system' ? undefined : <Icon name={k === 'light' ? 'sun' : 'moon'} size={14} />,
                testId: `theme-${k}`,
              }))}
            />
          </Group>
          {/* Round 13: text size and table density — per user (every device), live. */}
          <Group title={t('r13.look.title')} testId="profile-text-size">
            <AppearanceSettings accountId={account.id} />
          </Group>
          {/* Round 12: the colour theme — F4 or another palette, each with its light and dark variant. */}
          <Group title={t('r12.palette.title')} testId="profile-palette">
            <PalettePicker />
          </Group>
          {/* The sidebar's tone (fix4): dark green or light — light only while the interface is light. */}
          <Group title={t('sidebar.tone.title')} testId="sidebar-tone">
            <Segmented
              label={t('sidebar.tone.title')}
              value={tone}
              onChange={chooseTone}
              className="flex w-full [&>button]:flex-1"
              options={SIDEBAR_TONES.map((k) => ({
                value: k,
                label: t(`theme.${k}` as MessageKey),
                testId: `sidebar-tone-${k}`,
              }))}
            />
            {tone === 'light' && theme === 'dark' ? (
              <p className="text-xs text-muted">{t('sidebar.tone.darkOnly')}</p>
            ) : null}
          </Group>
          {/* offer me a short tour the first time I open a screen. */}
          <Group title={t('tour.prefs.title')} testId="profile-tours-group">
            <TourPrefs account={account} />
          </Group>
          {/* what sits in the sidebar and what in the top bar — mine, or the account's. */}
          <section
            role="group"
            aria-label={t('navLayout.title' as MessageKey)}
            data-testid="profile-nav"
            className="max-w-[860px] space-y-2"
          >
            <h2 className="font-display text-base leading-snug font-bold text-heading">
              {t('navLayout.title' as MessageKey)}
            </h2>
            <ProfileNavLayout account={account} />
          </section>
        </div>
      )}
    </main>
  );
};
