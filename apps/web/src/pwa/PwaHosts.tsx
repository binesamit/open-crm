// SPDX-License-Identifier: AGPL-3.0-only
import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type NotificationSettings, type PwaConfig, t } from '@bines/shared';
import { Button } from '@bines/ui';
import { Icon } from '../lib/icons';
import { api, errorMessage, type MyAccount } from '../lib/api';
import { showToast } from '../lib/toast';
import { swapFavicon } from './favicon';
import { badgeValue, deviceKind, INSTALL_SNOOZE_MS, installPrompt, shouldAskPush, showUpdateBanner } from './pwa-logic';
import { currentSubscription, enablePush, PushError, pushPermission, pushSupported, setAppBadge } from './push-client';
import {
  applyUpdate,
  captureInstallPrompt,
  onNotificationsRead,
  onPushNavigate,
  startBuildWatch,
  startServiceWorker,
  usePwaStore,
} from './register';

const read = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode: for this visit only
  }
};

/** Opened from the home-screen icon (standalone), not in a browser tab. */
export const isStandalone = () =>
  typeof window !== 'undefined' &&
  (window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true);

const subscribeOnline = (fn: () => void) => {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
};
export const useOnline = () =>
  useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );

/**
 * Pages that keep working offline (an extension board view whose manifest says `offline`: it queues its
 * own writes). While one is open the blocking screen stays away; the shell's offline banner still says so.
 */
let offlinePages = 0;
const offlineListeners = new Set<() => void>();
const subscribeOfflinePages = (fn: () => void) => {
  offlineListeners.add(fn);
  return () => offlineListeners.delete(fn);
};
export const useOfflineCapablePage = (on: boolean) =>
  useEffect(() => {
    if (!on) return;
    offlinePages += 1;
    offlineListeners.forEach((fn) => fn());
    return () => {
      offlinePages -= 1;
      offlineListeners.forEach((fn) => fn());
    };
  }, [on]);

/**
 * No connection (PWA פ2): one clear screen instead of the data — never old data that could pass for current.
 * Writes are not queued (mutations fail at once, main.tsx). Back online, everything reloads by itself.
 */
const OfflineScreen = () => {
  const online = useOnline();
  const capable = useSyncExternalStore(
    subscribeOfflinePages,
    () => offlinePages > 0,
    () => false,
  );
  const qc = useQueryClient();
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!online) wasOffline.current = true;
    else if (wasOffline.current) {
      wasOffline.current = false;
      void qc.invalidateQueries();
    }
  }, [online, qc]);
  if (online || capable) return null;
  return (
    <div
      role="alert"
      data-testid="pwa-offline"
      className="fixed inset-0 z-system-screen grid place-items-center bg-bg/95 px-6 text-center backdrop-blur-sm"
    >
      <div className="flex max-w-[340px] flex-col items-center gap-3">
        <span aria-hidden className="grid size-14 place-items-center rounded-full bg-surface-3 text-heading">
          <Icon name="warn" size={26} />
        </span>
        <h2 className="font-display text-lg font-bold text-heading">{t('pwa.offline.title')}</h2>
        <p className="text-sm text-muted">{t('pwa.offline.body')}</p>
      </div>
    </div>
  );
};

/** "A new version — refresh" (פ2): never reloads by itself while someone types. */
const UpdateBanner = () => {
  const { waiting, activated, dismissed, stale, mustRefresh } = usePwaStore();
  if (!showUpdateBanner({ waiting: !!waiting, activated, dismissed, stale, mustRefresh })) return null;
  return (
    <div
      role="status"
      data-testid="pwa-update-banner"
      className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-system-banner flex justify-center px-3 md:bottom-4"
    >
      <div className="flex w-full max-w-[440px] items-center gap-2.5 rounded-[14px] border border-line bg-surface px-3.5 py-2.5 text-sm shadow-lg">
        <Icon name="sparkle" size={16} className="shrink-0 text-heading" />
        <span className="min-w-0 flex-1 text-fg">{t('pwa.update.title')}</span>
        <Button size="sm" onClick={applyUpdate} data-testid="pwa-update-refresh">
          {t('pwa.update.refresh')}
        </Button>
        <button
          type="button"
          onClick={() => usePwaStore.setState({ dismissed: true })}
          aria-label={t('pwa.update.later')}
          title={t('pwa.update.later')}
          className="grid size-7 shrink-0 place-items-center rounded-[8px] text-muted hover:bg-surface-3 hover:text-fg"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    </div>
  );
};

/**
 * "Must refresh to continue": the server marked its build breaking for this page (PWA_BREAKING_EPOCH). One screen
 * over everything with only "refresh" — it never reloads by itself, so whatever is being typed stays until the
 * person presses it.
 */
