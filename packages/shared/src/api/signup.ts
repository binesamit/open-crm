// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { templateSetSchema } from '../account/settings';
import { legalAcceptanceSchema, legalDocSummarySchema } from './legal';
import { onboardingSettingsSchema } from './onboarding';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_FLOOR } from './password';
import { publicPlanSchema } from './plans';

/**
 * Self sign-up (D32, the approved SIGNUP plan): a person opens a new account of their own — name, email, organisation,
 * a password or Google / Microsoft, the plan, consent, Turnstile — verifies the email and lands in it on a trial.
 * Everything is a platform setting (`platform_settings` row `signup`, owner console → Plans → Self sign-up) and the
 * switch is OFF by default: with it off nothing of this answers and every existing door works exactly as before.
 * Sign-up goes through the existing doors (account + first-admin invitation + accepting it), so the password policy,
 * the edition limits, the plans and legal consent apply as they do to anyone else.
 */

/** `open`: anyone gets a new account of their own. `domain_join`: join an existing account by email domain (later). */
export const SIGNUP_MODES = ['open', 'domain_join'] as const;
export type SignupMode = (typeof SIGNUP_MODES)[number];

/** How a person may sign up (the owner turns each on). A magic link signs in only — it never opens an account. */
export const SIGNUP_METHODS = ['password', 'google', 'microsoft'] as const;
export type SignupMethod = (typeof SIGNUP_METHODS)[number];
export const SIGNUP_PROVIDER_METHODS = ['google', 'microsoft'] as const;
export type SignupProviderMethod = (typeof SIGNUP_PROVIDER_METHODS)[number];

/**
 * A request's life: `pending_email` (the link was sent) / `pending_provider` (Google / Microsoft started) →
 * `pending_approval` (manual approval on) → `approved` (being created) → `provisioned`; or `rejected`, `expired`.
 * `existing_user`: the address already had an account — the email said so, nothing was created.
 */
export const SIGNUP_REQUEST_STATUSES = [
  'pending_email',
  'pending_provider',
  'pending_approval',
  'approved',
  'provisioned',
  'rejected',
  'expired',
  'existing_user',
] as const;
export type SignupRequestStatus = (typeof SIGNUP_REQUEST_STATUSES)[number];

/** What an ended self sign-up trial becomes (the account's own rule; billing settings decide what follows). */
export const SIGNUP_TRIAL_END_STATUSES = ['active', 'past_due', 'read_only'] as const;

/**
 * The trial emails of a self sign-up account (D32 decision 6, ה5), in order: `welcome` (at once), two reminders
 * before the end (`reminder_first` 3 days, `reminder_last` 1 day), `ended` (read-only) and `before_suspend` (some
 * days before read-only becomes suspended). Each has its own switch and days; to the account's admins only.
 */
export const TRIAL_EMAIL_KINDS = ['welcome', 'reminder_first', 'reminder_last', 'ended', 'before_suspend'] as const;
export type TrialEmailKind = (typeof TRIAL_EMAIL_KINDS)[number];

/** An email's own text in one language (empty = the built-in text). `{days}`, `{org}`, `{product}` are filled in. */
const trialEmailTextSchema = z.object({
  subject: z.string().trim().max(200).nullable().default(null),
  body: z.string().trim().max(4_000).nullable().default(null),
});
const trialEmailSchema = (days: number | null) =>
  z.object({
    enabled: z.boolean().default(true),
    /** Days before the moment (end of trial / suspension); null for the emails that go at the moment itself. */
    days: days === null ? z.null().default(null) : z.number().int().min(1).max(60).default(days),
    he: trialEmailTextSchema.default({ subject: null, body: null }),
    en: trialEmailTextSchema.default({ subject: null, body: null }),
  });
