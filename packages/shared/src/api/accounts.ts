// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { idocThemeSchema } from '../idocs/theme';
import { accountSlugSchema, accountStatusSchema } from '../account/slug';
import { newPasswordSchema } from './password';
import { ssoGateSchema } from '../platform/login-providers';
import {
  accountDefaultsSchema,
  accountSettingsSchema,
  announcementInputSchema,
  currencyCodeSchema,
  dateFormatSchema,
  accountToursSettingsSchema,
  downloadSettingsSchema,
  inboundEmailSettingsSchema,
  invitationSettingsSchema,
  sessionChecksSettingsSchema,
  patchOf,
  SMS_SEND_POLICIES,
  smsLimitsSchema,
  smsTemplateSchema,
  templateSetSchema,
} from '../account/settings';
import { accountPermissionsSchema, accountRoleSchema } from '../permissions/account';
import { isValidTimeZone } from '../locale/format';
import { accountCalendarSchema, calendarConfigSchema, platformCalendarSchema } from '../workdays/settings';
import { notificationDefaultsSchema } from './notifications';
import { updateAccountPwaSchema } from './pwa';
import { supportSessionSchema } from './support';
import { SUBSCRIPTION_STATUSES } from './plans';
import {
  brandColorSchema,
  dailyQuotaSchema,
  MAIL_STYLES,
  perMinuteLimitSchema,
  platformApiLimitsSchema,
  senderNameSchema,
  smsSenderIdSchema,
} from '../platform/settings';

/** DTOs for accounts, the owner console (D12), invitations and "me" (06-API §2.1–2.3). */

/** Who opened an account: the platform owner (console), the first-run setup, or a person's self sign-up (D32). */
export const ACCOUNT_ORIGINS = ['owner', 'setup', 'signup'] as const;
export type AccountOrigin = (typeof ACCOUNT_ORIGINS)[number];

export const accountSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: accountStatusSchema,
});

export const myAccountSchema = accountSummarySchema.extend({
  role: accountRoleSchema,
  /** The account's logo (A3): an asset id, shown through GET /accounts/{id}/logo; null / missing = the letter mark. */
  logo_asset_id: z.string().nullable().optional(),
  /**
   * Set when I am in this account by remote support access (no membership): the app shows the
   * support banner (mode + time left) and the server holds a view grant to reads.
   */
  support: supportSessionSchema.nullable().optional(),
  /**
   * The account's plan status as it holds now (plans): null = legacy (no subscription, unlimited); else
   * trial / active / past_due / read_only / suspended / closed, the billing settings' schedule applied. The app gates and
   * shows the read-only banner from it; `account.plan_changed` on /me/events says when to refetch.
   */
  plan_status: z.enum(SUBSCRIPTION_STATUSES).nullable().optional(),
  /** Since when `plan_status` holds (ISO); null for legacy. */
  plan_status_since: z.string().nullable().optional(),
  /** The owner's message about the status for this account (the closed screen: why); null = the platform's text. */
  plan_status_message: z.string().nullable().optional(),
  /** When the account becomes (or became) read-only by the schedule (ISO); null = none scheduled / legacy. */
  read_only_at: z.string().nullable().optional(),
  /**
   * The features the account's plan includes (plans): null = every feature (legacy, or a plan version
   * that lists none). The app hides / disables gated actions with `planIncludesFeature(plan_features, key)`.
   */
  plan_features: z.array(z.string()).nullable().optional(),
  /**
   * The enterprise features the installation's license key unlocks (LICENSING-OPTIONS B; empty / missing = none).
   * The app gates with `featureAllowed(plan_features, license_features, key)`.
   */
  license_features: z.array(z.string()).optional(),
  /**
   * when the account is deleted for good (ISO) — set while its deletion is scheduled; the app then
   * shows only the "scheduled for deletion" screen (admins can cancel there). Null / missing = not scheduled.
   */
  deletion_due_at: z.string().nullable().optional(),
  /** Who opened the account (the welcome card of a self sign-up account). */
  origin: z.enum(ACCOUNT_ORIGINS).optional(),
  /** While `plan_status` is `trial`: when the trial ends (ISO) — the "N trial days left" pill; else null. */
  trial_ends_at: z.string().nullable().optional(),
});
export type MyAccount = z.infer<typeof myAccountSchema>;

