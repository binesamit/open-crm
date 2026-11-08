// SPDX-License-Identifier: AGPL-3.0-only
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_PWA_THEME,
  type MyAccount,
  PWA_LOCK_SCREEN,
  PWA_START_PAGES,
  t,
  type UpdateAccount,
} from '@bines/shared';
import { Card, Notice, Segmented, SkeletonRows, Switch } from '@bines/ui';
import { errorMessage } from '../lib/api';
import { showToast } from '../lib/toast';
import { h2, Row } from '../features/admin/admin-parts';
import { TextSetting } from '../features/admin/AdminMessaging';
import { useAccountDetail, useUpdateAccount } from '../features/admin/account-settings';
import { PickerButton } from '../features/board/toolbar/parts';
import { pwaConfigKey, usePwaConfig } from './PwaHosts';

const HEX = /^#[0-9a-fA-F]{6}$/;

type PwaPatch = NonNullable<NonNullable<UpdateAccount['settings']>['pwa']>;

/** Saves settings.pwa (only what changed) and refreshes the app's config (manifest, install bar, push). */
const usePwaSave = (account: MyAccount) => {
  const qc = useQueryClient();
  const update = useUpdateAccount(account);
  const save = (pwa: PwaPatch) =>
    update.mutate(
      { settings: { pwa } },
      {
        onSuccess: () => {
          showToast({ message: t('admin.general.saved') });
          void qc.invalidateQueries({ queryKey: pwaConfigKey(account.id) });
        },
        onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
      },
    );
  return { save, busy: update.isPending };
};

const Frame = ({
  title,
  hint,
  testId,
  children,
}: {
  title: string;
  hint: string;
  testId: string;
  children: ReactNode;
}) => (
  <Card className="p-0" data-testid={testId}>
    <div className="space-y-0.5 border-b border-line-soft px-3.5 pt-3.5 pb-3">
      <h2 className={h2}>{title}</h2>
      <p className="text-xs text-muted">{hint}</p>
    </div>
    <div>{children}</div>
  </Card>
);

/**
 * Administration → כללי → "האפליקציה בטלפון" (PWA פ1): the home-screen name, the splash / status-bar colour and the
 * screen it opens on. The icon is the account's logo (set above), else a neutral mark in the colour.
 */
export const AdminPwaAppSection = ({ account }: { account: MyAccount }) => {
  const detail = useAccountDetail(account);
  const { save, busy } = usePwaSave(account);
  const config = usePwaConfig(account).data;
  const p = detail.data?.settings.pwa;
  if (detail.isError) return <Notice tone="error">{errorMessage(detail.error)}</Notice>;
  if (!p) return <SkeletonRows rows={3} label={t('app.loading')} />;
  // Without a colour of its own the account follows the owner's default (the config says which), else the built-in.
  const fallbackColor = (!p.theme_color && config?.theme_color) || DEFAULT_PWA_THEME;
  return (
    <Frame title={t('pwa.admin.app.title')} hint={t('pwa.admin.app.hint')} testId="admin-pwa-app">
      <Row label={t('pwa.admin.appName')} hint={t('pwa.admin.appNameHint')} testId="admin-pwa-name">
        <TextSetting
          key={p.app_name ?? ''}
          value={p.app_name}
          placeholder={account.name}
          label={t('pwa.admin.appName')}
          maxLength={30}
          busy={busy}
          onSave={(v) => save({ app_name: v })}
          testId="admin-pwa-name"
        />
      </Row>
      <Row label={t('pwa.admin.color')} hint={t('pwa.admin.colorHint')} testId="admin-pwa-color">
        <span
          aria-hidden
          className="h-7 w-7 shrink-0 rounded-md border border-line"
          style={{ background: p.theme_color ?? fallbackColor }}
          data-testid="admin-pwa-color-swatch"
        />
        <TextSetting
          key={p.theme_color ?? ''}
          value={p.theme_color}
          placeholder={fallbackColor}
          label={t('pwa.admin.color')}
          maxLength={7}
          ltr
          busy={busy}
          valid={(v) => HEX.test(v)}
          onSave={(v) => save({ theme_color: v })}
          testId="admin-pwa-color"
        />
      </Row>
      <Row label={t('pwa.admin.startPage')} testId="admin-pwa-start">
        <Segmented
          value={p.start_page}
          label={t('pwa.admin.startPage')}
          testId="admin-pwa-start-page"
          options={PWA_START_PAGES.map((v) => ({
            value: v,
            label: t(`pwa.admin.start.${v}`),
            testId: `admin-pwa-start-${v}`,
          }))}
          onChange={(v) => save({ start_page: v })}
        />
      </Row>
    </Frame>
  );
};

/**
 * Administration → התראות → "טלפון" (PWA פ3/פ4): push in this account at all, what a locked screen shows, and the
 * gentle "add to home screen" suggestion (on / off, after how many visits).
 */
export const AdminPwaPushSection = ({ account }: { account: MyAccount }) => {
  const detail = useAccountDetail(account);
  const { save, busy } = usePwaSave(account);
  const p = detail.data?.settings.pwa;
  if (!p) return null;
  return (
    <Frame title={t('pwa.admin.push.title')} hint={t('pwa.admin.push.hint')} testId="admin-pwa-push">
      <Row label={t('pwa.admin.pushEnabled')} hint={t('pwa.admin.pushEnabledHint')}>
        <Switch
          checked={p.push_enabled}
          disabled={busy}
          label={t('pwa.admin.pushEnabled')}
          onChange={(on) => save({ push_enabled: on })}
          testId="admin-pwa-push-enabled"
        />
      </Row>
      <Row label={t('pwa.admin.lockScreen')} hint={t('pwa.admin.lockScreenHint')}>
        <Segmented
          value={p.lock_screen}
          label={t('pwa.admin.lockScreen')}
          testId="admin-pwa-lock"
          options={PWA_LOCK_SCREEN.map((v) => ({
            value: v,
            label: t(`pwa.admin.lock.${v}`),
            testId: `admin-pwa-lock-${v}`,
          }))}
          onChange={(v) => save({ lock_screen: v })}
        />
      </Row>
      <Row label={t('pwa.admin.install')} hint={t('pwa.admin.installHint')}>
        <Switch
          checked={p.install_prompt}
          disabled={busy}
          label={t('pwa.admin.install')}
          onChange={(on) => save({ install_prompt: on })}
          testId="admin-pwa-install"
        />
        {p.install_prompt ? (
          <PickerButton
            testId="admin-pwa-install-after"
            menuLabel={t('pwa.admin.installAfter')}
            placeholder=""
            className="h-9 w-[150px]"
            label={t('pwa.admin.installAfterN', { n: p.install_prompt_after })}
            items={[1, 2, 3, 5, 10].map((n) => ({
              label: t('pwa.admin.installAfterN', { n }),
              checked: n === p.install_prompt_after,
              onSelect: () => save({ install_prompt_after: n }),
            }))}
          />
        ) : null}
      </Row>
    </Frame>
  );
};