export const trialEmailsSchema = z.object({
  welcome: trialEmailSchema(null).default(() => trialEmailSchema(null).parse({})),
  reminder_first: trialEmailSchema(3).default(() => trialEmailSchema(3).parse({})),
  reminder_last: trialEmailSchema(1).default(() => trialEmailSchema(1).parse({})),
  ended: trialEmailSchema(null).default(() => trialEmailSchema(null).parse({})),
  before_suspend: trialEmailSchema(7).default(() => trialEmailSchema(7).parse({})),
});
export type TrialEmails = z.infer<typeof trialEmailsSchema>;
const trialEmailPatch = z
  .object({
    enabled: z.boolean(),
    days: z.number().int().min(1).max(60),
    he: z
      .object({ subject: z.string().trim().max(200).nullable(), body: z.string().trim().max(4_000).nullable() })
      .partial(),
    en: z
      .object({ subject: z.string().trim().max(200).nullable(), body: z.string().trim().max(4_000).nullable() })
      .partial(),
  })
  .partial();

const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(?=.{1,253}$)([a-z0-9-]{1,63}\.)+[a-z]{2,63}$/, 'domain_invalid');
const domainList = z.array(domainSchema).max(500);

/** The stored settings (platform_settings row `signup`); a missing row = these defaults (switched off). */
export const signupSettingsSchema = z
  .object({
    /** The switch. Off by default; turning it on needs everything in `missing` to be done. */
    enabled: z.boolean().default(false),
    mode: z.enum(SIGNUP_MODES).default('open'),
    methods: z
      .array(z.enum(SIGNUP_METHODS))
      .max(3)
      .default([...SIGNUP_METHODS]),
    /** Trial days for a plan version with none of its own (a version's own `trial_days` wins). 0 = no trial. */
    trial_days: z.number().int().min(0).max(365).default(14),
    /** What the trial becomes when it ends (then `read_only_days` of the billing settings → suspended). */
    trial_end_status: z.enum(SIGNUP_TRIAL_END_STATUSES).default('read_only'),
    /** The plan a new account starts on (pre-selected when the person chooses). Must be a public plan. */
    default_plan_id: z.string().max(26).nullable().default(null),
    /** The person picks among the public plans; off = everyone starts on the default plan. */
    choose_plan: z.boolean().default(true),
    /** The starter kit of new accounts (`empty` or a kit key of the catalog). */
    starter_kit: templateSetSchema.default('empty'),
    /** Every verified request waits for the platform owner's approval (an emergency brake; off by default). */
    approval: z.boolean().default(false),
    /** Turnstile is mandatory: sign-up cannot be turned on without the platform's keys, and every start is checked. */
    require_captcha: z.boolean().default(true),
    block_disposable: z.boolean().default(true),
    /** Refuse free mailboxes (gmail …). */
    require_work_email: z.boolean().default(false),
    /** Throw-away inbox domains on top of the built-in list. */
    disposable_domains: domainList.default([]),
    /** When not empty: only these domains (and their subdomains) may sign up. */
    domain_allow: domainList.default([]),
    /** Never these domains. */
    domain_block: domainList.default([]),
    /** Requests per client address per hour. */
    rate_ip_hour: z.number().int().min(1).max(10_000).default(5),
    /** Requests per email address per day. */
    rate_email_day: z.number().int().min(1).max(1_000).default(3),
    /** Requests of the whole platform per day ("try tomorrow" past it). */
    daily_cap: z.number().int().min(1).max(1_000_000).default(50),
    /** How long the email link works, in hours. */
    link_hours: z.number().int().min(1).max(168).default(24),
    /** "Send again" waits this many seconds after the last email. */
    resend_seconds: z.number().int().min(10).max(3_600).default(60),
    /** The platform owner gets an email about every new account / request waiting for approval. */
    notify_owner: z.boolean().default(true),
    /** "How to start?" after sign-up: the start screen, its AI and quick picks. */
    onboarding: onboardingSettingsSchema.default(() => onboardingSettingsSchema.parse({})),
    /** The trial emails to the new account's admins (ה5): each one's switch, days and own text. */
    emails: trialEmailsSchema.default(() => trialEmailsSchema.parse({})),
  })
  .meta({ id: 'SignupSettings' });
export type SignupSettings = z.infer<typeof signupSettingsSchema>;