const MustRefreshScreen = () => {
  const mustRefresh = usePwaStore((s) => s.mustRefresh);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (mustRefresh) button.current?.focus();
  }, [mustRefresh]);
  if (!mustRefresh) return null;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="pwa-must-refresh-title"
      aria-describedby="pwa-must-refresh-body"
      data-testid="pwa-must-refresh"
      className="fixed inset-0 z-system-top grid place-items-center bg-bg/95 px-6 text-center backdrop-blur-sm"
    >
      <div className="flex max-w-[360px] flex-col items-center gap-3">
        <span aria-hidden className="grid size-14 place-items-center rounded-full bg-surface-3 text-heading">
          <Icon name="sparkle" size={26} />
        </span>
        <h2 id="pwa-must-refresh-title" className="font-display text-lg font-bold text-heading">
          {t('pwa.update.must.title')}
        </h2>
        <p id="pwa-must-refresh-body" className="text-sm text-muted">
          {t('pwa.update.must.body')}
        </p>
        <Button ref={button} onClick={applyUpdate} data-testid="pwa-must-refresh-button">
          {t('pwa.update.refresh')}
        </Button>
      </div>
    </div>
  );
};

/** App-wide (main.tsx): the service worker, the build check, the offline screen and the update bar / screen. */
export const PwaGlobalHost = ({ onNavigate }: { onNavigate: (url: string) => void }) => {
  const qc = useQueryClient();
  useEffect(() => {
    onPushNavigate(onNavigate);
    // A push clicked on this device was marked read by the service worker: the bell follows.
    onNotificationsRead(
      (accountId) => void qc.invalidateQueries({ queryKey: ['account', accountId, 'notifications'] }),
    );
    captureInstallPrompt();
    startBuildWatch();
    void startServiceWorker();
  }, [onNavigate, qc]);
  return (
    <>
      <OfflineScreen />
      <UpdateBanner />
      <MustRefreshScreen />
    </>
  );
};

export const pwaConfigKey = (accountId: string) => ['account', accountId, 'pwa-config'] as const;
export const usePwaConfig = (account: Pick<MyAccount, 'id'>) =>
  useQuery({
    queryKey: pwaConfigKey(account.id),
    queryFn: () => api(account.id).get<PwaConfig>('/pwa/config'),
    staleTime: 5 * 60_000,
  });

/** Points the page's manifest, iOS icon / title, tab icon and theme colour at the account (and back on leaving). */
const useAccountHead = (config: PwaConfig | undefined) => {
  useEffect(() => {
    if (!config) return;
    const set = (selector: string, attr: string, value: string) => {
      const el = document.head.querySelector(selector);
      if (!el) return () => undefined;
      const before = el.getAttribute(attr);
      el.setAttribute(attr, value);
      return () => (before === null ? el.removeAttribute(attr) : el.setAttribute(attr, before));
    };
    const undo = [
      set('link[rel="manifest"]', 'href', config.manifest_url),
      set('link[rel="apple-touch-icon"]', 'href', config.apple_icon_url),
      set('meta[name="theme-color"]', 'content', config.theme_color),
      set('meta[name="apple-mobile-web-app-title"]', 'content', config.app_name),
      swapFavicon(config.favicon_url),
    ];
    return () => undo.forEach((u) => u());
  }, [config]);
};

const visitsKey = (accountId: string) => `bines.pwa.visits.${accountId}`;
const snoozeKey = (accountId: string) => `bines.pwa.snooze.${accountId}`;
const askedKey = (accountId: string) => `bines.pwa.pushAsked.${accountId}`;

/** One visit per browser session (sessionStorage), counted per account on this device. */
const countVisit = (accountId: string) => {
  let counted = false;
  try {
    counted = sessionStorage.getItem(visitsKey(accountId)) === '1';
    sessionStorage.setItem(visitsKey(accountId), '1');
  } catch {
    counted = true;
  }
  const visits = Number(read(visitsKey(accountId)) ?? '0') + (counted ? 0 : 1);
  if (!counted) write(visitsKey(accountId), String(visits));
  return visits;
};

/** A bottom card on the phone (install suggestion, push question). */
const Sheet = ({ testId, children }: { testId: string; children: ReactNode }) => (
  <div
    role="dialog"
    aria-modal="false"
    data-testid={testId}
    className="fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] z-system-prompt flex justify-center px-3 md:bottom-4"
  >
    <div className="w-full max-w-[440px] rounded-[16px] border border-line bg-surface p-3.5 text-sm shadow-lg">
      {children}
    </div>
  </div>
);

const Step = ({ n, children }: { n: number; children: ReactNode }) => (
  <li className="flex items-center gap-2.5">
    <span className="grid size-6 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-bold text-heading">
      {n}
    </span>
    <span className="min-w-0 flex-1 text-fg">{children}</span>
  </li>
);

