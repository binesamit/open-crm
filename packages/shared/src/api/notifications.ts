// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { type Locale, type MessageKey, t } from '../i18n';

/** Settings categories (08 §12.3) a user switches per channel; the ones that exist today. */
export const NOTIFICATION_CATEGORIES = ['assigned', 'mentioned', 'item_updates', 'reminders'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationTypeMeta = {
  /** The settings category (08 §12.3) the user switches per channel and per board; null = no switch. */
  category: NotificationCategory | null;
  /**
   * A system notification the user cannot turn off: it always reaches the bell and the email channel, whatever the
   * personal settings, the account defaults and the board mutes say. The phone still follows the category's push
   * switch (a type with no category never buzzes the phone).
   */
  required: boolean;
};

/**
 * Every notification type and its rules — THE one table the senders read (bell notifications, 07 §9.3; settings,
 * 08 §12.3). The API writes every notification through `notifyUsers` (notifications.service), which reads it via
 * `channelAllowed`; the worker's email / push / forgotten-timer code reads the same `channelAllowed`.
 * `required` = security and billing (secrets, support access to the account, permissions an extension asks for,
 * plan and AI-budget status) and the support tickets' own messages (no switch; the tickets module emails them).
 * Changing a type's `required` is a product decision: update docs/08-ACCOUNT-ADMIN.md §12.3 with it.
 */
export const NOTIFICATION_TYPE_META = {
  // Someone mentioned me, assigned me (or my team), replied to my update / updated an item I follow.
  mention: { category: 'mentioned', required: false },
  assigned: { category: 'assigned', required: false },
  reply: { category: 'item_updates', required: false },
  item_update: { category: 'item_updates', required: false },
  // A timer left running (the worker).
  'time.forgotten': { category: 'reminders', required: false },
  // Automation "notify" messages (M6) are reminders the board set up.
  automation: { category: 'reminders', required: false },
  // Agents (מ7): a step waits for approval.
  agent_approval: { category: 'reminders', required: false },
  // Agents (מ7): the account's AI spend reached the alert share of its budget (admins) — billing.
  ai_budget: { category: 'reminders', required: true },
  // Docs (M8 ד2–ד3): mentioned in a doc or in a doc comment; a reply / new comment in a thread I am in.
  doc_mention: { category: 'mentioned', required: false },
  doc_comment: { category: 'item_updates', required: false },
  // Extensions (ת6): a new version asks for more permissions and waits for an admin — security.
  extension_update: { category: 'reminders', required: true },
  // Plans: a plan limit passed the warning share / was reached (admins, once a period each) — billing.
  plan_limit: { category: 'reminders', required: true },
  // External flows: a flow on n8n / Make / Zapier failed (the connection's alert settings).
  flow_failed: { category: 'reminders', required: false },
  // Sharing: someone shared a doc / a dashboard with me (invited me to it, or added me to its members).
  doc_shared: { category: 'item_updates', required: false },
  dashboard_shared: { category: 'item_updates', required: false },
  // Custom senders (S-46): the platform owner approved / rejected the admin's sender name, Reply-To or SMS sender.
  sender_request: { category: 'reminders', required: false },
  // Support tickets: support replied / the status changed. No switch: the ticket emails are sent by
  // the tickets module itself (owner console settings), the bell row always.
  ticket_reply: { category: null, required: true },
  ticket_status: { category: null, required: true },
  // Support asks to enter the account (admins) — security.
  ticket_access_request: { category: null, required: true },
  // Invitations: someone I invited accepted (the account's invitation setting).
  invitation_accepted: { category: 'reminders', required: false },
  // Secret columns: someone revealed more secrets in an hour than a column's alert threshold
  // (admins) — security.
  secret_reveals: { category: 'reminders', required: true },
  // Relation filters (r19relfilter): a shared view a relation column offered its items by was deleted / made
  // private — the column offers every item until its owner chooses again (the board's owners).
  relation_view_missing: { category: 'reminders', required: false },
  // Errors hub: an error of the account passed the owner's threshold (admins; off unless the owner turns it on).
  error_alert: { category: 'reminders', required: false },
  // Interactive documents: the client opened, chose, or signed a document of an item (the document's
  // notify settings choose who; questions arrive as updates and notify like any update).
  idoc_activity: { category: 'item_updates', required: false },
} as const satisfies Record<string, NotificationTypeMeta>;

export type NotificationType = keyof typeof NOTIFICATION_TYPE_META;
export const NOTIFICATION_TYPES = Object.keys(NOTIFICATION_TYPE_META) as NotificationType[];

/** The rules of a type; undefined for a string that is no known type (never sent). */
export const notificationTypeMeta = (type: string): NotificationTypeMeta | undefined =>
  Object.prototype.hasOwnProperty.call(NOTIFICATION_TYPE_META, type)
    ? NOTIFICATION_TYPE_META[type as NotificationType]
    : undefined;

/** The types a user cannot turn off. */
export const REQUIRED_NOTIFICATION_TYPES: readonly NotificationType[] = NOTIFICATION_TYPES.filter(
  (t) => NOTIFICATION_TYPE_META[t].required,
);

/** Which category a notification type belongs to (a type with none has no switch). */
export const CATEGORY_OF: Partial<Record<string, NotificationCategory>> = Object.fromEntries(
  NOTIFICATION_TYPES.flatMap((t) => {
    const c = NOTIFICATION_TYPE_META[t].category;
    return c ? [[t, c]] : [];
  }),
);

/** The bell, email, and the phone (Web Push, the planning notes "PWA"). */
export type NotificationChannel = 'in_app' | 'email' | 'push';

/** Categories a phone gets until the user (or the account default) says otherwise: assignment and mention only. */
export const PUSH_DEFAULT_CATEGORIES: readonly NotificationCategory[] = ['assigned', 'mentioned'];

/** One `notification_settings` row as the rules read it. `type` is a category or '*' (everything). */
export type SettingRow = {
  channel: NotificationChannel;
  type: string;
  board_id: string | null;
  enabled: boolean;
  digest: string;
};

/**
 * May `type` reach the user on `channel` for an item on `boardIds` (the board and, for a subitem, its parent)?
 * On unless a disabled row matches — its category or '*', account-wide or for one of those boards. The
 * strictest row wins, so a personal "off" always caps a board setting (08 §12.2).
 */
export const channelAllowed = (
  rows: SettingRow[],
  channel: NotificationChannel,
  type: string,
  boardIds: (string | null | undefined)[],
) => {
  const meta = notificationTypeMeta(type);
  if (!meta) return false;
  // A required type always reaches the bell and the email; the phone keeps its category's switch.
  if (meta.required && channel !== 'push') return true;
  const category = meta.category;
  if (!category) return false;
  return !rows.some(
    (r) =>
      r.channel === channel &&
      !r.enabled &&
      (r.type === '*' || r.type === category) &&
      (r.board_id === null || boardIds.includes(r.board_id)),
  );
};

/**
 * May `type` reach the user's phone? The push rows decide (`channelAllowed` on `push`), and a board silenced in my
 * bell (its own disabled rows) never buzzes the phone either — the board header has no separate phone column.
 */
export const pushAllowed = (rows: SettingRow[], type: string, boardIds: (string | null | undefined)[]) =>
  channelAllowed(rows, 'push', type, boardIds) &&
  channelAllowed(
    rows.filter((r) => r.board_id !== null),
    'in_app',
    type,
    boardIds,
  );

// ---- email summary (08 §12.3): instant, or one email a day / a week at a chosen local hour ----
export const DIGEST_FREQUENCIES = ['instant', 'daily', 'weekly'] as const;
export type DigestFrequency = (typeof DIGEST_FREQUENCIES)[number];
export type Digest = { frequency: DigestFrequency; hour: number; weekday: number };
export const DEFAULT_DIGEST: Digest = { frequency: 'instant', hour: 8, weekday: 0 };

/**
 * The `digest` column of the account-wide '*' email row: `instant`, `daily:<hour>` or `weekly:<weekday>:<hour>`
 * (weekday 0 = Sunday). A bare `daily` (before hours could be chosen) is 08:00.
 */
export const parseDigest = (s: string | null | undefined): Digest => {
  const [f, a, b] = (s ?? 'instant').split(':');
  const int = (v: string | undefined, max: number, fallback: number) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
  };
  if (f === 'daily') return { frequency: 'daily', hour: int(a, 23, 8), weekday: 0 };
  if (f === 'weekly') return { frequency: 'weekly', hour: int(b, 23, 8), weekday: int(a, 6, 0) };
  return DEFAULT_DIGEST;
};
export const formatDigest = (d: Digest) =>
  d.frequency === 'daily' ? `daily:${d.hour}` : d.frequency === 'weekly' ? `weekly:${d.weekday}:${d.hour}` : 'instant';