/**
 * My two-factor state (M8 ד12). `required` = an account I am active in requires it for my role (the strictest of my
 * accounts applies, D12); `deadline` = when its grace period ends; `must_enroll` = required, not on, and past it.
 */
export const myTwoFactorSchema = z.object({
  enabled: z.boolean(),
  required: z.boolean(),
  deadline: z.string().nullable(),
  must_enroll: z.boolean(),
});
export type MyTwoFactor = z.infer<typeof myTwoFactorSchema>;

export const meSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    email_verified: z.boolean(),
    is_platform_owner: z.boolean(),
    /** Platform support staff: opens only the owner console's Support section. */
    support_role: z.enum(['agent', 'lead']).nullable().optional(),
    locale: z.string(),
    /** null = never chosen: the account's timezone applies. */
    timezone: z.string().nullable(),
    avatar_url: z.string().nullable(),
    /** M8 ד12: 2FA state, so the app can ask for enrolment right after sign-in when an account requires it. */
    two_factor: myTwoFactorSchema.optional(),
    /** My accounts that require signing in through a provider I did not use this time. */
    sso_gate: z.array(ssoGateSchema).optional(),
    /**
     * S-77: the owner console requires two-factor sign-in (owner console → Platform settings → Security) and I (the
     * platform owner / support staff) have not turned it on — the console asks me to, before anything else.
     */
    console_two_factor_required: z.boolean().optional(),
  }),
  account: myAccountSchema.nullable(),
  last_account_id: z.string().nullable(),
});
export type Me = z.infer<typeof meSchema>;

