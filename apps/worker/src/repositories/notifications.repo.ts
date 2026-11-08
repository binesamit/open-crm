// SPDX-License-Identifier: AGPL-3.0-only
import { notificationDefaultsSchema, withDefaults, type SettingRow } from '@bines/shared';
import type { SqlClient } from './trash.repo';

/** A notification with everything its email shows, resolved at send time (renames show). */
export type MailRow = {
  id: string;
  type: string;
  account_id: string;
  user_id: string;
  read_at: Date | null;
  emailed_at: Date | null;
  payload: {
    excerpt?: string;
    column_title?: string;
    doc_name?: string;
    dashboard_name?: string;
    /** `relation_view_missing` (r19relfilter): the view that is gone and the column that used it. */
    view_name?: string;
    column_key?: string;
  };
  /** A doc notification (M8): the doc it opens. */
  doc_id: string | null;
  /** A dashboard notification (shared with me): the dashboard it opens. */
  dashboard_id: string | null;
  update_id: string | null;
  item_id: string | null;
  email: string;
  /** The member's own zone, or null (they follow the account's). */
  timezone: string | null;
  member_status: string | null;
  account_name: string;
  account_slug: string;
  account_status: string;
  actor_name: string | null;
  item_name: string | null;
  board_id: string | null;
  /** The board to open the item on: the parent for a subitem (D14). */
  top_board_id: string | null;
  board_name: string | null;
  /** The recipient's language (emails read in it). */
  locale: string | null;
  /** The account's email branding (sender name, Reply-To, email logo, accent colour) and logo. */
  branding: {
    email_sender_name?: string;
    email_reply_to?: string;
    email_logo_asset_id?: string;
    email_accent_color?: string;
  } | null;
  account_logo_asset_id: string | null;
  /** The item's live email address token, if it has one: answers to the email reach the item. */
  item_inbound_token: string | null;
  /** The account turned incoming email on. */
  inbound_enabled: boolean | null;
};

const SELECT_MAIL = `
  select n.id, n.type, n.account_id, n.user_id, n.read_at, n.emailed_at, n.payload, n.update_id, n.item_id, n.doc_id, n.dashboard_id,
         u.email, u.timezone, u.locale, m.status as member_status,
         a.name as account_name, a.slug as account_slug,
         -- plan-lock: a closed account (its current subscription, set by the owner) mails nobody.
         case when exists (select 1 from account_subscriptions cs where cs.account_id = a.id and cs.ended_at is null
                             and cs.status = 'closed') then 'closed' else a.status::text end as account_status,
         s.settings->'branding' as branding, a.logo_asset_id as account_logo_asset_id,
         coalesce(nullif(actor.name, ''), actor.email) as actor_name, i.name as item_name, n.board_id,
         coalesce(pb.id, b.id) as top_board_id, coalesce(pb.name, b.name) as board_name,
         ia.token as item_inbound_token, (s.settings->'inbound_email'->>'enabled')::boolean as inbound_enabled
  from notifications n
  join users u on u.id = n.user_id
  join accounts a on a.id = n.account_id
  left join account_settings s on s.account_id = n.account_id
  left join account_members m on m.account_id = n.account_id and m.user_id = n.user_id
  left join users actor on actor.id = n.actor_id
  left join items i on i.id = n.item_id and i.deleted_at is null
  left join boards b on b.id = n.board_id
  left join boards pb on pb.id = b.parent_board_id
  left join inbound_addresses ia on ia.item_id = n.item_id and ia.kind = 'item' and ia.disabled_at is null`;

export const mailRow = async (db: SqlClient, id: string) =>
  (await db.query(`${SELECT_MAIL} where n.id = $1`, [id])).rows[0] as MailRow | undefined;

/** Still-unread, never-emailed notifications of one user in one account (the digest), newest first. */
export const digestRows = async (db: SqlClient, accountId: string, userId: string, since: Date) =>
  (
    await db.query(
      `${SELECT_MAIL}
       where n.account_id = $1 and n.user_id = $2 and n.read_at is null and n.emailed_at is null
         and n.created_at >= $3
       order by n.id desc limit 50`,
      [accountId, userId, since],
    )
  ).rows as MailRow[];

/** The account's notification defaults (`account_settings.settings.notifications`), if any. */
const accountDefaults = async (db: SqlClient, accountId: string) => {
  const raw = (
    await db.query(`select settings->'notifications' as n from account_settings where account_id = $1`, [accountId])
  ).rows[0] as { n: unknown } | undefined;
  const parsed = notificationDefaultsSchema.safeParse(raw?.n ?? {});
  return parsed.success ? parsed.data : null;
};

/** The user's rows of one channel from notification_settings (08 §12.3) in this account, with the account defaults. */
export const channelSettings = async (
  db: SqlClient,
  accountId: string,
  userId: string,
  channel: SettingRow['channel'],
) =>
  withDefaults(
    (
      await db.query(
        `select channel, type, board_id, enabled, digest from notification_settings
         where account_id = $1 and user_id = $2 and channel = $3`,
        [accountId, userId, channel],
      )
    ).rows as SettingRow[],
    await accountDefaults(db, accountId),
  ).filter((r) => r.channel === channel);

/** The user's email rows (the email rules read them). */
export const emailSettings = (db: SqlClient, accountId: string, userId: string) =>
  channelSettings(db, accountId, userId, 'email');

/**
 * Members who may take a summary email: their own account-wide email row asks for one, or they have none and
 * the account default does. The caller checks the schedule (`digestOf` on their effective rows).
 */
export const digestUsers = async (db: SqlClient) =>
  (
    await db.query(
      `select m.account_id, m.user_id, u.timezone, a.settings->'locale'->>'timezone' as account_timezone
       from account_members m
       join users u on u.id = m.user_id
       left join notification_settings s on s.account_id = m.account_id and s.user_id = m.user_id
         and s.channel = 'email' and s.type = '*' and s.board_id is null
       left join account_settings a on a.account_id = m.account_id
       where m.status = 'active'
         and ((s.id is not null and s.enabled and s.digest <> 'instant')
           or (s.id is null and coalesce(a.settings->'notifications'->>'digest', 'instant') <> 'instant'))`,
    )
  ).rows as { account_id: string; user_id: string; timezone: string | null; account_timezone: string | null }[];

/** The owner console's platform settings (product name, sender, accent of emails); null = the defaults. */
export const platformSettingsRow = async (db: SqlClient) =>
  (
    (await db.query(`select settings from platform_settings where id = 'platform'`)).rows[0] as
      | {
          settings: {
            product_name?: string;
            email?: { sender_name?: string; reply_to?: string; accent_color?: string; inbound_domain?: string };
          };
        }
      | undefined
  )?.settings ?? null;

export const markEmailed = (db: SqlClient, ids: string[]) =>
  db.query(`update notifications set emailed_at = now() where id = any($1::varchar[])`, [ids]);