/** PATCH /platform/signup-settings: only what is sent changes. */
export const updateSignupSettingsSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(SIGNUP_MODES),
    methods: z.array(z.enum(SIGNUP_METHODS)).max(3),
    trial_days: z.number().int().min(0).max(365),
    trial_end_status: z.enum(SIGNUP_TRIAL_END_STATUSES),
    default_plan_id: z.string().max(26).nullable(),
    choose_plan: z.boolean(),
    starter_kit: templateSetSchema,
    approval: z.boolean(),
    require_captcha: z.boolean(),
    block_disposable: z.boolean(),
    require_work_email: z.boolean(),
    disposable_domains: domainList,
    domain_allow: domainList,
    domain_block: domainList,
    rate_ip_hour: z.number().int().min(1).max(10_000),
    rate_email_day: z.number().int().min(1).max(1_000),
    daily_cap: z.number().int().min(1).max(1_000_000),
    link_hours: z.number().int().min(1).max(168),
    resend_seconds: z.number().int().min(10).max(3_600),
    notify_owner: z.boolean(),
    emails: z
      .object(
        Object.fromEntries(TRIAL_EMAIL_KINDS.map((k) => [k, trialEmailPatch])) as Record<
          TrialEmailKind,
          typeof trialEmailPatch
        >,
      )
      .partial(),
    /** "How to start?": the fields sent, over what it has. */
    onboarding: onboardingSettingsSchema.partial(),
  })
  .partial()
  .meta({ id: 'UpdateSignupSettings' });
export type UpdateSignupSettings = z.infer<typeof updateSignupSettingsSchema>;

/**
 * What still stands between the switch and sign-up working (the console's "what is missing" list; 422
 * `signup_not_ready` details.missing):
 * - `email`: no outbound email (SMTP / Resend) — the verification link cannot be sent;
 * - `captcha`: Turnstile is mandatory and the platform has no keys;
 * - `default_plan`: no default plan, or it is not public / has no version;
 * - `methods`: no sign-up method is on;
 * - `legal`: no published document asks for consent (terms, privacy);
 * - `mode`: the mode is not available yet (`domain_join` comes in a later stage).
 */
export const SIGNUP_MISSING = ['email', 'captcha', 'default_plan', 'methods', 'legal', 'mode'] as const;
export type SignupMissing = (typeof SIGNUP_MISSING)[number];

/** GET / PATCH /platform/signup-settings. */
export const signupSettingsResponseSchema = z
  .object({
    settings: signupSettingsSchema,
    /** Everything needed is there (sign-up works when `enabled` too). */
    ready: z.boolean(),
    missing: z.array(z.enum(SIGNUP_MISSING)),
    /** The switch is on and ready: the public screens answer. */
    open: z.boolean(),
  })
  .meta({ id: 'SignupSettingsResponse' });
export type SignupSettingsResponse = z.infer<typeof signupSettingsResponseSchema>;

/** GET /public/signup/config: what the sign-up screen shows (always answers; `open: false` = closed). */
export const signupConfigSchema = z
  .object({
    open: z.boolean(),
    methods: z.array(z.enum(SIGNUP_METHODS)),
    choose_plan: z.boolean(),
    default_plan_id: z.string().nullable(),
    plans: z.array(publicPlanSchema),
    /** Trial days of a plan without its own. */
    trial_days: z.number().int(),
    /** The documents joining agrees to (their current versions — sent back in `accept_legal`). */
    legal: z.array(legalDocSummarySchema),
    /** Turnstile's site key when the check is on; null = none. */
    captcha_site_key: z.string().nullable(),
    password_min_length: z.number().int(),
    /** How long the email link works (hours) and how long "send again" waits (seconds) — the "check email" screen. */
    link_hours: z.number().int(),
    resend_seconds: z.number().int(),
    /** New accounts start with a starter kit's sample boards (the form's line, the "preparing" step). */
    sample_boards: z.boolean(),
    /**
     * `open`: a new account of one's own (an address at a joinable domain joins that account instead);
     * `domain_join`: only joining one's organisation's account by the address's domain (no organisation, no plan).
     */
    mode: z.enum(SIGNUP_MODES),
  })
  .meta({ id: 'SignupConfig' });