/** The gentle "add to home screen" bar (פ3): Android button / iOS 3-step explainer; "not now" = a month. */
const InstallBar = ({ account, config }: { account: MyAccount; config: PwaConfig }) => {
  const installEvent = usePwaStore((s) => s.installEvent);
  const [visits] = useState(() => countVisit(account.id));
  const [snoozedUntil, setSnoozedUntil] = useState(() => Number(read(snoozeKey(account.id)) ?? '') || null);
  const [now] = useState(() => Date.now());
  const [device] = useState(() => deviceKind(navigator.userAgent, navigator.maxTouchPoints));
  const state = installPrompt({
    enabled: config.install_prompt,
    after: config.install_prompt_after,
    visits,
    snoozedUntil,
    now,
    standalone: isStandalone(),
    device,
    canPrompt: !!installEvent,
  });
  if (state === 'hidden') return null;
  const snooze = () => {
    const until = Date.now() + INSTALL_SNOOZE_MS;
    write(snoozeKey(account.id), String(until));
    setSnoozedUntil(until);
  };
  const install = async () => {
    if (!installEvent) return;
    await installEvent.prompt();
    const choice = await installEvent.userChoice.catch(() => ({ outcome: 'dismissed' }));
    usePwaStore.setState({ installEvent: null });
    if (choice.outcome !== 'accepted') snooze();
  };
  return (
    <Sheet testId="pwa-install">
      <div className="flex items-start gap-3">
        <img src={config.apple_icon_url} alt="" className="size-11 shrink-0 rounded-[11px] border border-line" />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-semibold text-heading">{t('pwa.install.title', { name: config.app_name })}</p>
          <p className="text-xs text-muted">{t('pwa.install.body')}</p>
        </div>
      </div>
      {state === 'ios' ? (
        <ol className="mt-3 space-y-2" data-testid="pwa-install-ios">
          <Step n={1}>{t('pwa.install.ios.share')}</Step>
          <Step n={2}>{t('pwa.install.ios.add')}</Step>
          <Step n={3}>{t('pwa.install.ios.confirm')}</Step>
        </ol>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={snooze} data-testid="pwa-install-later">
          {t('pwa.install.later')}
        </Button>
        {state === 'android' ? (
          <Button size="sm" onClick={() => void install()} data-testid="pwa-install-button">
            <Icon name="download" size={14} />
            {t('pwa.install.button')}
          </Button>
        ) : null}
      </div>
    </Sheet>
  );
};

/** Our own question before the browser's (פ4): "get notifications on this phone?" — asked once per account. */
const PushAsk = ({ account, config }: { account: MyAccount; config: PwaConfig }) => {
  const qc = useQueryClient();
  const [asked, setAsked] = useState(() => read(askedKey(account.id)) === '1');
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [device] = useState(() => deviceKind(navigator.userAgent, navigator.maxTouchPoints));
  useEffect(() => {
    let live = true;
    void currentSubscription().then((s) => live && setSubscribed(!!s));
    return () => {
      live = false;
    };
  }, []);
  if (
    subscribed === null ||
    !config.vapid_public_key ||
    !shouldAskPush({
      pushEnabled: config.push_enabled,
      supported: pushSupported(),
      permission: pushPermission(),
      subscribed,
      asked,
      standalone: isStandalone(),
      device,
    })
  )
    return null;
  const done = () => {
    write(askedKey(account.id), '1');
    setAsked(true);
  };
  const yes = async () => {
    setBusy(true);
    try {
      await enablePush(account.id, config.vapid_public_key!);
      showToast({ message: t('pwa.push.enabled') });
      await qc.invalidateQueries({ queryKey: ['account', account.id, 'push-subscriptions'] });
    } catch (e) {
      if (!(e instanceof PushError && e.message === 'denied')) showToast({ message: errorMessage(e), tone: 'error' });
    } finally {
      setBusy(false);
      done();
    }
  };
  return (
    <Sheet testId="pwa-push-ask">
      <div className="flex items-start gap-3">
        <span aria-hidden className="grid size-10 shrink-0 place-items-center rounded-full bg-surface-3 text-heading">
          <Icon name="bell" size={18} />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-semibold text-heading">{t('pwa.push.ask.title')}</p>
          <p className="text-xs text-muted">{t('pwa.push.ask.body')}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={done} data-testid="pwa-push-ask-no">
          {t('pwa.push.ask.no')}
        </Button>
        <Button size="sm" busy={busy} onClick={() => void yes()} data-testid="pwa-push-ask-yes">
          {t('pwa.push.ask.yes')}
        </Button>
      </div>
    </Sheet>
  );
};

/** Inside an account (AppShell): its manifest and icon, the install bar, the push question. */
export const PwaAccountHost = ({ account }: { account: MyAccount }) => {
  const config = usePwaConfig(account).data;
  useAccountHead(config);
  if (!config) return null;
  return (
    <div className="contents" data-testid="pwa-account-host" data-manifest={config.manifest_url}>
      <PushAsk account={account} config={config} />
      <InstallBar account={account} config={config} />
    </div>
  );
};

/** The app icon's number = the bell's unread count (פ5), unless switched off in my notification settings. */
export const useAppBadge = (account: Pick<MyAccount, 'id'>, unread: number | null) => {
  const settings = useQuery({
    queryKey: ['account', account.id, 'notification-settings'],
    queryFn: () => api(account.id).get<NotificationSettings>('/me/notifications/settings'),
    staleTime: 5 * 60_000,
  });
  const enabled = settings.data?.badge ?? true;
  useEffect(() => {
    // null = not loaded yet: leave the icon as it is.
    if (unread !== null) setAppBadge(badgeValue(unread, enabled));
  }, [unread, enabled]);
};
