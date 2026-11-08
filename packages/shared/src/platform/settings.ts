// SPDX-License-Identifier: AGPL-3.0-only
import { accountDeletionSettingsSchema } from '../api/account-deletion';
import { z } from 'zod';
import { authCaptchaSchema } from '../api/captcha';
import { FLOW_PLATFORMS } from '../api/flows';
import { mapOriginSchema } from '../api/geo';
import { inboundLimitSchema } from '../api/inbound-email';
import { subProcessorSchema } from '../api/legal';

/** A mail domain (`example.co.il` / `in.example.com`), lower-case, without `@`. */
export const mailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .regex(/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'invalid_domain');

/** A private AI server's origin: http or https, a host (name, IPv4 or bracketed IPv6), an optional port — no path. */
export const localAiOriginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(300)
  .regex(/^https?:\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(:\d{1,5})?$/, 'origin_invalid');
import { DEFAULT_PASSWORD_MIN_LENGTH, passwordMinLengthSchema } from '../api/password';
import { platformSupportSettingsSchema, updatePlatformSupportSettingsSchema } from '../api/support';
import { platformIntegrationsSchema, updatePlatformIntegrationsSchema } from './integrations';
import { platformPublicAddressSchema, updatePlatformPublicAddressSchema } from './public-address';
import { platformCalendarSchema } from '../workdays/settings';

export * from './integrations';
export * from './public-address';

/**
 * Platform-wide settings (owner console, ANSWERS 6א.3/8/9): the product's name (white-label), the sender of emails
 * that belong to no account (sign-in links, password resets), the SMS sender and the API-token budgets. Every field
 * is optional or has a default: an empty row means "the platform defaults" (the product name then comes from i18n
 * `app.name`, the email address and SMS sender from the environment).
 */

/** Sane bounds for every API budget (per minute / per day) the owner, an admin or a token may set. */
export const API_LIMIT_BOUNDS = {
  per_minute: { min: 1, max: 20_000 },
  daily: { min: 1, max: 5_000_000 },
} as const;

export const perMinuteLimitSchema = z
  .number()
  .int()
  .min(API_LIMIT_BOUNDS.per_minute.min)
  .max(API_LIMIT_BOUNDS.per_minute.max);
export const dailyQuotaSchema = z.number().int().min(API_LIMIT_BOUNDS.daily.min).max(API_LIMIT_BOUNDS.daily.max);

/** The platform's defaults for API tokens (06 §1.10). An account may override them; a token may override both. */
export const platformApiLimitsSchema = z.object({
  /** Requests a minute of one personal token (and of one OAuth / MCP connection). */
  token_per_minute: perMinuteLimitSchema.default(600),
  /** Requests a minute of one service token. */
  service_token_per_minute: perMinuteLimitSchema.default(1200),
  /** Requests a day of one personal token. */
  personal_daily: dailyQuotaSchema.default(10_000),
  /** Requests a day of one service token. */
  service_daily: dailyQuotaSchema.default(50_000),
});
export type PlatformApiLimits = z.infer<typeof platformApiLimitsSchema>;

/** An SMS sender id (TextMe "source"): up to 11 letters / digits / spaces, or a phone number. */
export const smsSenderIdSchema = z
  .string()
  .trim()
  .min(2)
  .max(15)
  .regex(/^(?:[A-Za-z0-9 .-]{2,11}|\+?\d{3,15})$/, 'sms_sender_invalid');

/** A display name in a From header: no line breaks, quotes or angle brackets (they would break the header). */
export const senderNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[^\r\n"<>]+$/, 'sender_name_invalid');

/** A brand colour (#rrggbb). */
export const brandColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'brand_color_invalid');
/** The platform's colour (tokens.css `--primary`): the accent of emails when neither the owner nor the account chose one. */
export const DEFAULT_EMAIL_ACCENT = '#0d3b35';
/**
 * How the emails look (canvas 2026-11-04): `objects` = each email with its own picture (a key-card for a sign-in
 * link, a luggage tag for a ticket, a newspaper for the digest…), `classic` = the plain card.
 */