/** The user's summary choice: the account-wide '*' email row (after `withDefaults`). */
export const digestOf = (rows: SettingRow[]) =>
  parseDigest(rows.find((r) => r.channel === 'email' && r.type === '*' && r.board_id === null && r.enabled)?.digest);

/** The user takes a summary email (daily / weekly) instead of one per notification. */
export const wantsDigest = (rows: SettingRow[]) => digestOf(rows).frequency !== 'instant';

/**
 * Account defaults (`account_settings.notifications`, admins): what a member gets for a category / the summary
 * until they choose themselves. A personal row always wins.
 */
export const notificationDefaultsSchema = z
  .object({
    categories: z
      .array(
        z.object({
          key: z.enum(NOTIFICATION_CATEGORIES),
          bell: z.boolean(),
          email: z.boolean(),
          /** The phone; absent = PUSH_DEFAULT_CATEGORIES. */
          push: z.boolean().optional(),
        }),
      )
      .default([]),
    digest: z.enum(DIGEST_FREQUENCIES).default('instant'),
    digest_hour: z.number().int().min(0).max(23).default(8),
    digest_weekday: z.number().int().min(0).max(6).default(0),
  })
  .meta({ id: 'NotificationDefaults' });
export type NotificationDefaults = z.infer<typeof notificationDefaultsSchema>;

