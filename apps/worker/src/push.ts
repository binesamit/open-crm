// SPDX-License-Identifier: AGPL-3.0-only
import webpush from 'web-push';
import { platformMasterKey, readVapidRow } from '@bines/server-crypto';
import {
  DEFAULT_LOCALE,
  inQuietHours,
  isPushServiceEndpoint,
  isLocale,
  type MessageKey,
  notificationSentence,
  parseQuiet,
  PUSH_BADGE_ROW,
  type PushPayload,
  pushAllowed,
  t,
  vapidSubject,
} from '@bines/shared';
import { itemUrl, localTime, reachable } from './notifications';
import { mailRow } from './repositories/notifications.repo';
import {
  bellUnread,
  deleteSubscriptions,
  deleteSubscriptionsOf,
  markDelivered,
  markFailed,
  platformPwa,
  pushSettings,
  storedVapidRow,
  subscriptionsOf,
  wantsBadge,
} from './repositories/push.repo';
import type { SqlClient } from './repositories/trash.repo';

export type Vapid = { publicKey: string; privateKey: string; subject: string };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };

/** Sends one encrypted message to one push service; resolves with its HTTP status (never throws for an HTTP answer). */
export type PushSender = (target: PushTarget, payload: string, vapid: Vapid) => Promise<{ statusCode: number }>;

/** The real sender (RFC 8030 / 8291 / 8292 through `web-push`). */
export const webPushSender: PushSender = async (target, payload, vapid) => {
  try {
    const res = await webpush.sendNotification(
      { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      payload,
      {
        vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
        // A notification older than a day is no longer news.
        TTL: 24 * 60 * 60,
        urgency: 'normal',
      },
    );
    return { statusCode: res.statusCode };
  } catch (err) {
    if (err instanceof webpush.WebPushError) return { statusCode: err.statusCode };
    throw err;
  }
};

export type PushDeps = { sender: PushSender; appUrl: string; vapid: () => Promise<Vapid | null> };

let lockedWarned = false;

/**
 * VAPID from the environment (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY), else the pair the API stored. A sealed row
 * (the API had SECRET_MASTER_KEY) needs the same SECRET_MASTER_KEY here; without it there are no keys to sign with
 * (`no_keys`, one warning) — set the variable on the worker service too.
 */
export const vapidFrom =
  (db: SqlClient, env: NodeJS.ProcessEnv, warn: (msg: string) => void = console.warn) =>
  async (): Promise<Vapid | null> => {
    const subject = vapidSubject(env.VAPID_SUBJECT || undefined, env.WEB_ORIGIN ?? 'http://localhost:5173');
    if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY)
      return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject };
    const stored = readVapidRow(await storedVapidRow(db), platformMasterKey(env.SECRET_MASTER_KEY));
    if (stored.state === 'locked' && !lockedWarned) {
      lockedWarned = true;
      // Never the key itself (CLAUDE.md 10).
      warn('push: the stored VAPID key is sealed and SECRET_MASTER_KEY is missing or different on the worker');
    }
    return stored.state === 'ok' ? { ...stored.pair, subject } : null;
  };

/** Failed sends in a row (5xx, timeouts) before a subscription is dropped; 404 / 410 drop it at once. */
export const MAX_PUSH_FAILURES = 5;

export type PushResult =
  | 'missing'
  | 'read'
  | 'not_member'
  | 'platform_off'
  | 'account_off'
  | 'disabled'
  | 'quiet'
  | 'no_devices'
  | 'no_keys'
  | 'sent'
  | 'failed';

/**
 * `notifications.push` (PWA פ4): one notification → one message to each of the user's phones in that account. The
 * same rules as the bell and the email: nothing for a read notification, a member who left, a switched-off
 * category / board (`pushAllowed`), the owner's or the admin's switch, or the user's quiet hours. The lock-screen
 * setting decides whether the text travels at all. Dead subscriptions (404 / 410) are removed.
 */
export const dispatchPush = async (
  db: SqlClient,
  deps: PushDeps,
  id: string,
  now = new Date(),
): Promise<PushResult> => {
  const r = await mailRow(db, id);
  if (!r) return 'missing';
  if (r.read_at) return 'read';
  if (!reachable(r)) {
    await deleteSubscriptionsOf(db, r.account_id, r.user_id);
    return 'not_member';
  }
  if (!(await platformPwa(db)).push_enabled) return 'platform_off';
  const { rows, pwa, accountTimezone } = await pushSettings(db, r.account_id, r.user_id);
  if (!pwa.push_enabled) return 'account_off';
  if (!pushAllowed(rows, r.type, [r.board_id, r.top_board_id])) return 'disabled';
  const quiet = parseQuiet(rows.find((x) => x.channel === 'push' && x.type === '*' && x.board_id === null)?.digest);
  if (inQuietHours(quiet, localTime(now, r.timezone, accountTimezone).hour)) return 'quiet';
  const targets = await subscriptionsOf(db, r.account_id, r.user_id);
  if (!targets.length) return 'no_devices';
  const vapid = await deps.vapid();
  if (!vapid) return 'no_keys';

  const lang = (r.locale ?? '').slice(0, 2);
  const locale = isLocale(lang) ? lang : DEFAULT_LOCALE;
  const title = pwa.app_name ?? r.account_name;
  const full = pwa.lock_screen === 'full';
  const sentence = notificationSentence(
    {
      type: r.type,
      actor: r.actor_name,
      item: r.payload.doc_name ?? r.payload.dashboard_name ?? r.item_name,
      column: r.payload.column_title ?? null,
    },
    locale,
  );
  const payload: PushPayload = {
    title,
    // "Just a notification": the text never leaves the server; the app shows it after opening.
    body: full
      ? [sentence, r.payload.excerpt].filter(Boolean).join('\n')
      : t('pwa.push.generic' as MessageKey, undefined, locale),
    url: itemUrl('', r),
    tag: r.id,
    account_id: r.account_id,
    badge: wantsBadge(rows, PUSH_BADGE_ROW) ? await bellUnread(db, r.account_id, r.user_id) : null,
  };
  const body = JSON.stringify(payload);

  const delivered: string[] = [];
  const dead: string[] = [];
  const failed: string[] = [];
  for (const target of targets) {
    // Only the known push services are ever called (audit 2026-10-10 #4); a row from before the check is dropped.
    if (!isPushServiceEndpoint(target.endpoint)) {
      dead.push(target.id);
      continue;
    }
    try {
      const { statusCode } = await deps.sender(target, body, vapid);
      if (statusCode >= 200 && statusCode < 300) delivered.push(target.id);
      else if (statusCode === 404 || statusCode === 410) dead.push(target.id);
      else failed.push(target.id);
    } catch {
      failed.push(target.id);
    }
  }
  if (delivered.length) await markDelivered(db, delivered);
  if (dead.length) await deleteSubscriptions(db, dead);
  if (failed.length) await markFailed(db, failed, MAX_PUSH_FAILURES);
  return delivered.length ? 'sent' : 'failed';
};
