// SPDX-License-Identifier: AGPL-3.0-only
import {
  digestEmail,
  emailLogoUrl,
  type Mailer,
  mailBrand,
  notificationEmail,
  type NotificationMail,
} from '@bines/server-mail';
import {
  channelAllowed,
  DEFAULT_LOCALE,
  DEFAULT_REGION,
  digestOf,
  inboundAddress,
  isLocale,
  type SettingRow,
  updateLinkQuery,
  wantsDigest,
} from '@bines/shared';
import {
  digestRows,
  digestUsers,
  emailSettings,
  mailRow,
  type MailRow,
  markEmailed,
  platformSettingsRow,
} from './repositories/notifications.repo';
import type { SqlClient } from './repositories/trash.repo';
const DIGEST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type MailDeps = { mailer: Mailer; appUrl: string };

/** Email is allowed by the same rule as the bell (`channelAllowed`, shared), on the email channel. */
const emailAllowed = (settings: SettingRow[], type: string, boardIds: (string | null)[]) =>
  channelAllowed(settings, 'email', type, boardIds);

export const itemUrl = (appUrl: string, r: MailRow) => {
  const base = `${appUrl}/a/${r.account_slug}`;
  // A doc notification opens the doc (M8).
  if (r.doc_id) return `${base}/d/${r.doc_id}`;
  if (r.dashboard_id) return `${base}/dash/${r.dashboard_id}`;
  // A relation column whose view is gone (r19relfilter): the board, with that column's settings open.
  if (r.type === 'relation_view_missing' && r.top_board_id)
    return `${base}/b/${r.top_board_id}${r.payload.column_key ? `?column_settings=${encodeURIComponent(r.payload.column_key)}` : ''}`;
  if (!r.top_board_id || !r.item_id || !r.item_name) return base;
  const item = `${base}/b/${r.top_board_id}/i/${r.item_id}`;
  if (r.type === 'time.forgotten') return `${item}?tab=time`;
  // s37reply: an update / reply opens on its own thread (a reply: scrolled to it).
  return r.update_id ? `${item}${updateLinkQuery(r.update_id)}` : item;
};

const toMail = (appUrl: string, r: MailRow): NotificationMail => ({
  type: r.type,
  actorName: r.actor_name,
  itemName: r.payload.doc_name ?? r.payload.dashboard_name ?? r.payload.view_name ?? r.item_name,
  boardName: r.board_name,
  columnTitle: r.payload.column_title ?? null,
  excerpt: r.payload.excerpt ?? null,
  url: itemUrl(appUrl, r),
});

// The notification settings page (M4 step 4).
const settingsUrl = (appUrl: string, r: MailRow) => `${appUrl}/a/${r.account_slug}/settings/notifications`;

/**
 * The brand of a member's email (ANSWERS 6א.3): the recipient's language, the account's sender name / Reply-To /
 * logo, the platform's product name.
 */
const brandOf = async (db: SqlClient, appUrl: string, r: MailRow, itemReply = false) => {
  const lang = (r.locale ?? '').slice(0, 2);
  const logo = r.branding?.email_logo_asset_id || r.account_logo_asset_id;
  const platform = await platformSettingsRow(db);
  const brand = mailBrand({
    locale: isLocale(lang) ? lang : DEFAULT_LOCALE,
    platform,
    account: { name: r.account_name, branding: r.branding },
    logoUrl: logo ? emailLogoUrl(appUrl, r.account_id, logo) : null,
  });
  // Incoming email: an item with a live address takes the answer — "Reply" writes an update on it.
  // One item's email only (`itemReply`); the digest, about many items, keeps the account's Reply-To.
  const domain = platform?.email?.inbound_domain;
  return itemReply && r.item_inbound_token && r.inbound_enabled && domain
    ? { ...brand, replyTo: inboundAddress('item', r.item_inbound_token, domain) }
    : brand;
};