export const MAIL_STYLES = ['objects', 'classic'] as const;
export type MailStyle = (typeof MAIL_STYLES)[number];
/** The look of every email when neither the owner nor the account chose one. */
export const DEFAULT_MAIL_STYLE: MailStyle = 'objects';
/** Test emails an admin may send to themself per hour (Emails & SMS → send a test), unless the owner sets another. */
export const DEFAULT_TEST_EMAILS_PER_HOUR = 10;
export const testEmailsPerHourSchema = z.number().int().min(1).max(1000);
/** Invitation emails per inviter per hour (S-12): 0 = no limit. */
export const inviteEmailsPerHourSchema = z.number().int().min(0).max(10_000);
/**
 * Emails automations may send per account per day (audit 2026-10-10 #1, owner console): a branded relay otherwise.
 * 0 = automations send no email.
 */
export const DEFAULT_AUTOMATION_EMAILS_PER_DAY = 500;
export const automationEmailsPerDaySchema = z.number().int().min(0).max(100_000);

/** A public https address of an image (a logo). */
export const logoUrlSchema = z.url({ protocol: /^https?$/ }).max(500);

/** The phone app's built-in colour (tokens.css `--primary`) when neither the account nor the owner chose one. */
export const DEFAULT_PWA_THEME = '#0d3b35';

/** `platform_settings.settings.pwa` (owner console, the planning notes "PWA"): defaults and the emergency switches. */
export const platformPwaSettingsSchema = z.object({
  /** The app's name where an account has none (the sign-in page; empty = the product name). */
  app_name: z.string().trim().min(1).max(30).optional(),
  /** Default colour of every account that chose none (empty = DEFAULT_PWA_THEME). */
  theme_color: brandColorSchema.optional(),
  /** Push for the whole platform (off = emergency stop). */
  push_enabled: z.boolean().default(true),
  /** The service worker (off = kill switch: every installed copy removes itself on its next check). */
  sw_enabled: z.boolean().default(true),
});
export type PlatformPwaSettings = z.infer<typeof platformPwaSettingsSchema>;

export const updatePlatformPwaSchema = z.object({
  app_name: z.string().trim().min(1).max(30).nullable().optional(),
  theme_color: brandColorSchema.nullable().optional(),
  push_enabled: z.boolean().optional(),
  sw_enabled: z.boolean().optional(),
});

/** A line under the sign-in form's title (white-label tagline), per UI language. */
export const loginSubtitleSchema = z.string().trim().min(1).max(160);

/** `platform_settings.settings.login_subtitle`: the sign-in screen's tagline per language; empty = none shown. */
export const platformLoginSubtitleSchema = z.object({
  he: loginSubtitleSchema.optional(),
  en: loginSubtitleSchema.optional(),
});

/** The operator's details on the legal pages: `{{company_name}}` … placeholders; empty = a visible marker. */
const legalTextSchema = z.string().trim().min(1).max(200);
export const platformLegalSchema = z.object({
  company_name: legalTextSchema.optional(),
  company_legal_name: legalTextSchema.optional(),
  company_id: z.string().trim().min(1).max(40).optional(),
  company_address: z.string().trim().min(1).max(300).optional(),
  contact_email: z.email().optional(),
  privacy_email: z.email().optional(),
  /** The data protection officer (GDPR art. 37; Israel Privacy Law amendment 13) — optional until one is named. */
  dpo_name: legalTextSchema.optional(),
  dpo_email: z.email().optional(),
  /** The published sub-processors (`/legal/sub-processors`); empty = the page is not offered. */
  sub_processors: z.array(subProcessorSchema).max(50).default([]),
  /**
   * The privacy notice at sign-up (privacy — Israel Privacy Law §11, GDPR art. 13): why the details
   * are asked, whether they are required, who receives them, the right of access — per language; empty = none.
   */
  collection_notice: z
    .object({ he: z.string().trim().max(1000).optional(), en: z.string().trim().max(1000).optional() })
    .default({}),
  /** The accessibility coordinator on the accessibility statement. */
  accessibility_coordinator: legalTextSchema.optional(),
  accessibility_phone: z.string().trim().min(1).max(40).optional(),
  accessibility_email: z.email().optional(),
  /** Whose laws govern the terms ("the State of Israel", "England and Wales") — `{{governing_law}}`. */
  governing_law: legalTextSchema.optional(),
  /** Where the competent courts sit ("Tel Aviv-Jaffa", "London") — `{{courts_location}}`. */
  courts_location: legalTextSchema.optional(),
  /**
   * How joining asks for consent: off (default) = "by joining you agree to …" next to the button (recorded on join);
   * on = an explicit checkbox that must be ticked first.
   */
  consent_checkbox: z.boolean().optional(),
  /**
   * The marketing opt-in at sign-up (Israel Communications Law §30A): the label of a separate box
   * never ticked by default; both empty = not offered.
   */
  marketing_opt_in: z
    .object({ he: z.string().trim().max(300).optional(), en: z.string().trim().max(300).optional() })
    .default({}),
});
export type PlatformLegal = z.infer<typeof platformLegalSchema>;
export const LEGAL_COMPANY_FIELDS = [
  'company_name',
  'company_legal_name',
  'company_id',
  'company_address',
  'contact_email',
  'privacy_email',
  'dpo_name',
  'dpo_email',
  'accessibility_coordinator',
  'accessibility_phone',
  'accessibility_email',
  'governing_law',
  'courts_location',
] as const satisfies readonly (keyof PlatformLegal)[];