/**
 * A member's rows with the account defaults filled in where they have no account-wide row of their own: a default
 * "off" becomes a disabled row, a default summary becomes the '*' email row. Board rows are personal only.
 */
export const withDefaults = (rows: SettingRow[], defaults: NotificationDefaults | null | undefined): SettingRow[] => {
  const own = (channel: NotificationChannel, type: string) =>
    rows.some((r) => r.channel === channel && r.type === type && r.board_id === null);
  const out = [...rows];
  // The phone (PWA): off unless the account default (else PUSH_DEFAULT_CATEGORIES) turns a category on.
  for (const key of NOTIFICATION_CATEGORIES) {
    const on = defaults?.categories.find((c) => c.key === key)?.push ?? PUSH_DEFAULT_CATEGORIES.includes(key);
    if (!on && !own('push', key))
      out.push({ channel: 'push', type: key, board_id: null, enabled: false, digest: 'instant' });
  }
  if (!defaults) return out;
  for (const c of defaults.categories) {
    for (const [channel, on] of [
      ['in_app', c.bell],
      ['email', c.email],
    ] as const) {
      if (!on && !own(channel, c.key))
        out.push({ channel, type: c.key, board_id: null, enabled: false, digest: 'instant' });
    }
  }
  if (defaults.digest !== 'instant' && !own('email', '*'))
    out.push({
      channel: 'email',
      type: '*',
      board_id: null,
      enabled: true,
      digest: formatDigest({
        frequency: defaults.digest,
        hour: defaults.digest_hour,
        weekday: defaults.digest_weekday,
      }),
    });
  return out;
};

export const notificationSettingsSchema = z
  .object({
    categories: z.array(
      z.object({ key: z.enum(NOTIFICATION_CATEGORIES), bell: z.boolean(), email: z.boolean(), push: z.boolean() }),
    ),
    digest: z.enum(DIGEST_FREQUENCIES),
    /** Local hour (0–23) of the summary email; weekday (0 = Sunday) for the weekly one. */
    digest_hour: z.number().int(),
    digest_weekday: z.number().int(),
    /** Boards I muted for myself. */
    muted_boards: z.array(z.object({ id: z.string(), name: z.string() })),
    /** Phone quiet hours (local hours; the bell still gets everything). */
    quiet: z.object({ enabled: z.boolean(), from: z.number().int(), to: z.number().int() }),
    /** The unread count on the app icon. */
    badge: z.boolean(),
  })
  .meta({ id: 'NotificationSettings' });
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;

export const patchNotificationSettingsSchema = z
  .object({
    categories: z
      .array(
        z.object({
          key: z.enum(NOTIFICATION_CATEGORIES),
          bell: z.boolean().optional(),
          email: z.boolean().optional(),
          push: z.boolean().optional(),
        }),
      )
      .optional(),
    digest: z.enum(DIGEST_FREQUENCIES).optional(),
    digest_hour: z.number().int().min(0).max(23).optional(),
    digest_weekday: z.number().int().min(0).max(6).optional(),
    quiet: z
      .object({
        enabled: z.boolean(),
        from: z.number().int().min(0).max(23),
        to: z.number().int().min(0).max(23),
      })
      .optional(),
    badge: z.boolean().optional(),
  })
  .meta({ id: 'PatchNotificationSettings' });