export const accountDetailSchema = accountSummarySchema.extend({
  settings: accountSettingsSchema,
  /** Short-lived signed URL of the logo (A3), or null. */
  logo_url: z.string().nullable(),
  /** Admins: short-lived signed URL of the separate email logo (null = emails use the account logo). */
  email_logo_url: z.string().nullable().optional(),
  /**
   * Admins: what an empty account setting falls back to (the owner console's platform settings) — shown as the
   * placeholders of the email / SMS / API sections.
   */
  platform_defaults: z
    .object({
      product_name: z.string(),
      sms_sender_id: z.string().nullable(),
      api_limits: platformApiLimitsSchema,
      /** The accent an account's emails get when it chose none (the owner's, else the platform's colour). */
      email_accent_color: z.string().optional(),
      /** The look an account's emails get when it chose none (the owner's, else DEFAULT_MAIL_STYLE). */
      email_style: z.enum(MAIL_STYLES).optional(),
      /** The owner's calendar defaults: what each unset calendar field follows. */
      calendar: platformCalendarSchema.optional(),
      /** Incoming email: the platform's inbound domain, null = the platform has it off. */
      inbound_domain: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  /** The calendar the account works by: its own choices over the platform's, all resolved. */
  calendar: calendarConfigSchema.optional(),
  created_at: z.string(),
});
export type AccountDetail = z.infer<typeof accountDetailSchema>;

export const updateAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  settings: z
    .object({
      locale: patchOf(
        accountSettingsSchema.shape.locale.unwrap().extend({
          timezone: z.string().min(1).max(64).refine(isValidTimeZone, 'invalid_timezone'),
          date_format: dateFormatSchema,
          currency: currencyCodeSchema,
        }),
      ).optional(),
      /** Logos are set through PUT /accounts/me/logo (the upload is checked), not here. */
      branding: z
        .object({
          portal_name: z.string().trim().max(80).optional(),
          /** null = back to the account's name. */
          email_sender_name: senderNameSchema.nullable().optional(),
          /** null = no Reply-To. */
          email_reply_to: z.email().nullable().optional(),
          /** null = the platform's accent colour. */
          email_accent_color: brandColorSchema.nullable().optional(),
          /** null = the platform's look. */
          email_style: z.enum(MAIL_STYLES).nullable().optional(),
        })
        .optional(),
      /**
       * SMS (null sender_id = the platform's): who may send, saved templates (the whole list is replaced) and the
       * per-person / per-account budgets.
       */
      sms: z
        .object({
          sender_id: smsSenderIdSchema.nullable().optional(),
          send_policy: z.enum(SMS_SEND_POLICIES).optional(),
          templates: z
            .array(smsTemplateSchema)
            .max(100)
            .refine((t) => new Set(t.map((x) => x.id)).size === t.length, 'duplicate_template_id')
            .optional(),
          limits: patchOf(smsLimitsSchema).optional(),
        })
        .optional(),
      /** API-token budgets (null = the platform's). */
      api_limits: z
        .object({
          token_per_minute: perMinuteLimitSchema.nullable().optional(),
          service_token_per_minute: perMinuteLimitSchema.nullable().optional(),
          personal_daily: dailyQuotaSchema.nullable().optional(),
          service_daily: dailyQuotaSchema.nullable().optional(),
        })
        .optional(),
      domains: z
        .array(
          z
            .string()
            .toLowerCase()
            .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/),
        )
        .max(20)
        .optional(),
      permissions: patchOf(accountPermissionsSchema).optional(),
      notifications: patchOf(notificationDefaultsSchema).optional(),
      /** New boards, groups and columns (A3). */
      defaults: patchOf(accountDefaultsSchema).optional(),
      /** Interactive documents' default look: either audience, whole. */
      idoc_themes: z.object({ guests: idocThemeSchema.optional(), members: idocThemeSchema.optional() }).optional(),
      /** The system announcement banner (A3); null removes it. */
      announcement: announcementInputSchema.optional(),
      /** Invitations: link lifetime, resend wait, telling the inviter. */
      invitations: patchOf(invitationSettingsSchema).optional(),
      /** Outside work sessions: on / off and the check interval. */
      session_checks: patchOf(sessionChecksSettingsSchema).optional(),
      /** "Download all" as one ZIP: on / off and its limits. */
      downloads: patchOf(downloadSettingsSchema).optional(),
      /** Guided tours on / off for the account. */
      tours: patchOf(accountToursSettingsSchema).optional(),
      /** Incoming email: on / off, who may send, the allowed domains (the list is replaced). */
      inbound_email: patchOf(inboundEmailSettingsSchema).optional(),
      /** The phone app (PWA); null = back to the default. */
      pwa: updateAccountPwaSchema.optional(),
      /**
       * Calendar & working days: null = back to the platform's; `holidays` and `custom_days` replace
       * the stored ones.
       */
      calendar: z
        .object({
          holiday_set: accountCalendarSchema.shape.holiday_set.unwrap().nullable().optional(),
          hebrew_dates: accountCalendarSchema.shape.hebrew_dates.unwrap().nullable().optional(),
          duration: accountCalendarSchema.shape.duration.unwrap().nullable().optional(),
          half_day: accountCalendarSchema.shape.half_day.unwrap().nullable().optional(),
          picker_marks: accountCalendarSchema.shape.picker_marks.unwrap().nullable().optional(),
          holidays: accountCalendarSchema.shape.holidays.unwrap().optional(),
          custom_days: accountCalendarSchema.shape.custom_days.unwrap().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type UpdateAccount = z.infer<typeof updateAccountSchema>;

/** PUT /accounts/me/logo — the logo from one of my finished uploads (an image ≤2 MB). */
export const setAccountLogoSchema = z.object({ file_id: z.string() });

// ---- owner console ----
export const platformAccountSchema = accountSummarySchema.extend({
  created_at: z.string(),
  suspended_at: z.string().nullable(),
  members: z.object({ admin: z.number(), member: z.number(), viewer: z.number(), guest: z.number() }),
  pending_invitations: z.number(),
  /** My active support grant there (the owner console's "enter support"); null = none. */
  support: supportSessionSchema.nullable().optional(),
  /** the account is scheduled for deletion on this date (ISO); null = not scheduled. */
  deletion_due_at: z.string().nullable().optional(),
  /** Who opened the account (the console's "source" column and filter). */
  origin: z.enum(ACCOUNT_ORIGINS).optional(),
});
export type PlatformAccount = z.infer<typeof platformAccountSchema>;

export const createAccountSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: accountSlugSchema,
  first_admin_email: z.email().toLowerCase(),
  template_set: templateSetSchema.default('empty'),
  timezone: z.string().optional(),
  currency: z.string().length(3).optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updatePlatformAccountSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: accountSlugSchema.optional(),
});

export const suspendAccountSchema = z.object({ reason: z.string().trim().min(1).max(500) });
export const deleteAccountSchema = z.object({ confirm_slug: z.string() });
export const inviteAdminSchema = z.object({ email: z.email().toLowerCase() });
/**
 * POST /platform/accounts/{id}/invitations: the owner console invites anyone to an account it manages
 * the first admin or any other person. The back-door rule of invite-admin holds for every role.
 */
export const platformInviteSchema = z.object({
  email: z.email().toLowerCase(),
  role: accountRoleSchema.default('admin'),
  /** false = no email, only the link to copy ("copy link"). */
  send_email: z.boolean().default(true),
});

// ---- invitations ----
/**
 * Where a pending invitation stands: `link` = never emailed (copy-link only), `sent` = emailed
 * `failed` = the last email could not be sent, `opened` = the link was opened, `expired` = past its date (re-send
 * renews it). Accepted and cancelled invitations are not listed.
 */
export const INVITATION_STATUSES = ['link', 'sent', 'failed', 'opened', 'expired'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: accountRoleSchema,
  expires_at: z.string(),
  created_at: z.string(),
  status: z.enum(INVITATION_STATUSES).optional(),
  /** Who invited (lists only); null = gone / the platform. */
  invited_by: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
  /** When the email last went out (null = never emailed) and how many times it did. */
  last_sent_at: z.string().nullable().optional(),
  send_count: z.number().int().optional(),
  /** When the link was first opened (null = not yet). */
  opened_at: z.string().nullable().optional(),
  /**
   * The invitation link itself (fix8: "מה הגיבוי שלי אם המיילים לא עובדים") — only in the answer to whoever
   * just issued it (invite, resend, copy link), never in lists: only its hash is stored. Share it by WhatsApp etc.
   */
  url: z.string().optional(),
});

export const inviteUsersSchema = z.object({
  emails: z.array(z.email().toLowerCase()).min(1).max(50),
  role: accountRoleSchema,
  message: z.string().max(1000).optional(),
  /** Boards to subscribe the invitee to on accepting (inviting from a board's permissions dialog, M7). */
  board_ids: z.array(z.string()).max(20).optional(),
  /** false = no email, only the links to copy; default true. */
  send_email: z.boolean().optional(),
});

/**
 * POST …/invitations/{id}/resend and …/link `?expires_in_days=`: the same invitation (id, inviter, role
 * access) gets a new link — the earlier link stops working — valid that many days (default: the account's setting).
 */
export const resendInvitationQuerySchema = z.object({
  expires_in_days: z.coerce.number().int().min(1).max(90).optional(),
});

export const inviteResultSchema = z.object({
  invited: z.array(invitationSchema),
  errors: z.array(z.object({ email: z.string(), code: z.string() })),
});

/**
 * A one-time link that lets a member choose a new password and sign in (fix8): made by an account admin (or the
 * platform owner) when email does not reach them. Copied, never emailed; short-lived and single-use.
 */
export const recoveryLinkSchema = z.object({ url: z.string(), expires_at: z.string() });
export type RecoveryLink = z.infer<typeof recoveryLinkSchema>;
export const ownerRecoveryLinkSchema = z.object({ email: z.email().toLowerCase() });

/** GET /me/security — how I can sign in (the profile's "כניסה ואבטחה" section). */
export const mySecuritySchema = z.object({
  has_password: z.boolean(),
  /** Other ways in besides email links: e.g. `google`. */
  providers: z.array(z.string()),
  two_factor: myTwoFactorSchema,
  /** The shortest new password I may choose (the strictest of my accounts, else the platform's). */
  password_min_length: z.number().int(),
});
export type MySecurity = z.infer<typeof mySecuritySchema>;
/** POST /me/password — set a first password (only when there is none; changing one needs the current one). */
export const setPasswordSchema = z.object({ new_password: newPasswordSchema });

/** Public preview behind /invite/:token — just enough to render the landing page. */
export const invitationPreviewSchema = z.object({
  account: z.object({ name: z.string(), slug: z.string() }),
  email: z.string(),
  role: accountRoleSchema,
  expires_at: z.string(),
  /** The shortest password the sign-up may choose (the account's setting, else the platform's). */
  password_min_length: z.number().int(),
});

export const myInvitationSchema = invitationSchema.extend({
  account: z.object({ id: z.string(), name: z.string(), slug: z.string() }),
});

export const memberSchema = z.object({
  user_id: z.string(),
  email: z.string(),
  name: z.string(),
  role: accountRoleSchema,
  status: z.enum(['invited', 'active', 'deactivated']),
  joined_at: z.string().nullable(),
  /** Uploaded photo (short-lived signed URL) or the sign-in provider's picture; null = show initials. */
  avatar_url: z.string().nullable(),
  /** Profile (fix2): job title, phone and department, when set. */
  title: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  department: z.string().nullable().optional(),
  /** Administration → users (account admin A2): the member's teams in this account. */
  teams: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  /** Last time the person was seen signed in (admins only; null = never / not shown). */
  last_seen_at: z.string().nullable().optional(),
  deactivated_at: z.string().nullable().optional(),
  /** "Delete details" ran (08 §3.2): the content stays under "משתמש שנמחק". */
  anonymised: z.boolean().optional(),
  /** Admins only (privacy): when the person asked for their details to be deleted (null = no request). */
  erasure_requested_at: z.string().nullable().optional(),
  /** Admins only (M8 ד12): the person signs in with a second factor. */
  two_factor_enabled: z.boolean().nullable().optional(),
  /**
   * Admins only (S-63): the name shows in other accounts too (active there, the platform owner, support staff), so
   * an admin here cannot change it — PATCH /users/:id answers 409 `name_managed_elsewhere`.
   */
  name_managed_elsewhere: z.boolean().nullable().optional(),
});
export type MemberDto = z.infer<typeof memberSchema>;

// ---- administration → users (08 §3, account admin A2) ----
export const memberStatusSchema = z.enum(['invited', 'active', 'deactivated']);

/** GET /users filters (all optional): role, status, team and a name / email search. */
export const listUsersQuerySchema = z.object({
  role: accountRoleSchema.optional(),
  status: memberStatusSchema.optional(),
  team_id: z.string().optional(),
  q: z.string().trim().max(120).optional(),
});
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;

/** PATCH /users/:id (admins): role and profile fields; "" clears a field. Never your own role. */
export const updateUserSchema = z.object({
  role: accountRoleSchema.optional(),
  name: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().max(120).optional(),
  department: z.string().trim().max(120).optional(),
  phone: z.string().trim().max(32).optional(),
});
export type UpdateUser = z.infer<typeof updateUserSchema>;

/** What "transfer ownership" moves (08 §3.2; decided 2026-10-04: people-column assignments too, by choice). */
export const transferScopeSchema = z.enum(['boards', 'automations', 'webhooks', 'service_tokens', 'assignments']);
export type TransferScope = z.infer<typeof transferScopeSchema>;
export const TRANSFER_SCOPES = transferScopeSchema.options;

export const transferOwnershipSchema = z.object({
  to_user_id: z.string(),
  scope: z.array(transferScopeSchema).min(1).max(5),
});
export type TransferOwnership = z.infer<typeof transferOwnershipSchema>;

export const transferResultSchema = z.object({
  boards: z.number(),
  automations: z.number(),
  webhooks: z.number(),
  service_tokens: z.number(),
  assignments: z.number(),
  /** One activity batch for the whole transfer (null when nothing moved). */
  batch_id: z.string().nullable(),
});
export type TransferResult = z.infer<typeof transferResultSchema>;

/** POST /users/:id/deactivate — optionally transfers first, in the same transaction. */
export const deactivateUserSchema = z.object({ transfer: transferOwnershipSchema.optional() });

/** DELETE /users/:id/details?display= — how the name shows from now on (08 §3.2). */
export const deleteUserDetailsSchema = z.object({
  display: z.enum(['deleted', 'first_name']).default('deleted'),
});

/**
 * POST /users/bulk (≤200; never yourself). `ids` are user ids, except for `resend`: pending invitation ids.
 */
export const bulkUsersSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('set_role'), ids: z.array(z.string()).min(1).max(200), role: accountRoleSchema }),
  z.object({ op: z.literal('deactivate'), ids: z.array(z.string()).min(1).max(200) }),
  z.object({ op: z.literal('activate'), ids: z.array(z.string()).min(1).max(200) }),
  z.object({ op: z.literal('resend'), ids: z.array(z.string()).min(1).max(200) }),
]);
export type BulkUsers = z.infer<typeof bulkUsersSchema>;