/**
 * How long the platform keeps its logs (privacy; owner console → Platform settings → Retention), in
 * days; null = kept until deleted by hand. `audit`: the security audit log — 24 months by default, the period the
 * Israeli data-security regulations ask for; `activity`: boards' change history (undo and the activity panel reach
 * only this far back); `notifications`: the bell's rows. A daily job (`maintenance.retention`) applies it.
 */
const retentionDays = z.number().int().min(30).max(3650).nullable();
export const platformRetentionSchema = z.object({
  audit_days: retentionDays.default(730),
  activity_days: retentionDays.default(null),
  notifications_days: retentionDays.default(null),
});
export type PlatformRetention = z.infer<typeof platformRetentionSchema>;
export const RETENTION_DAYS_RANGE = { min: 30, max: 3650 } as const;

/**
 * `platform_settings.settings.security` (owner console → Platform settings → Security, S-77). `console_two_factor`:
 * the owner console (every /platform route, the support console, errors hub) opens only for the platform owner and
 * support staff who have two-factor sign-in on. Off by default (recommended); it cannot be turned on by someone who
 * has no 2FA themselves.
 */
export const platformSecuritySettingsSchema = z.object({
  console_two_factor: z.boolean().default(false),
});
export type PlatformSecuritySettings = z.infer<typeof platformSecuritySettingsSchema>;

/**
 * An origin that may embed an extension's panel page: a browser extension
 * (`chrome-extension://<32 letters a–p>`, Chrome and Edge) or an https site.
 */
export const embeddingOriginSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(120)
  .regex(/^(chrome-extension:\/\/[a-p]{32}|https:\/\/[a-z0-9.-]+(:\d{1,5})?)$/, 'embedding origin');