/**
 * A board's notifications for me (board header): everything, muted, or custom — the categories I take from this
 * board (they only narrow my personal settings); plus the owners' "mute for everyone".
 */
const boardCategorySchema = z.object({ key: z.enum(NOTIFICATION_CATEGORIES), bell: z.boolean(), email: z.boolean() });
export const boardNotificationsSchema = z
  .object({
    mode: z.enum(['all', 'custom', 'muted']),
    muted: z.boolean(),
    categories: z.array(boardCategorySchema),
    muted_for_everyone: z.boolean(),
    can_mute_for_everyone: z.boolean(),
  })
  .meta({ id: 'BoardNotifications' });
export type BoardNotifications = z.infer<typeof boardNotificationsSchema>;

export const setBoardNotificationsSchema = z
  .object({
    /** `all` clears my rows for the board; `muted` silences it; `categories` = custom. */
    mode: z.enum(['all', 'muted']).optional(),
    muted: z.boolean().optional(),
    categories: z.array(boardCategorySchema).optional(),
    muted_for_everyone: z.boolean().optional(),
  })
  .meta({ id: 'SetBoardNotifications' });

export const followSchema = z.object({ following: z.boolean() }).meta({ id: 'Follow' });

export const notificationSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    created_at: z.string(),
    read_at: z.string().nullable(),
    /** Who did it (null for system notifications); the web takes the photo from the members list. */
    actor: z.object({ id: z.string(), name: z.string() }).nullable(),
    /** The board to open the item on: the parent board for a subitem (D14). */
    board: z.object({ id: z.string(), name: z.string() }).nullable(),
    item: z.object({ id: z.string(), name: z.string() }).nullable(),
    update_id: z.string().nullable(),
    /** First words of the update, or the column a person was assigned in. */
    excerpt: z.string().nullable(),
    column_title: z.string().nullable(),
    /** An agent's approval request (`agent_approval`): approve / reject right from the bell. */
    agent: z
      .object({
        agent_id: z.string(),
        agent_name: z.string().nullable(),
        run_id: z.string(),
        approval_id: z.string().nullable(),
      })
      .nullable()
      .optional(),
    /** A doc notification: the doc to open (and the comment thread, for a comment). */
    doc: z.object({ id: z.string(), name: z.string(), thread_id: z.string().nullable() }).nullable().optional(),
    /** A dashboard notification (`dashboard_shared`): the dashboard to open. */
    dashboard: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
    /** A support ticket notification: the ticket to open (its number and subject). */
    ticket: z.object({ id: z.string(), number: z.number().int(), subject: z.string() }).nullable().optional(),
    /**
     * An external flow: a `flow_failed` alert, or an automation's message about a flow — the click
     * opens that flow (and run) in the flows screen.
     */
    flow: z
      .object({ connection_id: z.string(), flow_id: z.string().nullable(), run_id: z.string().nullable() })
      .nullable()
      .optional(),
    /**
     * `relation_view_missing` (r19relfilter): the view that was deleted / made private, and the relation column that
     * offered its items (`column_key` null = a subitems column: the bell opens the board only).
     */
    relation_view: z.object({ view_name: z.string(), column_key: z.string().nullable() }).nullable().optional(),
  })
  .meta({ id: 'Notification' });
export type Notification = z.infer<typeof notificationSchema>;

export const notificationListSchema = z
  .object({
    data: z.array(notificationSchema),
    unread_count: z.number().int(),
    /** Pass as `?before=` for the next page; null on the last page. */
    next_cursor: z.string().nullable(),
  })
  .meta({ id: 'NotificationList' });
export type NotificationList = z.infer<typeof notificationListSchema>;

export const markReadSchema = z
  .union([z.object({ ids: z.array(z.string()).min(1).max(200) }), z.object({ all: z.literal(true) })])
  .meta({ id: 'MarkNotificationsRead' });
export type MarkRead = z.infer<typeof markReadSchema>;

/** One line for a notification — the bell row and the email subject say the same thing. */
export const notificationSentence = (
  n: {
    type: string;
    actor?: string | null;
    item?: string | null;
    column?: string | null;
  },
  /** The reader's language (emails: the recipient's); default = the runtime locale. */
  locale?: Locale,
) =>
  t(
    `notif.${n.type.replace('.', '_')}` as MessageKey,
    {
      actor: n.actor ?? '',
      item: n.item ?? t('notif.deletedItem', undefined, locale),
      column: n.column ?? '',
    },
    locale,
  );

/** Characters of an update kept in the notification (the card shows the rest). */
export const NOTIFICATION_EXCERPT = 140;