export type SignupConfig = z.infer<typeof signupConfigSchema>;

const nameSchema = z.string().trim().min(1).max(120);
const common = {
  name: nameSchema,
  /** Needed for a new account; empty when the address joins its organisation's account (domain join, ה7). */
  org_name: z.string().trim().max(120).default(''),
  /** A public plan (ignored when the person may not choose). */
  plan_id: z.string().max(26).optional(),
  /** The current version of every document that asks for consent. */
  accept_legal: z.array(legalAcceptanceSchema).max(20).default([]),
  /** The marketing box (separate, never ticked by default); shown when the owner offers it. */
  marketing_opt_in: z.boolean().optional(),
  captcha_token: z.string().max(4096).optional(),
  locale: z.enum(['he', 'en']).optional(),
  timezone: z.string().max(64).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
  /** Honeypot: a person never fills it. */
  website: z.string().max(500).optional(),
};

/** POST /public/signup/start (email + password). */
export const signupStartSchema = z
  .object({
    ...common,
    email: z.email().max(254),
    password: z.string().min(PASSWORD_MIN_FLOOR).max(PASSWORD_MAX_LENGTH),
  })
  .meta({ id: 'SignupStart' });
export type SignupStart = z.input<typeof signupStartSchema>;

/**
 * POST /public/signup/intent (before Google / Microsoft): what the form already holds, kept for half an hour behind
 * a cookie. The person's name comes from the provider; the organisation and the consent may come here or on the
 * "two more details" screen after the provider (POST complete).
 */
export const signupIntentSchema = z
  .object({
    ...common,
    name: z.string().trim().max(120).default(''),
    org_name: z.string().trim().max(120).default(''),
    method: z.enum(SIGNUP_PROVIDER_METHODS),
  })
  .meta({ id: 'SignupIntent' });
export type SignupIntent = z.input<typeof signupIntentSchema>;

/** What a Google / Microsoft sign-up may still lack when it comes back (422 `signup_details_required`). */
export const SIGNUP_DETAILS = ['org_name', 'legal'] as const;
export type SignupDetail = (typeof SIGNUP_DETAILS)[number];

/** POST /public/signup/complete: the details the intent did not hold (all optional; the intent's stand). */
export const signupCompleteSchema = z
  .object({
    org_name: nameSchema.optional(),
    plan_id: z.string().max(26).optional(),
    accept_legal: z.array(legalAcceptanceSchema).max(20).optional(),
    marketing_opt_in: z.boolean().optional(),
  })
  .meta({ id: 'SignupComplete' });
export type SignupComplete = z.infer<typeof signupCompleteSchema>;

/** POST /public/signup/resend. */
export const signupResendSchema = z.object({ email: z.email().max(254) }).meta({ id: 'SignupResend' });

/** POST /public/signup/verify: the token from the email link. */
export const signupVerifySchema = z.object({ token: z.string().min(16).max(200) }).meta({ id: 'SignupVerify' });

/** The same answer to every start / resend / intent, whoever the address belongs to (enumeration-safe). */
export const signupAcceptedSchema = z.object({ ok: z.literal(true) }).meta({ id: 'SignupAccepted' });

/** POST /public/signup/verify and /complete: the account is ready (session cookie set), or waits for approval. */
export const signupResultSchema = z
  .object({
    status: z.enum(['provisioned', 'pending_approval']),
    account: z.object({ id: z.string(), slug: z.string(), name: z.string() }).nullable(),
    /** The person joined their organisation's existing account (domain join) rather than opening a new one. */
    joined: z.boolean().optional(),
    /** What the request asked for (the "being reviewed" screen): the organisation, the plan, its trial days. */
    request: z
      .object({ org_name: z.string(), plan_name: z.string().nullable(), trial_days: z.number().int() })
      .optional(),
  })
  .meta({ id: 'SignupResult' });
export type SignupResult = z.infer<typeof signupResultSchema>;

