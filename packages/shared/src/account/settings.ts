// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { accountPermissionsSchema } from '../permissions/account';
import { idocAccountThemesSchema } from '../idocs/theme';
import { notificationDefaultsSchema } from '../api/notifications';
import { mapSettingsSchema } from '../api/geo';
import { accountPwaSettingsSchema } from '../api/pwa';
import { isCountryCode } from '../columns/countries';
import { accountCalendarSchema } from '../workdays/settings';
import { accountOnboardingSchema } from '../api/onboarding';
import {
  defaultStatusLabels,
  GROUP_AUTO_COLORS,
  GROUP_COLOR_KEYS,
  groupColorInputSchema,
  labelColorSchema,
  type GroupColor,
} from '../colors';
import { DEFAULT_EMAIL_OPEN, DEFAULT_ICON_STYLE, EMAIL_OPENS, ICON_STYLES } from '../api/appearance';
import { CARD_MAX_PCT_RANGE, CARD_MIN_PX_RANGE, CARD_WIDTH_DEFAULTS, CARD_WIDTH_PCT_RANGE } from '../views/card-width';
import {
  accountApiLimitsSchema,
  brandColorSchema,
  MAIL_STYLES,
  mailDomainSchema,
  senderNameSchema,
  smsSenderIdSchema,
} from '../platform/settings';

type PatchShape<S extends z.ZodRawShape> = {
  [K in keyof S]: z.ZodOptional<S[K] extends z.ZodDefault<infer I> ? I : S[K]>;
};
/**
 * A PATCH body for an object: every field optional and without its default, so a field that was not sent stays
 * missing (zod's `.partial()` keeps defaults and would reset what the caller did not touch).
 */
export const patchOf = <S extends z.ZodRawShape>(o: z.ZodObject<S>) =>
  z.object(
    Object.fromEntries(
      Object.entries(o.shape).map(([k, v]) => [
        k,
        ((v instanceof z.ZodDefault ? v.unwrap() : v) as z.ZodType).optional(),
      ]),
    ),
  ) as unknown as z.ZodObject<PatchShape<S>>;

/** Date formats an account can choose (08 §2); the default for every member's dates. */
export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD.MM.YYYY'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export const dateFormatSchema = z.enum(DATE_FORMATS);

/** Currencies offered in the account settings (any ISO 4217 code is accepted by the API). */
export const COMMON_CURRENCIES = ['ILS', 'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD'] as const;
export const currencyCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/);

/** The sign of an ISO currency ("ILS" → "₪"), for number columns shown as money. */
export const currencySymbol = (code: string): string => {
  try {
    const part = new Intl.NumberFormat('en', { style: 'currency', currency: code, currencyDisplay: 'narrowSymbol' })
      .formatToParts(0)
      .find((p) => p.type === 'currency');
    return part?.value ?? code;
  } catch {
    return code;
  }
};

/** One label of the default status set for new status columns (ids and order are given when a column is made). */
export const defaultStatusLabelSchema = z.object({
  label: z.string().trim().max(30),
  color: labelColorSchema,
  is_done: z.boolean().optional(),
});
export type DefaultStatusLabel = z.infer<typeof defaultStatusLabelSchema>;

const builtinStatusLabels = (lang?: string): DefaultStatusLabel[] =>
  defaultStatusLabels(lang).map((l) => ({
    label: l.label,
    color: l.color,
    ...(l.is_done ? { is_done: true } : {}),
  }));

/**
 * What new boards, groups and columns start with (08 §2 `defaults`): status labels for a new status column, the
 * item terminology of a new blank board, the order of group colours (empty = the palette order) and whether a new
 * numbers column shows a thousands separator. Also `NewColumnDefaults` (columns/types).
 */
export const accountDefaultsSchema = z.object({
  status_labels: z
    .array(defaultStatusLabelSchema)
    .min(1)
    .max(40)
    .default(() => builtinStatusLabels()),
  item_terminology: z.string().trim().min(1).max(40).default('item'),
  group_colors: z.array(groupColorInputSchema).max(GROUP_COLOR_KEYS.length).default([]),
  /** F9 cardw: the item card's default width (% of the window); a user's dragged width wins. */
  card_width_pct: z
    .number()
    .int()
    .min(CARD_WIDTH_PCT_RANGE.min)
    .max(CARD_WIDTH_PCT_RANGE.max)
    .default(CARD_WIDTH_DEFAULTS.card_width_pct),
  /** F9 cardw: the narrowest the item card may be dragged (px). */
  card_min_px: z
    .number()
    .int()
    .min(CARD_MIN_PX_RANGE.min)
    .max(CARD_MIN_PX_RANGE.max)
    .default(CARD_WIDTH_DEFAULTS.card_min_px),
  /** F9 cardw: the widest the item card may be dragged (% of the window; the board always keeps 120px). */
  card_max_pct: z
    .number()
    .int()
    .min(CARD_MAX_PCT_RANGE.min)
    .max(CARD_MAX_PCT_RANGE.max)
    .default(CARD_WIDTH_DEFAULTS.card_max_pct),
  /** the icon style of members who never chose their own (Profile → Appearance). */
  icon_style: z.enum(ICON_STYLES).default(DEFAULT_ICON_STYLE),
  /** what a click on an email address does for members who never chose (Profile → Appearance). */
  email_open: z.enum(EMAIL_OPENS).default(DEFAULT_EMAIL_OPEN),
  /** a new numbers column shows a thousands separator (1,000); each column can change it. */
  number_thousands: z.boolean().default(true),
});
export type AccountDefaults = z.infer<typeof accountDefaultsSchema>;