export const platformSettingsSchema = z
  .object({
    /** The product's name in emails, the authenticator app and the MCP server (empty = i18n `app.name`). */
    product_name: z.string().trim().min(1).max(60).optional(),
    /**
     * Where this installation's source code is (AGPL section 13): shown on the sign-in screen and in "About". Empty =
     * `DEFAULT_SOURCE_URL`, the project's own repository. An operator who changed the code and hosts it for others
     * points this at their version.
     */
    source_url: z
      .url({ protocol: /^https?$/ })
      .max(300)
      .optional(),
    /** The sign-in screen's tagline under its title, per language (empty = no line). */
    login_subtitle: platformLoginSubtitleSchema.default({}),
    email: z
      .object({
        /** Sender name of emails that belong to no account (empty = the product name). */
        sender_name: senderNameSchema.optional(),
        /** Reply-To of those emails (empty = none). */
        reply_to: z.email().optional(),
        /** Accent colour of every email whose account did not choose one (empty = DEFAULT_EMAIL_ACCENT). */
        accent_color: brandColorSchema.optional(),
        /** The look of every email whose account did not choose one (empty = DEFAULT_MAIL_STYLE). */
        style: z.enum(MAIL_STYLES).optional(),
        /** Test emails an admin may send per hour (empty = DEFAULT_TEST_EMAILS_PER_HOUR). */
        test_emails_per_hour: testEmailsPerHourSchema.optional(),
        /** Invitation emails one person may send per hour (S-12; empty = INVITE_EMAILS_PER_HOUR). */
        invite_emails_per_hour: inviteEmailsPerHourSchema.optional(),
        /** Emails automations may send per account per day (empty = DEFAULT_AUTOMATION_EMAILS_PER_DAY). */
        automation_emails_per_day: automationEmailsPerDaySchema.optional(),
        /**
         * Incoming email: the domain whose mail the provider hands to the platform (its MX record
         * points at the provider), e.g. `in.example.com`; item and board addresses live under it. Empty = off.
         */
        inbound_domain: mailDomainSchema.optional(),
        /** the limits of one incoming message (INBOUND_LIMIT_FIELDS; empty = INBOUND_LIMITS). */
        inbound_max_text_chars: inboundLimitSchema('inbound_max_text_chars').optional(),
        inbound_max_body_images: inboundLimitSchema('inbound_max_body_images').optional(),
        inbound_max_remote_images: inboundLimitSchema('inbound_max_remote_images').optional(),
        inbound_max_remote_image_mb: inboundLimitSchema('inbound_max_remote_image_mb').optional(),
      })
      .default({}),
    sms: z
      .object({
        /** The default SMS sender id of every account that did not choose its own (empty = TEXTME_SENDER_ID). */
        sender_id: smsSenderIdSchema.optional(),
      })
      .default({}),
    api_limits: platformApiLimitsSchema.default(() => platformApiLimitsSchema.parse({})),
    /** White-label of the public API reference (/api/docs). Empty = API_DOCS_LOGO_URL / API_DOCS_BRAND_COLOR. */
    api_docs: z
      .object({
        /** Logo shown on top of the reference (also the page icon). */
        logo_url: logoUrlSchema.optional(),
        /** Colour of the navigation and the brand ink (#rrggbb). */
        brand_color: brandColorSchema.optional(),
      })
      .default({}),
    /** Remote support access: durations, the entry email, view logging, the emergency wait, IP. */
    support: platformSupportSettingsSchema.default(() => platformSupportSettingsSchema.parse({})),
    /** External automation platforms: which ones accounts may connect (all by default). */
    flows: z
      .object({
        platforms: z
          .array(z.enum(FLOW_PLATFORMS))
          .max(FLOW_PLATFORMS.length)
          .default([...FLOW_PLATFORMS]),
      })
      .default(() => ({ platforms: [...FLOW_PLATFORMS] })),
    /**
     * AI providers: whether accounts may point an OpenAI-compatible AI connection at a private / local
     * address (a self-hosted Ollama, LM Studio). Off by default — the SSRF guard refuses private addresses.
     */
    ai: z
      .object({
        /** Any private / local address (a development or single-tenant install). */
        allow_local_endpoints: z.boolean().default(false),
        /**
         * Or only these origins (`http://192.168.1.20:11434`, `https://ollama.internal`): the owner names the private
         * AI servers accounts may use, without opening the whole network (audit 2026-10-10 #19).
         */
        local_endpoint_origins: z.array(localAiOriginSchema).max(50).default([]),
      })
      .default(() => ({ allow_local_endpoints: false, local_endpoint_origins: [] })),
    /**
     * Custom senders (S-46): an account's own email sender name / Reply-To / SMS sender id waits for the owner's
     * approval (on by default). Off = an admin's value applies at once.
     */
    senders: z.object({ require_approval: z.boolean().default(true) }).default(() => ({ require_approval: true })),
    /**
     * Map origins accounts may add (audit 2026-10-10 #8): an account's map style / extra origins join the page's
     * CSP — shared by every account — only when the owner listed them here.
     */
    maps: z
      .object({ approved_origins: z.array(mapOriginSchema).max(50).default([]) })
      .default(() => ({ approved_origins: [] })),
    /**
     * Allowed embedding origins: the sites that may frame an extension's panel page
     * (`/a/<account>/x/<installation>/panel`), e.g. a browser extension's side panel. Nothing else of the app is ever
     * framed. Empty = no one.
     */
    embedding: z
      .object({ allowed_origins: z.array(embeddingOriginSchema).max(20).default([]) })
      .default(() => ({ allowed_origins: [] })),
    /** The phone app (PWA): default name / colour, push and service-worker emergency switches. */
    pwa: platformPwaSettingsSchema.default(() => platformPwaSettingsSchema.parse({})),
    /** Passwords: the default minimum length of every account that did not choose its own. */
    password: z
      .object({ min_length: passwordMinLengthSchema.default(DEFAULT_PASSWORD_MIN_LENGTH) })
      .default(() => ({ min_length: DEFAULT_PASSWORD_MIN_LENGTH })),
    /** The platform's public address (M11): the origin of every absolute link; empty = WEB_ORIGIN. */
    public_address: platformPublicAddressSchema.default(() => platformPublicAddressSchema.parse({})),
    /** The operator's details shown on the legal pages. */
    legal: platformLegalSchema.default(() => platformLegalSchema.parse({})),
    retention: platformRetentionSchema.default(() => platformRetentionSchema.parse({})),
    /** The owner console's own security (S-77): optional, off by default, recommended. */
    security: platformSecuritySettingsSchema.default(() => platformSecuritySettingsSchema.parse({})),
    /** The n8n package and the Make app's invitation link; empty = the defaults. */
    integrations: platformIntegrationsSchema.default({}),
    /**
     * Account deletion: the grace period before the data goes, how long an export lasts, and whether
     * console-deleted accounts are purged too (off by default).
     */
    account_deletion: accountDeletionSettingsSchema.default(() => accountDeletionSettingsSchema.parse({})),
    /** Calendar & holidays: the defaults every account follows until it chooses its own. */
    calendar: platformCalendarSchema.default(() => platformCalendarSchema.parse({})),
  })
  .loose();
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;