export const bulkUsersResultSchema = z.object({
  done: z.number(),
  skipped: z.array(z.object({ id: z.string(), code: z.string() })),
});
export type BulkUsersResult = z.infer<typeof bulkUsersResultSchema>;

/** The account's default "transfer to" person, offered first in the deactivate dialog (decided 2026-10-04). */
export const defaultTransferUserSchema = z.object({ user_id: z.string().nullable() });
export type DefaultTransferUser = z.infer<typeof defaultTransferUserSchema>;

export const setAvatarSchema = z.object({ file_id: z.string() });

/**
 * Every email the platform sends (M11): Administration → Emails & SMS previews any of them with sample data, in
 * either language, and sends one to the admin as a test.
 */
export const MAIL_TEMPLATE_KEYS = [
  'invitation',
  'magic_link',
  'reset_password',
  'notification',
  'digest',
  'automation',
  'diagnostic',
] as const;
export type MailTemplateKey = (typeof MAIL_TEMPLATE_KEYS)[number];

export const emailPreviewQuerySchema = z.object({
  template: z.enum(MAIL_TEMPLATE_KEYS),
  locale: z.enum(['he', 'en']),
  /** An unsaved accent colour to try (#rrggbb); empty = the saved one. */
  accent: brandColorSchema.optional(),
  /** An unsaved look to try; empty = the saved one. */
  style: z.enum(MAIL_STYLES).optional(),
});
export type EmailPreviewQuery = z.infer<typeof emailPreviewQuerySchema>;

export const emailPreviewSchema = z
  .object({
    subject: z.string(),
    html: z.string(),
    text: z.string(),
    from_name: z.string(),
    reply_to: z.string().nullable(),
  })
  .meta({ id: 'EmailPreview' });
export type EmailPreview = z.infer<typeof emailPreviewSchema>;

export const sendTestEmailSchema = z.object({
  template: z.enum(MAIL_TEMPLATE_KEYS),
  locale: z.enum(['he', 'en']),
});
export type SendTestEmail = z.infer<typeof sendTestEmailSchema>;

export const testEmailResultSchema = z
  .object({
    /** The admin's own address — a test never goes anywhere else. */
    to: z.string(),
    sent: z.boolean(),
    /** Why nothing was sent: the address is not on MAIL_ALLOWLIST (staging). */
    skipped: z.enum(['not_allowlisted']).nullable(),
  })
  .meta({ id: 'TestEmailResult' });
export type TestEmailResult = z.infer<typeof testEmailResultSchema>;