/** A system announcement shown at the top of the app to every member until dismissed or `until` (inclusive) passes. */
export const announcementSchema = z.object({
  /** Changes whenever the text, link or date changes, so a new announcement shows again to who dismissed the last. */
  id: z.string(),
  text: z.string().trim().min(1).max(150),
  url: z.string().max(500).optional(),
  until: z.iso.date().optional(),
  updated_at: z.string(),
});
export type Announcement = z.infer<typeof announcementSchema>;

/** PATCH input for the announcement (`null` removes it). */
export const announcementInputSchema = z
  .object({
    text: z.string().trim().min(1).max(150),
    url: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
    until: z.iso.date().optional(),
  })
  .nullable();
export type AnnouncementInput = z.infer<typeof announcementInputSchema>;

/** Is the announcement still showing on `today` (YYYY-MM-DD, the viewer's date)? */
export const announcementActive = (a: Announcement | null | undefined, today: string): a is Announcement =>
  !!a && (!a.until || a.until >= today);

/** Status labels for a new status column from the account's defaults: ids and order 0…n. */
export const statusLabelsFromDefaults = (labels: DefaultStatusLabel[]) =>
  labels.map((l, i) => ({ id: i, label: l.label, color: l.color, index: i, ...(l.is_done ? { is_done: true } : {}) }));

/** The colour of a board's next group: the account's order first, then `GROUP_AUTO_COLORS` (the vivid colours first, brand colours leading); unused before used. */
export const nextGroupColor = (used: Iterable<string>, preferred: readonly GroupColor[] = []): GroupColor => {
  const taken = new Set(used);
  const order = [...preferred, ...GROUP_AUTO_COLORS.filter((k) => !preferred.includes(k))];
  return order.find((c) => !taken.has(c)) ?? order[0] ?? 'forest';
};

/** Who may send SMS from the system: guests never, whatever is chosen. */
export const SMS_SEND_POLICIES = ['admins', 'members', 'nobody'] as const;
export type SmsSendPolicy = (typeof SMS_SEND_POLICIES)[number];

/** TextMe's limit of one message; a provider with another limit gets its own setting when it lands. */
export const SMS_MAX_LENGTH = 1005;

/** A saved SMS text (Administration → SMS): `{item.name}`, `{item.<column>}` etc. are filled from the item. */
export const smsTemplateSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/),
  name: z.string().trim().min(1).max(80),
  text: z.string().trim().min(1).max(SMS_MAX_LENGTH),
});
export type SmsTemplate = z.infer<typeof smsTemplateSchema>;

/** SMS budgets (SMS costs money): sends per person per hour and per account per day. */
export const smsLimitsSchema = z.object({
  per_user_per_hour: z.number().int().min(1).max(10_000).default(30),
  per_account_per_day: z.number().int().min(1).max(1_000_000).default(500),
});
export type SmsLimits = z.infer<typeof smsLimitsSchema>;

export const accountSmsSettingsSchema = z.object({
  /** The account's sender id (empty = the platform's, then TEXTME_SENDER_ID). */
  sender_id: smsSenderIdSchema.optional(),
  /** Who may send SMS from items (POST /items/{id}/sms); automations follow their owner's role. */
  send_policy: z.enum(SMS_SEND_POLICIES).default('members'),
  templates: z.array(smsTemplateSchema).max(100).default([]),
  limits: smsLimitsSchema.default(() => smsLimitsSchema.parse({})),
});
export type AccountSmsSettings = z.infer<typeof accountSmsSettingsSchema>;

/**
 * Invitations: how long a link lives, how soon the same invitation may be emailed again, and whether
 * the inviter hears when it is accepted. Administration → Users → invitation settings.
 */