export const defaultPlatformSettings = (): PlatformSettings => platformSettingsSchema.parse({});

/** PATCH /platform/settings: only what is sent changes; `null` clears an optional field back to the default. */
export const updatePlatformSettingsSchema = z.object({
  product_name: z.string().trim().min(1).max(60).nullable().optional(),
  source_url: z
    .url({ protocol: /^https?$/ })
    .max(300)
    .nullable()
    .optional(),
  login_subtitle: z
    .object({ he: loginSubtitleSchema.nullable().optional(), en: loginSubtitleSchema.nullable().optional() })
    .optional(),
  email: z
    .object({
      sender_name: senderNameSchema.nullable().optional(),
      reply_to: z.email().nullable().optional(),
      accent_color: brandColorSchema.nullable().optional(),
      style: z.enum(MAIL_STYLES).nullable().optional(),
      test_emails_per_hour: testEmailsPerHourSchema.nullable().optional(),
      invite_emails_per_hour: inviteEmailsPerHourSchema.nullable().optional(),
      automation_emails_per_day: automationEmailsPerDaySchema.nullable().optional(),
      inbound_domain: mailDomainSchema.nullable().optional(),
      inbound_max_text_chars: inboundLimitSchema('inbound_max_text_chars').nullable().optional(),
      inbound_max_body_images: inboundLimitSchema('inbound_max_body_images').nullable().optional(),
      inbound_max_remote_images: inboundLimitSchema('inbound_max_remote_images').nullable().optional(),
      inbound_max_remote_image_mb: inboundLimitSchema('inbound_max_remote_image_mb').nullable().optional(),
    })
    .optional(),
  sms: z.object({ sender_id: smsSenderIdSchema.nullable().optional() }).optional(),
  api_limits: z
    .object({
      token_per_minute: perMinuteLimitSchema.optional(),
      service_token_per_minute: perMinuteLimitSchema.optional(),
      personal_daily: dailyQuotaSchema.optional(),
      service_daily: dailyQuotaSchema.optional(),
    })
    .optional(),
  api_docs: z
    .object({
      logo_url: logoUrlSchema.nullable().optional(),
      brand_color: brandColorSchema.nullable().optional(),
    })
    .optional(),
  support: updatePlatformSupportSettingsSchema.optional(),
  flows: z.object({ platforms: z.array(z.enum(FLOW_PLATFORMS)).max(FLOW_PLATFORMS.length).optional() }).optional(),
  ai: z
    .object({
      allow_local_endpoints: z.boolean().optional(),
      local_endpoint_origins: z.array(localAiOriginSchema).max(50).optional(),
    })
    .optional(),
  senders: z.object({ require_approval: z.boolean().optional() }).optional(),
  maps: z.object({ approved_origins: z.array(mapOriginSchema).max(50).optional() }).optional(),
  embedding: z.object({ allowed_origins: z.array(embeddingOriginSchema).max(20).optional() }).optional(),
  pwa: updatePlatformPwaSchema.optional(),
  password: z.object({ min_length: passwordMinLengthSchema.optional() }).optional(),
  public_address: updatePlatformPublicAddressSchema.optional(),
  legal: z
    .object({
      company_name: legalTextSchema.nullable().optional(),
      company_legal_name: legalTextSchema.nullable().optional(),
      company_id: z.string().trim().min(1).max(40).nullable().optional(),
      company_address: z.string().trim().min(1).max(300).nullable().optional(),
      contact_email: z.email().nullable().optional(),
      privacy_email: z.email().nullable().optional(),
      dpo_name: legalTextSchema.nullable().optional(),
      dpo_email: z.email().nullable().optional(),
      /** The whole list (replace). */
      sub_processors: z.array(subProcessorSchema).max(50).optional(),
      collection_notice: z
        .object({ he: z.string().trim().max(1000).optional(), en: z.string().trim().max(1000).optional() })
        .optional(),
      accessibility_coordinator: legalTextSchema.nullable().optional(),
      accessibility_phone: z.string().trim().min(1).max(40).nullable().optional(),
      accessibility_email: z.email().nullable().optional(),
      governing_law: legalTextSchema.nullable().optional(),
      courts_location: legalTextSchema.nullable().optional(),
      consent_checkbox: z.boolean().nullable().optional(),
      marketing_opt_in: z
        .object({ he: z.string().trim().max(300).optional(), en: z.string().trim().max(300).optional() })
        .optional(),
    })
    .optional(),
  retention: platformRetentionSchema.partial().optional(),
  security: z.object({ console_two_factor: z.boolean().optional() }).optional(),
  integrations: updatePlatformIntegrationsSchema.optional(),
  account_deletion: z
    .object({
      grace_days: accountDeletionSettingsSchema.shape.grace_days.unwrap().optional(),
      export_days: accountDeletionSettingsSchema.shape.export_days.unwrap().optional(),
      purge_console_deleted: z.boolean().optional(),
    })
    .optional(),
  /** Calendar & holidays: each field replaces the stored one (`holidays` = the whole map). */
  calendar: z
    .object({
      holiday_set: platformCalendarSchema.shape.holiday_set.unwrap().optional(),
      hebrew_dates: platformCalendarSchema.shape.hebrew_dates.unwrap().optional(),
      duration: platformCalendarSchema.shape.duration.unwrap().optional(),
      half_day: platformCalendarSchema.shape.half_day.unwrap().optional(),
      picker_marks: platformCalendarSchema.shape.picker_marks.unwrap().optional(),
      holidays: platformCalendarSchema.shape.holidays.unwrap().optional(),
    })
    .optional(),
});
export type UpdatePlatformSettings = z.infer<typeof updatePlatformSettingsSchema>;

