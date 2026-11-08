// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The phone app's decisions (PWA פ2/פ3/פ5), kept pure so they are tested without a browser: when the "new version"
 * bar may reload, when to suggest installing, which device this is.
 */

/** Someone is typing or has a form / dialog open: never reload under them. */
export const isTyping = (doc: Pick<Document, 'activeElement' | 'querySelector'>) => {
  const el = doc.activeElement as HTMLElement | null;
  if (el) {
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return true;
  }
  return !!doc.querySelector('[role="dialog"], [aria-modal="true"]');
};

/**
 * A new service worker took over (another tab asked, or this one). Reload when this tab asked; quietly when nobody
 * is looking (hidden and not typing); otherwise keep the bar ("refresh") so nothing typed is lost.
 */
export const onControllerChange = (p: { requestedHere: boolean; typing: boolean; hidden: boolean }) =>
  p.requestedHere || (p.hidden && !p.typing) ? ('reload' as const) : ('banner' as const);

/**
 * The bar shows while an update waits (or already took over in another tab, or the server runs a newer build) and
 * was not closed for now. Never over the must-refresh screen.
 */
export const showUpdateBanner = (p: {
  waiting: boolean;
  activated: boolean;
  dismissed: boolean;
  stale?: boolean;
  mustRefresh?: boolean;
}) => (p.waiting || p.activated || !!p.stale) && !p.dismissed && !p.mustRefresh;

/**
 * This page against the server's build (GET /public/pwa/status): `current` (same build, or the server does not know
 * its own — development), `stale` (another build: the "new version — refresh" bar) or `must_refresh` (the server's
 * PWA_BREAKING_EPOCH is above this page's: the old page may break, so only "refresh" is left).
 */
export const buildState = (p: { appBuild: string; appEpoch: number; serverBuild: string; serverEpoch: number }) => {
  if (!p.serverBuild || p.serverBuild === 'dev' || p.serverBuild === p.appBuild) return 'current' as const;
  return p.appEpoch < p.serverEpoch ? ('must_refresh' as const) : ('stale' as const);
};

export type DeviceKind = 'ios' | 'android' | 'other';

/** iPhone / iPad (iPadOS reads as a Mac with touch), Android, or anything else. */
export const deviceKind = (ua: string, maxTouchPoints = 0): DeviceKind => {
  if (/iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && maxTouchPoints > 1)) return 'ios';
  if (/Android/i.test(ua)) return 'android';
  return 'other';
};

/** "Not now" keeps the bar away this long (product decision: a month). */
export const INSTALL_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The gentle "add to home screen" bar (פ3): on a phone, not installed yet, the account allows it, from the N-th visit,
 * not snoozed. iOS gets the 3-step explainer; Android the install button (only when the browser offered one).
 */
export const installPrompt = (p: {
  enabled: boolean;
  after: number;
  visits: number;
  snoozedUntil: number | null;
  now: number;
  standalone: boolean;
  device: DeviceKind;
  canPrompt: boolean;
}): 'hidden' | 'ios' | 'android' => {
  if (!p.enabled || p.standalone || p.device === 'other') return 'hidden';
  if (p.visits < p.after) return 'hidden';
  if (p.snoozedUntil && p.now < p.snoozedUntil) return 'hidden';
  if (p.device === 'android') return p.canPrompt ? 'android' : 'hidden';
  return 'ios';
};

/**
 * Our own question "get notifications on this phone?" — never the browser's prompt first: on a phone, opened from
 * the home-screen icon (the first open after installing; iOS allows push only there anyway), push is on here, the
 * browser can do it, permission was never decided, no subscription yet, and we did not ask before. In a browser tab
 * the settings page has the same button.
 */
export const shouldAskPush = (p: {
  pushEnabled: boolean;
  supported: boolean;
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;
  asked: boolean;
  standalone: boolean;
  device: DeviceKind;
}) =>
  p.pushEnabled &&
  p.supported &&
  p.permission === 'default' &&
  !p.subscribed &&
  !p.asked &&
  p.device !== 'other' &&
  p.standalone;

/** base64url → bytes (PushManager.subscribe wants the VAPID key as bytes). */
export const urlBase64ToBytes = (s: string) => {
  const padded = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** What the icon badge shows: the bell's unread count, nothing when off or zero. */
export const badgeValue = (unread: number, enabled: boolean) => (enabled && unread > 0 ? unread : 0);
