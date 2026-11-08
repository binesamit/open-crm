// SPDX-License-Identifier: AGPL-3.0-only
import {
  accountPwaSettingsSchema,
  notificationDefaultsSchema,
  platformPwaSettingsSchema,
  type SettingRow,
  VAPID_ROW_ID,
  withDefaults,
} from '@bines/shared';
import type { VapidRow } from '@bines/server-crypto';
import type { SqlClient } from './trash.repo';

export type PushSubscriptionRow = { id: string; endpoint: string; p256dh: string; auth: string };

/**
 * The user's rows the phone rules read (`pushAllowed`): the push rows, plus the bell's board rows (a board silenced
 * in the bell is silent on the phone too) — with the account defaults filled in.
 */
export const pushSettings = async (db: SqlClient, accountId: string, userId: string) => {
  const raw = (
    await db.query(
      `select settings->'notifications' as n, settings->'pwa' as pwa, settings->'locale'->>'timezone' as timezone
       from account_settings where account_id = $1`,
      [accountId],
    )
  ).rows[0] as { n: unknown; pwa: unknown; timezone: string | null } | undefined;
  const defaults = notificationDefaultsSchema.safeParse(raw?.n ?? {});
  const rows = (
    await db.query(
      `select channel, type, board_id, enabled, digest from notification_settings
       where account_id = $1 and user_id = $2 and (channel = 'push' or (channel = 'in_app' and board_id is not null))`,
      [accountId, userId],
    )
  ).rows as SettingRow[];
  const pwa = accountPwaSettingsSchema.safeParse(raw?.pwa ?? {});
  return {
    rows: withDefaults(rows, defaults.success ? defaults.data : null).filter(
      (r) => r.channel === 'push' || r.board_id !== null,
    ),
    pwa: pwa.success ? pwa.data : accountPwaSettingsSchema.parse({}),
    accountTimezone: raw?.timezone ?? null,
  };
};

/** The owner's PWA switches (push on for the platform at all). */
export const platformPwa = async (db: SqlClient) => {
  const raw = (await db.query(`select settings->'pwa' as pwa from platform_settings where id = 'platform'`)).rows[0] as
    { pwa: unknown } | undefined;
  const parsed = platformPwaSettingsSchema.safeParse(raw?.pwa ?? {});
  return parsed.success ? parsed.data : platformPwaSettingsSchema.parse({});
};

/** The VAPID row the API created (platform_settings row `vapid`, read with `readVapidRow`); null = never created. */
export const storedVapidRow = async (db: SqlClient) =>
  (
    (await db.query(`select settings from platform_settings where id = $1`, [VAPID_ROW_ID])).rows[0] as
      { settings: VapidRow } | undefined
  )?.settings ?? null;

export const subscriptionsOf = async (db: SqlClient, accountId: string, userId: string) =>
  (
    await db.query(
      `select id, endpoint, p256dh, auth from push_subscriptions where account_id = $1 and user_id = $2 order by created_at`,
      [accountId, userId],
    )
  ).rows as PushSubscriptionRow[];

export const deleteSubscriptions = (db: SqlClient, ids: string[]) =>
  db.query(`delete from push_subscriptions where id = any($1::varchar[])`, [ids]);

/** Everything this user registered in the account (they left it, or it was suspended). */
export const deleteSubscriptionsOf = (db: SqlClient, accountId: string, userId: string) =>
  db.query(`delete from push_subscriptions where account_id = $1 and user_id = $2`, [accountId, userId]);

export const markDelivered = (db: SqlClient, ids: string[]) =>
  db.query(`update push_subscriptions set last_used_at = now(), failures = 0 where id = any($1::varchar[])`, [ids]);

/** A failed send (not 404 / 410): counted; after `max` in a row the subscription goes. */
export const markFailed = async (db: SqlClient, ids: string[], max: number) => {
  await db.query(`update push_subscriptions set failures = failures + 1 where id = any($1::varchar[])`, [ids]);
  await db.query(`delete from push_subscriptions where id = any($1::varchar[]) and failures >= $2`, [ids, max]);
};

/** The bell's unread count in the account (the app icon's badge). */
export const bellUnread = async (db: SqlClient, accountId: string, userId: string) =>
  Number(
    (
      (
        await db.query(
          `select count(*)::int as n from notifications
           where account_id = $1 and user_id = $2 and read_at is null and coalesce(payload->>'bell', 'true') <> 'false'`,
          [accountId, userId],
        )
      ).rows[0] as { n: number } | undefined
    )?.n ?? 0,
  );

/** Whether the user wants the unread count on the icon (their push row `badge`; on by default). */
export const wantsBadge = (rows: SettingRow[], badgeRow: string) =>
  rows.find((r) => r.channel === 'push' && r.type === badgeRow && r.board_id === null)?.enabled ?? true;