/** Drops `null` (= "back to the default") and `undefined` from a patch section merged over the current one. */
export const mergeNullable = <T extends Record<string, unknown>>(
  current: T,
  patch: Record<string, unknown> | undefined,
): T => {
  if (!patch) return current;
  const next: Record<string, unknown> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  return next as T;
};

/**
 * The account's own API budgets (Administration → API): each one unset = the platform's. Personal and service
 * tokens are kept apart, like the platform defaults.
 */
export const accountApiLimitsSchema = z.object({
  token_per_minute: perMinuteLimitSchema.optional(),
  service_token_per_minute: perMinuteLimitSchema.optional(),
  personal_daily: dailyQuotaSchema.optional(),
  service_daily: dailyQuotaSchema.optional(),
});
export type AccountApiLimits = z.infer<typeof accountApiLimitsSchema>;

/** The budgets a token runs with: its own override, else the account's, else the platform's. */
export const effectiveTokenLimits = (p: {
  service: boolean;
  token: { rate_limit_per_minute: number | null; daily_quota: number | null };
  account: AccountApiLimits | undefined;
  platform: PlatformApiLimits;
}) => {
  const a = p.account ?? {};
  const perMinute = p.service
    ? (a.service_token_per_minute ?? p.platform.service_token_per_minute)
    : (a.token_per_minute ?? p.platform.token_per_minute);
  const daily = p.service
    ? (a.service_daily ?? p.platform.service_daily)
    : (a.personal_daily ?? p.platform.personal_daily);
  return {
    per_minute: p.token.rate_limit_per_minute ?? perMinute,
    daily: p.token.daily_quota ?? daily,
    /** What the token would run with without its own override (the account's / platform's). */
    inherited: { per_minute: perMinute, daily },
  };
};
export type TokenLimits = ReturnType<typeof effectiveTokenLimits>;