export const invitationSettingsSchema = z.object({
  /** Days a new (or re-sent) invitation link stays valid. */
  expiry_days: z.number().int().min(1).max(90).default(7),
  /** Minutes before the same invitation may be emailed again (0 = no wait; the hourly email budget still holds). */
  resend_cooldown_minutes: z.number().int().min(0).max(1440).default(0),
  /** Tell the inviter (bell + email, by their notification settings) when the invitation is accepted. */
  notify_inviter: z.boolean().default(true),
});
export type InvitationSettings = z.infer<typeof invitationSettingsSchema>;

/**
 * Outside work sessions: tools such as code sessions that check the account every few minutes for
 * what changed on the items marked as theirs, and answer there. Their check script reads this first — off (the
 * default) = they do not check at all; on = they check every `interval_minutes`. Administration → Connections.
 */
export const sessionChecksSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  interval_minutes: z.number().int().min(5).max(1440).default(15),
});
export type SessionChecksSettings = z.infer<typeof sessionChecksSettingsSchema>;

/**
 * Downloading several files at once: "download all" on a files cell or an update packs them into one
 * ZIP, streamed by the server. Off = no such button; the limits keep one download from tying up the server.
 * Administration → General → downloads.
 */
export const downloadSettingsSchema = z.object({
  zip_enabled: z.boolean().default(true),
  /** At most this many files in one ZIP. */
  zip_max_files: z.number().int().min(2).max(1000).default(200),
  /** At most this many megabytes (before packing) in one ZIP. */
  zip_max_mb: z.number().int().min(1).max(4000).default(1024),
});
export type DownloadSettings = z.infer<typeof downloadSettingsSchema>;

/** Guided tours: the account's admins may turn them off for everyone in it (Administration → General). */
export const accountToursSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** "First steps" for the account's people. */
  first_steps: z.boolean().default(true),
});
export type AccountToursSettings = z.infer<typeof accountToursSettingsSchema>;

/** Who may write to an item's or a board's email address. */
export const INBOUND_SENDER_POLICIES = ['anyone', 'members', 'domains'] as const;
export type InboundSenderPolicy = (typeof INBOUND_SENDER_POLICIES)[number];
/**
 * Incoming email: mail to an item's address becomes an update on it, mail to a board's address a new
 * item. On by default (works once the platform owner sets the inbound domain; an account turns it off); `senders`:
 * anyone (an unknown sender shows as external), the account's members only, or the listed domains (members always
 * may). Administration → Connections.
 */
export const inboundEmailSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  senders: z.enum(INBOUND_SENDER_POLICIES).default('anyone'),
  domains: z.array(mailDomainSchema).max(50).default([]),
  /**
   * the images inside the message body (`cid:` / embedded) are kept as files of the update and shown in
   * place; images smaller than `body_image_min_kb` (signature logos, spacers) are skipped.
   */
  body_images: z.boolean().default(true),
  body_image_min_kb: z.number().int().min(0).max(1024).default(10),
  /**
   * Images the message loads from the web: shown through the app (the sender never sees the reader's address), never
   * stored. Off = not shown at all.
   */
  remote_images: z.boolean().default(true),
});
export type InboundEmailSettings = z.infer<typeof inboundEmailSettingsSchema>;