/** An active member of an account that is neither suspended nor closed (plan-lock: a closed account mails nobody). */
export const reachable = (r: MailRow) =>
  r.member_status === 'active' && r.account_status !== 'suspended' && r.account_status !== 'closed';

/**
 * `notifications.dispatch` (D15): one notification → one email, unless it was read in the bell meanwhile,
 * already emailed, switched off in the settings, or the user takes the daily digest. Returns what happened.
 */
export const dispatchNotification = async (db: SqlClient, deps: MailDeps, id: string) => {
  const r = await mailRow(db, id);
  if (!r) return 'missing';
  if (r.emailed_at) return 'already_sent';
  if (r.read_at) return 'read';
  if (!reachable(r)) return 'not_member';
  const settings = await emailSettings(db, r.account_id, r.user_id);
  if (!emailAllowed(settings, r.type, [r.board_id, r.top_board_id])) return 'disabled';
  if (wantsDigest(settings)) return 'digest';
  await deps.mailer.send(
    notificationEmail({
      to: r.email,
      brand: await brandOf(db, deps.appUrl, r, true),
      accountName: r.account_name,
      settingsUrl: settingsUrl(deps.appUrl, r),
      n: toMail(deps.appUrl, r),
    }),
  );
  await markEmailed(db, [r.id]);
  return 'sent';
};

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
/**
 * Local hour (0–23) and weekday (0 = Sunday) of `now` in the member's timezone; a member who never chose one
 * (null) — or whose zone is unknown — follows the account's (A3), then the platform default.
 */
export const localTime = (now: Date, timezone: string | null, accountTimezone?: string | null) => {
  const parts = (tz: string) =>
    new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', weekday: 'short', timeZone: tz })
      .formatToParts(now)
      .reduce<Record<string, string>>((o, p) => ({ ...o, [p.type]: p.value }), {});
  let p: Record<string, string>;
  try {
    if (!timezone) throw new Error('no zone of their own');
    p = parts(timezone);
  } catch {
    try {
      p = parts(accountTimezone || DEFAULT_REGION.timezone);
    } catch {
      p = parts(DEFAULT_REGION.timezone);
    }
  }
  return { hour: Number(p.hour), weekday: WEEKDAYS.indexOf(p.weekday ?? 'Sun') };
};

/**
 * `notifications.digest` (hourly): each summary user, at their hour (daily) or their hour and weekday (weekly),
 * in their timezone, gets one email with what is unread.
 */
export const sendDigests = async (db: SqlClient, deps: MailDeps, now = new Date()) => {
  let sent = 0;
  for (const u of await digestUsers(db)) {
    const settings = await emailSettings(db, u.account_id, u.user_id);
    const digest = digestOf(settings);
    const at = localTime(now, u.timezone, u.account_timezone);
    if (digest.frequency === 'instant' || at.hour !== digest.hour) continue;
    if (digest.frequency === 'weekly' && at.weekday !== digest.weekday) continue;
    const rows = (await digestRows(db, u.account_id, u.user_id, new Date(now.getTime() - DIGEST_WINDOW_MS))).filter(
      (r) => reachable(r) && emailAllowed(settings, r.type, [r.board_id, r.top_board_id]),
    );
    if (!rows.length) continue;
    await deps.mailer.send(
      digestEmail({
        to: rows[0]!.email,
        brand: await brandOf(db, deps.appUrl, rows[0]!),
        accountName: rows[0]!.account_name,
        settingsUrl: settingsUrl(deps.appUrl, rows[0]!),
        url: `${deps.appUrl}/a/${rows[0]!.account_slug}`,
        items: rows.map((r) => toMail(deps.appUrl, r)),
        timeZone: u.timezone || u.account_timezone || 'UTC',
        now,
      }),
    );
    await markEmailed(
      db,
      rows.map((r) => r.id),
    );
    sent++;
  }
  return sent;
};