/** GET / PATCH /platform/settings: what is saved, and what each empty field falls back to (placeholders). */
export const platformSettingsResponseSchema = z
  .object({
    settings: platformSettingsSchema,
    fallbacks: z.object({
      product_name: z.string(),
      /** The sending address (EMAIL_FROM / RESEND_FROM); null = not configured. */
      email_address: z.string().nullable(),
      sms_sender_id: z.string().nullable(),
      /** The API reference's logo / colour from the environment (API_DOCS_LOGO_URL / API_DOCS_BRAND_COLOR). */
      api_docs_logo_url: z.string().nullable(),
      api_docs_brand_color: z.string().nullable(),
      /** The built-in email accent (the platform's colour) and test-email budget. */
      email_accent_color: z.string(),
      test_emails_per_hour: z.number().int(),
      /** The invitation-email budget from the environment (INVITE_EMAILS_PER_HOUR). */
      invite_emails_per_hour: z.number().int().optional(),
      /** Automation emails per account per day when the owner set none (DEFAULT_AUTOMATION_EMAILS_PER_DAY). */
      automation_emails_per_day: z.number().int().optional(),
      /** The n8n package when the owner set none (DEFAULT_N8N_PACKAGE). */
      n8n_package: z.string().optional(),
    }),
    /**
     * A mail transport is configured (SMTP / Resend). False = email is off: the console says how to turn it on;
     * password sign-in works, invitations give a link to copy, the sign-in screen offers no email link.
     */
    email_enabled: z.boolean().optional(),
    /**
     * The public address in effect (M11) and where each part came from — the setting or the environment — plus
     * the environment's own values (shown as placeholders) and the sign-in base fixed when the server started.
     */
    public_address: z
      .object({
        web: z.string(),
        web_source: z.enum(['setting', 'env']),
        api: z.string(),
        api_source: z.enum(['setting', 'env', 'web']),
        accepted: z.array(z.string()),
        env_web_origin: z.string().nullable(),
        /** Better Auth's base (BETTER_AUTH_URL, else WEB_ORIGIN) — Google sign-in returns there; needs a restart. */
        auth_base_url: z.string(),
      })
      .optional(),
  })
  .meta({ id: 'PlatformSettings' });
export type PlatformSettingsResponse = z.infer<typeof platformSettingsResponseSchema>;

/**
 * GET /auth/config (public — the sign-in screen, before anyone signs in): the sign-in methods on offer and the
 * platform's branding, resolved per UI language (the owner's product name, else i18n `app.name`; the tagline, null
 * = none).
 */
/** The project's public repository: the source link every unmodified installation shows (`source_url` overrides it). */
export const DEFAULT_SOURCE_URL = 'https://github.com/binesamit/open-crm';
/** The licence the running code is under, as shown in "About" (SPDX id). */
export const SOURCE_LICENSE = 'AGPL-3.0-only';

export const authConfigSchema = z.object({
  google: z.boolean(),
  /** "Continue with Microsoft": switched on in the owner console and has credentials. */
  microsoft: z.boolean(),
  magic_link: z.boolean(),
  /** The platform's default minimum password length (an account may ask for a longer one). */
  password_min_length: z.number().int(),
  branding: z.object({
    product_name: z.object({ he: z.string(), en: z.string() }),
    login_subtitle: z.object({ he: z.string().nullable(), en: z.string().nullable() }),
  }),
  /** The source of the running code (AGPL section 13): the owner's link or the project's, the version, the commit. */
  source: z.object({ url: z.string(), version: z.string(), commit: z.string().nullable() }),
  /** Turnstile on the sign-in screens (owner console → Platform settings → Turnstile). */
  captcha: authCaptchaSchema,
});
export type AuthConfig = z.infer<typeof authConfigSchema>;
