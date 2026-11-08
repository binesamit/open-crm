// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  formatDate,
  formatHour,
  getRegion,
  type NotificationSettings,
  type PushSubscriptionRow,
  t,
  todayIn,
  tDynamic,
} from '@bines/shared';
import { Badge, Button, Card, Notice, Switch } from '@bines/ui';
import { Icon } from '../lib/icons';
import { api, errorMessage, type MyAccount } from '../lib/api';
import { showToast } from '../lib/toast';
import { PickerButton } from '../features/board/toolbar/parts';
import { deviceKind } from './pwa-logic';
import { currentSubscription, enablePush, PushError, pushPermission, pushSupported } from './push-client';
import { isStandalone, usePwaConfig } from './PwaHosts';

type QuietPatch = { quiet?: NotificationSettings['quiet']; badge?: boolean };

/**
 * הגדרות התראות → "טלפון" (PWA פ4/פ5): turn this phone / browser on, my registered devices (remove any), quiet hours
 * and the number on the app icon. The per-category phone switches live in the table above (column "טלפון").
 */
export const PhoneNotificationsSection = ({
  account,
  settings,
  busy,
  onSave,
}: {
  account: MyAccount;
  settings: NotificationSettings;
  busy: boolean;
  onSave: (patch: QuietPatch) => void;
}) => {
  const qc = useQueryClient();
  const config = usePwaConfig(account).data;
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void currentSubscription()
      .then((s) => live && setEndpoint(s?.endpoint ?? null))
      .catch(() => live && setEndpoint(null));
    return () => {
      live = false;
    };
  }, []);
  const key = ['account', account.id, 'push-subscriptions', endpoint ?? ''];
  const devices = useQuery({
    queryKey: key,
    enabled: endpoint !== undefined,
    queryFn: () =>
      api(account.id).get<{ data: PushSubscriptionRow[] }>(
        `/me/push-subscriptions${endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : ''}`,
      ),
  });
  const refresh = () => qc.invalidateQueries({ queryKey: ['account', account.id, 'push-subscriptions'] });
  const enable = useMutation({
    mutationFn: () => enablePush(account.id, config!.vapid_public_key!),
    onSuccess: async () => {
      setEndpoint((await currentSubscription())?.endpoint ?? null);
      showToast({ message: t('pwa.push.enabled') });
      await refresh();
    },
    onError: (e) =>
      showToast({
        message: e instanceof PushError ? tDynamic(`pwa.push.error.${e.message}`) : errorMessage(e),
        tone: 'error',
      }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(account.id).delete(`/me/push-subscriptions/${id}`),
    onSuccess: refresh,
    onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
  });

  const list = devices.data?.data ?? [];
  const thisOn = list.some((d) => d.current);
  const device = deviceKind(navigator.userAgent, navigator.maxTouchPoints);
  const permission = pushPermission();
  const q = settings.quiet;
  const hours = (pick: (h: number) => QuietPatch, current: number, testId: string, label: string) => (
    <PickerButton
      testId={testId}
      menuLabel={label}
      placeholder=""
      className="h-9 w-[120px]"
      label={`${label} ${formatHour(current)}`}
      items={Array.from({ length: 24 }, (_, h) => ({
        label: formatHour(h),
        checked: h === current,
        onSelect: () => onSave(pick(h)),
      }))}
    />
  );

  return (
    <Card className="flex flex-col gap-3" data-testid="notif-phone">
      <div className="flex items-center gap-2">
        <Icon name="mobile" size={18} className="shrink-0 text-heading" />
        <h2 className="font-display text-base leading-snug font-bold text-heading">{t('pwa.phone.title')}</h2>
      </div>

      {config && !config.push_enabled ? (
        <Notice tone="info">{t('pwa.phone.offByAdmin')}</Notice>
      ) : !pushSupported() ? (
        <Notice tone="info">
          {device === 'ios' && !isStandalone() ? t('pwa.phone.iosInstall') : t('pwa.phone.unsupported')}
        </Notice>
      ) : permission === 'denied' ? (
        <Notice tone="warn">{t('pwa.phone.blocked')}</Notice>
      ) : device === 'ios' && !isStandalone() ? (
        <Notice tone="info">{t('pwa.phone.iosInstall')}</Notice>
      ) : !thisOn && config?.vapid_public_key ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-[1_1_220px] text-sm text-muted">{t('pwa.phone.enableHint')}</p>
          <Button size="sm" busy={enable.isPending} onClick={() => enable.mutate()} data-testid="notif-phone-enable">
            <Icon name="bell" size={14} />
            {t('pwa.phone.enable')}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-1.5">
        <h3 className="text-xs font-semibold text-fg-2">{t('pwa.phone.devices')}</h3>
        {list.length ? (
          <ul className="overflow-hidden rounded-[12px] border border-line">
            {list.map((d) => (
              <li
                key={d.id}
                data-testid="notif-phone-device"
                data-current={d.current ? 'true' : undefined}
                className="flex items-center gap-3 border-b border-line-soft bg-surface px-3 py-2.5 text-sm last:border-b-0"
              >
                <Icon name="mobile" size={15} className="shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-fg" dir="auto">
                    {d.device_label}
                  </p>
                  <p className="text-xs text-muted">
                    {t('pwa.phone.added', { date: formatDate(todayIn(getRegion(), new Date(d.created_at))) })}
                  </p>
                </div>
                {d.current ? <Badge tone="ok">{t('pwa.phone.thisDevice')}</Badge> : null}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={() => remove.mutate(d.id)}
                  data-testid="notif-phone-remove"
                >
                  {t('pwa.phone.remove')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t('pwa.phone.none')}</p>
        )}
      </div>

      <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={q.enabled}
            disabled={busy}
            onChange={(on) => onSave({ quiet: { ...q, enabled: on } })}
            testId="notif-quiet"
          />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-fg">{t('pwa.quiet.title')}</span>
            <span className="block text-xs text-muted">{t('pwa.quiet.hint')}</span>
          </span>
        </label>
        {q.enabled ? (
          <div className="flex flex-wrap items-center gap-2 ps-12 text-sm">
            {hours((h) => ({ quiet: { ...q, from: h } }), q.from, 'notif-quiet-from', t('pwa.quiet.from'))}
            {hours((h) => ({ quiet: { ...q, to: h } }), q.to, 'notif-quiet-to', t('pwa.quiet.to'))}
          </div>
        ) : null}
        <label className="flex items-center gap-3 text-sm">
          <Switch
            checked={settings.badge}
            disabled={busy}
            onChange={(on) => onSave({ badge: on })}
            testId="notif-badge"
          />
          <span className="min-w-0 flex-1">
            <span className="block font-semibold text-fg">{t('pwa.badge.title')}</span>
            <span className="block text-xs text-muted">{t('pwa.badge.hint')}</span>
          </span>
        </label>
      </div>
    </Card>
  );
};
