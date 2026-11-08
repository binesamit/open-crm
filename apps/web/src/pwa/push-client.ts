// SPDX-License-Identifier: AGPL-3.0-only
import type { PushSubscriptionRow } from '@bines/shared';
import { api } from '../lib/api';
import { urlBase64ToBytes } from './pwa-logic';
import { readyRegistration, swSupported } from './register';

/** Web Push from the page (PWA פ4): this browser's subscription, registered per account on the server. */
export const pushSupported = () =>
  swSupported() && typeof window !== 'undefined' && 'PushManager' in window && 'Notification' in window;

export const pushPermission = (): NotificationPermission | 'unsupported' =>
  pushSupported() ? Notification.permission : 'unsupported';

/** This browser's current push subscription (one per origin), or null. */
export const currentSubscription = async () => {
  if (!pushSupported()) return null;
  const reg = await readyRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
};

const sameKey = (sub: PushSubscription, key: Uint8Array) => {
  const have = sub.options.applicationServerKey;
  if (!have) return false;
  const a = new Uint8Array(have);
  return a.length === key.length && a.every((b, i) => b === key[i]);
};

export class PushError extends Error {}

/**
 * "Get notifications on this phone": the browser's permission (asked only now, after our own question), a
 * subscription with the server's key, and the row in this account.
 */
export const enablePush = async (accountId: string, vapidKey: string): Promise<PushSubscriptionRow> => {
  if (!pushSupported()) throw new PushError('unsupported');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new PushError('denied');
  const reg = await readyRegistration();
  if (!reg) throw new PushError('no_worker');
  const key = urlBase64ToBytes(vapidKey);
  let sub = await reg.pushManager.getSubscription();
  // The server's key changed (VAPID env set later): subscribe again with the new one.
  if (sub && !sameKey(sub, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON() as { endpoint: string; keys: { p256dh: string; auth: string } };
  return api(accountId).post<PushSubscriptionRow>('/me/push-subscriptions', {
    endpoint: json.endpoint,
    keys: json.keys,
  });
};

/**
 * Sign-out on this browser: its endpoint leaves every account of this user on the server, and the browser drops the
 * subscription. Never blocks the sign-out (offline, no worker).
 */
export const unsubscribeThisDevice = async () => {
  try {
    const sub = await currentSubscription();
    if (!sub) return;
    await api()
      .post('/me/push-subscriptions/unsubscribe', { endpoint: sub.endpoint })
      .catch(() => undefined);
    await sub.unsubscribe();
  } catch {
    // nothing to undo
  }
};

/** The app icon's number (פ5); browsers without the Badging API ignore it. */
export const setAppBadge = (n: number) => {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (n > 0) void nav.setAppBadge?.(n)?.catch(() => undefined);
    else void nav.clearAppBadge?.()?.catch(() => undefined);
  } catch {
    // not supported
  }
};