/** One request in the owner's queue (never the password or the token). */
export const signupRequestSchema = z
  .object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    org_name: z.string(),
    method: z.enum(SIGNUP_METHODS),
    status: z.enum(SIGNUP_REQUEST_STATUSES),
    plan_version_id: z.string().nullable(),
    locale: z.string().nullable(),
    ip: z.string().nullable(),
    user_agent: z.string().nullable(),
    account_id: z.string().nullable(),
    user_id: z.string().nullable(),
    reason: z.string().nullable(),
    decided_by: z.string().nullable(),
    decided_at: z.string().nullable(),
    verified_at: z.string().nullable(),
    expires_at: z.string().nullable(),
    created_at: z.string(),
  })
  .meta({ id: 'SignupRequest' });
export type SignupRequest = z.infer<typeof signupRequestSchema>;

export const signupRequestListQuerySchema = z.object({
  status: z.enum(SIGNUP_REQUEST_STATUSES).optional(),
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** The `next` of the previous page (its last request's id; newest first). */
  before: z.string().min(1).max(40).optional(),
});
export const signupRequestListSchema = z
  .object({ data: z.array(signupRequestSchema), next: z.string().nullable() })
  .meta({ id: 'SignupRequestList' });

/** POST /platform/signup-requests/{id}/reject. */
export const rejectSignupSchema = z
  .object({
    /** Sent to the person in the rejection email. */
    reason: z.string().trim().max(1000).optional(),
    /** Also add the address's domain to the block list. */
    block_domain: z.boolean().optional(),
  })
  .meta({ id: 'RejectSignup' });
export type RejectSignup = z.infer<typeof rejectSignupSchema>;

// ------------------------------------------------------------------------------------------------ domain join (ה7)

/**
 * Domain join (D32 decision 11, plan ה7): the account's domains (admin → security, `settings.domains`) with
 * "auto join" on (`security.auto_join`, role `auto_join_role`) let people with an address at a domain join the account
 * by themselves through sign-up — once the domain is verified: the admin's own verified address is at it, or its DNS
 * holds a TXT record. A verified domain belongs to one account only; free mailboxes never qualify. The verification
 * state is kept in the account settings (`domain_join.verifications`).
 */
export const DOMAIN_VERIFY_PREFIX = 'bines-domain-verification';

export const domainVerificationSchema = z.object({
  domain: domainSchema,
  /** How it was verified (null = not yet): the admin's own address at it, or the DNS record. */
  method: z.enum(['email', 'dns']).nullable().default(null),
  /** The record's token: the TXT value is `<prefix>=<token>`. */
  token: z.string().min(16).max(64),
  verified_at: z.string().max(40).nullable().default(null),
  verified_by: z.string().max(26).nullable().default(null),
});
export type DomainVerification = z.infer<typeof domainVerificationSchema>;

/** `account_settings.settings.domain_join`. */
export const domainJoinStateSchema = z.object({
  verifications: z.array(domainVerificationSchema).max(100).default([]),
});
export type DomainJoinState = z.infer<typeof domainJoinStateSchema>;

/** GET /security/domain-join (account admins): each account domain's verification, and whether joining works. */
export const domainJoinResponseSchema = z
  .object({
    /** "Auto join" (admin → security) and its role, as saved there. */
    enabled: z.boolean(),
    role: z.enum(['member', 'viewer']),
    domains: z.array(
      z.object({
        domain: z.string(),
        verified: z.boolean(),
        method: z.enum(['email', 'dns']).nullable(),
        verified_at: z.string().nullable(),
        /** A free / throw-away mailbox domain: never joinable. */
        free_mail: z.boolean(),
        /** The DNS record that verifies it. */
        record: z.object({ type: z.literal('TXT'), name: z.string(), value: z.string() }),
      }),
    ),
    /**
     * Whether people can actually join now: the platform's sign-up is on and ready (its owner decides), so the sign-up
     * page answers. Off = the settings are kept, nobody joins yet; the screen says why.
     */
    available: z.boolean(),
    /** The page to share: people sign up there with their work address. */
    join_url: z.string(),
  })
  .meta({ id: 'DomainJoin' });
export type DomainJoinResponse = z.infer<typeof domainJoinResponseSchema>;