/** `account_settings.settings` (08 §2). Fields are added here as features land; unknown keys are preserved. */
export const accountSettingsSchema = z
  .object({
    branding: z
      .object({
        portal_name: z.string().max(80).optional(),
        logo_asset_id: z.string().optional(),
        /** A separate logo for emails (else the account logo); set through PUT /accounts/me/email-logo. */
        email_logo_asset_id: z.string().optional(),
        portal_logo_asset_id: z.string().optional(),
        /** The From name of the account's emails (empty = the account's name; ANSWERS 6א.3). */
        email_sender_name: senderNameSchema.optional(),
        /** Reply-To of the account's emails (empty = none). */
        email_reply_to: z.email().optional(),
        /** Accent colour of the account's emails (empty = the platform's; M11). */
        email_accent_color: brandColorSchema.optional(),
        /** How the account's emails look (empty = the platform's; canvas 2026-11-04). */
        email_style: z.enum(MAIL_STYLES).optional(),
      })
      .default({}),
    locale: z
      .object({
        language: z.enum(['he', 'en']).default('he'),
        timezone: z.string().default('Asia/Jerusalem'),
        weekend: z.enum(['fri_sat', 'sat_sun']).default('fri_sat'),
        first_day: z.number().int().min(0).max(6).default(0),
        date_format: z.string().default('DD/MM/YYYY'),
        time_format: z.enum(['24h', '12h']).default('24h'),
        currency: z.string().length(3).default('ILS'),
        /** The account's country (ISO 3166-1): phone numbers typed without a country code fall back to it. */
        country: z
          .string()
          .length(2)
          .toUpperCase()
          .refine((c) => isCountryCode(c), 'invalid_country')
          .default('IL'),
      })
      .default({
        language: 'he',
        timezone: 'Asia/Jerusalem',
        weekend: 'fri_sat',
        first_day: 0,
        date_format: 'DD/MM/YYYY',
        time_format: '24h',
        currency: 'ILS',
        country: 'IL',
      }),
    domains: z.array(z.string().toLowerCase()).default([]),
    permissions: accountPermissionsSchema.default(accountPermissionsSchema.parse({})),
    /** Built-in templates an admin removed from this account's list (or replaced by an edited copy). */
    hidden_templates: z.array(z.string()).default([]),
    /** Notification defaults for members who haven't chosen (admins; 08 §12.3). */
    notifications: notificationDefaultsSchema.default(notificationDefaultsSchema.parse({})),
    /** Defaults for new boards, groups and columns (account admin A3). */
    defaults: accountDefaultsSchema.default(() => accountDefaultsSchema.parse({})),
    /** Interactive documents' default look, for guests and for the account's members. */
    idoc_themes: idocAccountThemesSchema.default(() => idocAccountThemesSchema.parse({})),
    /** The system announcement banner, or null (account admin A3). */
    announcement: announcementSchema.nullable().default(null),
    /** Map tiles and geocoding (M8 ד10): Administration → Connections. */
    maps: mapSettingsSchema.default(() => mapSettingsSchema.parse({})),
    /** SMS (ANSWERS 6א.8): the account's sender id (empty = the platform's, then TEXTME_SENDER_ID). */
    sms: accountSmsSettingsSchema.default(() => accountSmsSettingsSchema.parse({})),
    /** API-token budgets of this account (ANSWERS 6א.9); unset = the platform's (owner console). */
    api_limits: accountApiLimitsSchema.default({}),
    /** Invitations: link lifetime, resend wait, telling the inviter. */
    invitations: invitationSettingsSchema.default(() => invitationSettingsSchema.parse({})),
    /** Outside work sessions: whether they check the account, and how often. Off by default. */
    session_checks: sessionChecksSettingsSchema.default(() => sessionChecksSettingsSchema.parse({})),
    /** "Download all" as one ZIP: on / off and its limits. */
    downloads: downloadSettingsSchema.default(() => downloadSettingsSchema.parse({})),
    /** Guided tours on / off for the account. */
    tours: accountToursSettingsSchema.default(() => accountToursSettingsSchema.parse({})),
    /** Incoming email to items and boards: on / off and who may send. */
    inbound_email: inboundEmailSettingsSchema.default(() => inboundEmailSettingsSchema.parse({})),
    /** The phone app (PWA): home-screen name / colour / first screen, install bar, push, lock screen. */
    pwa: accountPwaSettingsSchema.default(() => accountPwaSettingsSchema.parse({})),
    /** Calendar & working days: Hebrew dates, holidays, the account's own days; unset = the platform's. */
    calendar: accountCalendarSchema.default(() => accountCalendarSchema.parse({})),
    /** "How to start?": whether the admin still sees the start screen, and what was chosen. */
    onboarding: accountOnboardingSchema.default(() => accountOnboardingSchema.parse({})),
  })
  .loose();

export type AccountSettings = z.infer<typeof accountSettingsSchema>;

const sameLabels = (a: DefaultStatusLabel[], b: DefaultStatusLabel[]) =>
  a.length === b.length &&
  a.every((l, i) => l.label === b[i]!.label && l.color === b[i]!.color && !!l.is_done === !!b[i]!.is_done);

/**
 * The account's defaults (08 §2) from its stored settings: default status labels the account never changed (none
 * stored, or the built-in trio as saved with other settings) are ours in its language — in progress / done / blocked,
 * Hebrew or English.
 */
export const accountDefaultsOf = (stored: unknown): AccountSettings['defaults'] => {
  const s = accountSettingsSchema.parse(stored ?? {});
  const builtin = (['he', 'en'] as const).some((l) => sameLabels(s.defaults.status_labels, builtinStatusLabels(l)));
  return builtin ? { ...s.defaults, status_labels: builtinStatusLabels(s.locale.language) } : s.defaults;
};

export const defaultAccountSettings = (overrides: { timezone?: string; currency?: string } = {}): AccountSettings => {
  const settings = accountSettingsSchema.parse({});
  if (overrides.timezone) settings.locale.timezone = overrides.timezone;
  if (overrides.currency) settings.locale.currency = overrides.currency;
  return settings;
};

/**
 * Opening kit for a new account (D12, D27 ת1): `empty`, `default` (the platform's default starter pack) or the key
 * of a starter pack in the platform catalog (seed/packs). The code knows no kit by name — kits are data packs.
 */
export const templateSetSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/, 'starter_kit_invalid');
export type TemplateSet = z.infer<typeof templateSetSchema>;
export const DEFAULT_STARTER = 'default';
