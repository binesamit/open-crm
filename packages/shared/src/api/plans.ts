// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { legalAcceptanceSchema, legalDocSummarySchema } from './legal';

/**
 * Subscription plans (stages 1–3): the platform owner defines plans in the owner console; each plan
 * has immutable versions (prices, limits, features, trial) — a new price is a new version, so accounts already on an
 * older version keep it (grandfathering). An account has at most one current subscription (a plan version + a
 * status); an account with none is "legacy" = unlimited. The core only knows plans, entitlements and the status;
 * charging is a billing provider's job (`BillingProvider`, apps/api/src/modules/billing/provider.ts) — none yet.
 * Nothing here names a plan, a price or a limit: all of it is the owner's data.
 */

/**
 * The limits the core can enforce (each has an enforcement point in the API). Values are the owner's data; a limit a
 * version does not set (or sets to null) is unlimited, so adding a kind here never changes existing plans.
 * - stock (`seats`, `boards`, `items`, `storage_gb`): what the account has now;
 * - monthly consumption (`automation_runs`, `ai_usd`): this calendar month (UTC), reset on the 1st (billing
 *   setting `usage_period: 'calendar'` — see `PLAN_USAGE_PERIODS`);
 * - daily (`api_calls_per_day`): requests of all the account's API tokens today (UTC).
 * Seats: active non-guest members (and pending non-guest invitations). Guests and service identities (API /
 * service tokens' users, agents, extensions) never take a seat.
 */
export const PLAN_LIMIT_KINDS = [
  'seats',
  'boards',
  'items',
  'storage_gb',
  'automation_runs',
  'ai_usd',
  'api_calls_per_day',
] as const;
export type PlanLimitKind = (typeof PLAN_LIMIT_KINDS)[number];

export const PLAN_LIMIT_PERIOD: Record<PlanLimitKind, 'stock' | 'month' | 'day'> = {
  seats: 'stock',
  boards: 'stock',
  items: 'stock',
  storage_gb: 'stock',
  automation_runs: 'month',
  ai_usd: 'month',
  api_calls_per_day: 'day',
};

const count = z.number().int().min(0).max(1_000_000_000).nullable().optional();
const amount = z.number().min(0).max(1_000_000).nullable().optional();

/** A version's limits: absent / null = unlimited. */
export const planLimitsSchema = z
  .object({
    seats: count,
    boards: count,
    items: count,
    storage_gb: amount,
    automation_runs: count,
    ai_usd: amount,
    api_calls_per_day: count,
  })
  .meta({ id: 'PlanLimits' });
export type PlanLimits = z.infer<typeof planLimitsSchema>;

/**
 * The owner's per-account override (e.g. "5 more seats as a gift"): a number replaces the plan's limit, null = no
 * limit for that kind, absent = the plan's.
 */
export const planOverridesSchema = planLimitsSchema.meta({ id: 'PlanOverrides' });
export type PlanOverrides = z.infer<typeof planOverridesSchema>;

// ------------------------------------------------------------------------------------------------ add-ons held

/** Add-on quantities by add-on id (checkout, the owner's subscription editor; 0 = none). */
export const addonQuantitiesSchema = z.record(z.string().max(26), z.number().int().min(0).max(1000));
export type AddonQuantities = z.infer<typeof addonQuantitiesSchema>;

/**
 * What a subscription holds of each add-on — a snapshot at purchase / assignment, so a later edit of
 * the add-on changes nothing already sold: the quantity, and what it adds to which limit.
 */
export const subscriptionAddonSchema = z.object({
  qty: z.number().int().min(1),
  limit_kind: z.enum(PLAN_LIMIT_KINDS),
  amount: z.number(),
  name: z.string(),
});
export const subscriptionAddonsSchema = z
  .record(z.string(), subscriptionAddonSchema)
  .meta({ id: 'SubscriptionAddons' });
export type SubscriptionAddons = z.infer<typeof subscriptionAddonsSchema>;

/** What the add-ons add, per limit kind. */
export const addonExtras = (addons: SubscriptionAddons): Partial<Record<PlanLimitKind, number>> => {
  const out: Partial<Record<PlanLimitKind, number>> = {};
  for (const a of Object.values(addons)) out[a.limit_kind] = (out[a.limit_kind] ?? 0) + a.amount;
  return out;
};

/** A feature key (the owner's catalogue in billing settings names them; a version lists the ones it includes). */
export const featureKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'feature_key_invalid');

/**
 * The features the core gates (plans): the only place the code names them. Each has an enforcement
 * point in the API (402 `plan_feature_unavailable` {feature, upgrade: true}); labels live in i18n
 * (`plan.feature.<key>`), and the owner's catalogue (billing settings) may name them too, or add its own keys
 * (shown on "My plan", enforced nowhere). Remote support access is deliberately not a feature: it always works.
 * - `ai`: the assistant, agents, AI columns, AI images (the tool and the `generate_image` automation action);
 * - `automations_advanced`: the automation actions in `PLAN_FEATURE_ACTIONS` (outgoing webhook, email, SMS,
 *   integrations, agents);
 * - `api`: API tokens (making and using them), the MCP server, approving OAuth apps;
 * - `extensions`: installing extensions (and approving their updates); installed ones keep working;
 * - `flows`: external automation platforms (n8n, Make…);
 * - `dashboards`, `docs`: creating and editing them (existing ones stay readable);
 * - `forms`: public forms (new form views, editing, and taking submissions);
 * - `guests`: inviting guests (guests already in stay).
 */
export const PLAN_FEATURE_KEYS = [
  'ai',
  'automations_advanced',
  'api',
  'extensions',
  'flows',
  'dashboards',
  'docs',
  'forms',
  'guests',
] as const;
export type PlanFeatureKey = (typeof PLAN_FEATURE_KEYS)[number];
export const isPlanFeatureKey = (k: string): k is PlanFeatureKey =>
  (PLAN_FEATURE_KEYS as readonly string[]).includes(k);

/** Automation action types that need a feature (keyed by action type; the rest need none). */
export const PLAN_FEATURE_ACTIONS: Readonly<Record<string, PlanFeatureKey>> = {
  webhook: 'automations_advanced',
  send_email: 'automations_advanced',
  send_sms: 'automations_advanced',
  send_document: 'automations_advanced',
  send_to_integrations: 'automations_advanced',
  run_agent: 'automations_advanced',
  // AI images: a model call, like every AI feature.
  generate_image: 'ai',
};

/**
 * Does a plan's feature list include `key`? `null` (legacy — no subscription) and an EMPTY list (a version that
 * names no features) both mean everything, so plans made before the gates existed lose nothing; only a version that
 * lists features is restricted to them. The one rule the API, `/me/accounts` (`plan_features`) and the app share.
 */
export const planIncludesFeature = (features: readonly string[] | null | undefined, key: string) =>
  !features || features.length === 0 || features.includes(key);

/** `plan_feature_unavailable` error details (402): the feature the plan lacks. */
export type PlanFeatureDetails = { feature: PlanFeatureKey; upgrade: true };

/**
 * What the monthly counters (`automation_runs`, `ai_usd`) count over. `calendar` (the only one today): the calendar
 * month in UTC, reset on the 1st — for every account, whatever its billing day. A future `subscription_period`
 * (from the subscription's `period_start`) is planned and will be added here when it is built; it is not accepted
 * yet, so the setting can never claim something the counters do not do.
 */
export const PLAN_USAGE_PERIODS = ['calendar'] as const;
export type PlanUsagePeriod = (typeof PLAN_USAGE_PERIODS)[number];

export const PLAN_VISIBILITY = ['public', 'hidden'] as const;
export const PLAN_PRICING = ['flat', 'per_seat'] as const;
/**
 * `closed` (plan-lock): the owner closed the account — nothing of it answers (403 `account_closed`)
 * except the current user, the account's plan, the offered plans and support (contact us); background jobs do not
 * run; nothing is deleted. Only the owner sets it (and lifts it); no schedule ever reaches it.
 */
export const SUBSCRIPTION_STATUSES = ['trial', 'active', 'past_due', 'read_only', 'suspended', 'closed'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** Statuses that stop every write (`closed` stops everything). */
export const WRITE_BLOCKING_STATUSES: readonly SubscriptionStatus[] = ['read_only', 'suspended', 'closed'];
/**
 * Statuses in which the AI (assistant, agents, AI columns, images) does not work at all — not even reads: the app
 * does not open it, the server refuses it (plan-lock, product decision).
 */
export const AI_BLOCKING_STATUSES: readonly SubscriptionStatus[] = WRITE_BLOCKING_STATUSES;
export const statusBlocksAi = (status: SubscriptionStatus | null | undefined) =>
  !!status && AI_BLOCKING_STATUSES.includes(status);
export const BILLING_INTERVALS = ['month', 'year'] as const;
export type BillingInterval = (typeof BILLING_INTERVALS)[number];

const price = z.number().min(0).max(10_000_000);

/** What the owner writes for a version (create / edit while unused). */
export const planVersionInputSchema = z
  .object({
    price_monthly: price.default(0),
    price_yearly: price.default(0),
    /** ISO 4217. */
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .default('ILS'),
    /** Prices include VAT (else VAT is added on top). */
    vat_included: z.boolean().default(true),
    pricing: z.enum(PLAN_PRICING).default('flat'),
    limits: planLimitsSchema.default({}),
    features: z.array(featureKeySchema).max(100).default([]),
    trial_days: z.number().int().min(0).max(365).default(0),
  })
  .meta({ id: 'PlanVersionInput' });
export type PlanVersionInput = z.input<typeof planVersionInputSchema>;

export const planVersionSchema = z
  .object({
    id: z.string(),
    plan_id: z.string(),
    version: z.number().int(),
    price_monthly: z.number(),
    price_yearly: z.number(),
    currency: z.string(),
    vat_included: z.boolean(),
    pricing: z.enum(PLAN_PRICING),
    limits: planLimitsSchema,
    features: z.array(z.string()),
    trial_days: z.number().int(),
    /** Accounts on it now. */
    subscribers: z.number().int(),
    /** Ever used by a subscription — then it never changes (a new price = a new version). */
    locked: z.boolean(),
    created_at: z.string(),
  })
  .meta({ id: 'PlanVersion' });
export type PlanVersion = z.infer<typeof planVersionSchema>;

export const subscriptionPlanSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    visibility: z.enum(PLAN_VISIBILITY),
    sort: z.number().int(),
    archived: z.boolean(),
    /** The pricing page's selling points, in the owner's order. */
    highlights: z.array(z.string()),
    /** Marked "recommended" on the pricing page. */
    recommended: z.boolean(),
    /** Per-seat plans charge at least this many seats (null = no minimum). */
    min_seats: z.number().int().nullable(),
    /** The version new subscriptions get (the newest). */
    current_version_id: z.string().nullable(),
    versions: z.array(planVersionSchema),
    created_at: z.string(),
  })
  .meta({ id: 'SubscriptionPlan' });
export type SubscriptionPlan = z.infer<typeof subscriptionPlanSchema>;

const planName = z.string().trim().min(1).max(80);
const planDescription = z.string().trim().max(2000);
const planHighlights = z.array(z.string().trim().min(1).max(120)).max(12);
const planMinSeats = z.number().int().min(1).max(100_000).nullable();

export const createPlanSchema = z.object({
  name: planName,
  description: planDescription.optional(),
  visibility: z.enum(PLAN_VISIBILITY).default('public'),
  sort: z.number().int().min(0).max(10_000).default(0),
  highlights: planHighlights.default([]),
  recommended: z.boolean().default(false),
  min_seats: planMinSeats.default(null),
  version: planVersionInputSchema.default(() => planVersionInputSchema.parse({})),
});
export const updatePlanSchema = z.object({
  name: planName.optional(),
  description: planDescription.nullable().optional(),
  visibility: z.enum(PLAN_VISIBILITY).optional(),
  sort: z.number().int().min(0).max(10_000).optional(),
  archived: z.boolean().optional(),
  highlights: planHighlights.optional(),
  recommended: z.boolean().optional(),
  min_seats: planMinSeats.optional(),
});

/** One subscription row: the current one, or a past one (`ended_at`) in the history. */
export const subscriptionSchema = z
  .object({
    id: z.string(),
    account_id: z.string(),
    plan_id: z.string(),
    plan_name: z.string(),
    plan_version_id: z.string(),
    version: z.number().int(),
    /** As stored (what the owner or a provider set). */
    status: z.enum(SUBSCRIPTION_STATUSES),
    /** What holds now (a grace period over, a trial ended, a cancellation at period end — billing settings). */
    effective_status: z.enum(SUBSCRIPTION_STATUSES),
    status_since: z.string(),
    interval: z.enum(BILLING_INTERVALS),
    /** Seats bought (per-seat pricing); null = the plan's seat limit. */
    seats: z.number().int().nullable(),
    period_start: z.string(),
    period_end: z.string().nullable(),
    trial_ends_at: z.string().nullable(),
    cancel_at_period_end: z.boolean(),
    overrides: planOverridesSchema,
    /** The add-ons it holds, each adding to one limit. */
    addons: subscriptionAddonsSchema,
    note: z.string().nullable(),
    /** What the account's members read about the status (the closed screen); null = the platform's text. */
    status_message: z.string().nullable(),
    /** A billing provider's reference (none built yet). */
    provider: z.string().nullable(),
    external_id: z.string().nullable(),
    created_at: z.string(),
    ended_at: z.string().nullable(),
    /**
     * The account's own cancellation: the case, the refund (major units of the plan's currency), when
     * and whether it can still be undone (no refund was made and the period has not ended). Null = not cancelled by it.
     */
    cancellation: z
      .object({
        case: z.enum(['cooling_off', 'period_end', 'yearly_refund', 'yearly_no_refund']),
        refund: z.number(),
        currency: z.string(),
        at: z.string(),
        resumable: z.boolean(),
      })
      .nullable(),
  })
  .meta({ id: 'Subscription' });
export type Subscription = z.infer<typeof subscriptionSchema>;

/** PUT /platform/accounts/:id/subscription — assign or change (a new version = a new history row). */
export const assignSubscriptionSchema = z.object({
  plan_version_id: z.string().max(26),
  /** Omitted: `trial` when the version has trial days, else `active`. */
  status: z.enum(SUBSCRIPTION_STATUSES).optional(),
  interval: z.enum(BILLING_INTERVALS).default('month'),
  seats: z.number().int().min(1).max(1_000_000).nullable().optional(),
  cancel_at_period_end: z.boolean().optional(),
  overrides: planOverridesSchema.optional(),
  /** Add-on quantities by add-on id (replaces what the subscription holds; 0 = remove). */
  addons: addonQuantitiesSchema.optional(),
  note: z.string().trim().max(1000).nullable().optional(),
  /** Shown to the account's members while the status blocks them (why it is closed); null = the platform's text. */
  status_message: z.string().trim().max(1000).nullable().optional(),
  /** Start a new period now (renewal); a version change always starts one. */
  renew: z.boolean().optional(),
});
export type AssignSubscription = z.input<typeof assignSubscriptionSchema>;

/** A contact target: a web page or an email address (`mailto:`). */
const contactUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^(https?:\/\/|mailto:)\S+$/i.test(v), 'invalid_contact_url');

/** Owner console → Plans → settings (platform_settings row `billing`). Every number is a setting. */
export const billingSettingsSchema = z
  .object({
    /** Admins are notified once a period when a limit passes this share. */
    warn_pct: z.number().int().min(1).max(99).default(80),
    /** past_due → read_only after this many days (null = never by itself). */
    past_due_grace_days: z.number().int().min(0).max(365).nullable().default(7),
    /** read_only (after a grace period) → suspended after this many more days (null = never by itself). */
    read_only_days: z.number().int().min(0).max(365).nullable().default(30),
    /** What an ended trial becomes until the owner (or a provider) changes it. */
    trial_end_status: z.enum(['active', 'past_due', 'read_only']).default('past_due'),
    /** What a subscription cancelled at period end becomes after that end. */
    canceled_status: z.enum(['read_only', 'suspended']).default('read_only'),
    /** Shown on "My plan" and on the upgrade button until self-service checkout exists (contact details etc.). */
    upgrade_text: z.string().trim().max(2000).optional(),
    /** An optional link next to it (a contact form, WhatsApp, a booking page). */
    upgrade_url: z
      .url({ protocol: /^https?$/ })
      .max(500)
      .optional(),
    /**
     * The closed-account screen (plan-lock): the text under the account's name (empty = the app's own text, he / en).
     * The account's own message (the subscription's `status_message`) comes first when the owner wrote one.
     */
    closed_text: z.string().trim().max(2000).optional(),
    /**
     * Where "contact us" goes on the closed screen (a web page or `mailto:`); empty = a support ticket from the
     * screen itself (when the helpdesk is on), else the upgrade link.
     */
    contact_url: contactUrl.optional(),
    /** The feature catalogue versions pick from. */
    features: z
      .array(z.object({ key: featureKeySchema, label: z.string().trim().min(1).max(80) }))
      .max(100)
      .default([]),
    /** What the monthly counters count over (`PLAN_USAGE_PERIODS`; only `calendar` — the UTC month — today). */
    usage_period: z.enum(PLAN_USAGE_PERIODS).default('calendar'),
    /**
     * Cancelling. Within this many days of buying, the purchase is cancelled with a refund less the
     * fee below (0 = no such window).
     */
    cooling_off_days: z.number().int().min(0).max(60).default(14),
    /** The cancellation fee inside that window: this share of the price… */
    cancel_fee_pct: z.number().min(0).max(100).default(5),
    /** …or this amount (major units, the plan's currency), whichever is lower; null = no cap. */
    cancel_fee_cap: z.number().min(0).max(100_000).nullable().default(100),
    /**
     * A yearly plan cancelled later: `monthly_rate` = refund what was paid less the months used at the plan's monthly
     * price (a started month counts); `pro_rata` = the unused months' share of the yearly price; `none` = no refund,
     * it just does not renew. A monthly plan is never refunded after the window — it ends with the paid month.
     */
    yearly_refund: z.enum(['monthly_rate', 'pro_rata', 'none']).default('monthly_rate'),
    /** The admins of a yearly plan are emailed this many days before it renews (null = no reminder). */
    renewal_reminder_days: z.number().int().min(1).max(120).nullable().default(30),
    /**
     * The advance notice (days) before a change to a plan's price, features or usage limits (API
     * storage …) — and a material change to the terms — takes effect. The legal documents say it as
     * `{{change_notice_days}}`.
     */
    change_notice_days: z.number().int().min(1).max(365).default(30),
  })
  .meta({ id: 'BillingSettings' });
export type BillingSettings = z.infer<typeof billingSettingsSchema>;
export const updateBillingSettingsSchema = z.object({
  warn_pct: z.number().int().min(1).max(99).optional(),
  past_due_grace_days: z.number().int().min(0).max(365).nullable().optional(),
  read_only_days: z.number().int().min(0).max(365).nullable().optional(),
  trial_end_status: z.enum(['active', 'past_due', 'read_only']).optional(),
  canceled_status: z.enum(['read_only', 'suspended']).optional(),
  upgrade_text: z.string().trim().max(2000).nullable().optional(),
  upgrade_url: z
    .url({ protocol: /^https?$/ })
    .max(500)
    .nullable()
    .optional(),
  closed_text: z.string().trim().max(2000).nullable().optional(),
  contact_url: contactUrl.nullable().optional(),
  features: z
    .array(z.object({ key: featureKeySchema, label: z.string().trim().min(1).max(80) }))
    .max(100)
    .optional(),
  usage_period: z.enum(PLAN_USAGE_PERIODS).optional(),
  cooling_off_days: z.number().int().min(0).max(60).optional(),
  cancel_fee_pct: z.number().min(0).max(100).optional(),
  cancel_fee_cap: z.number().min(0).max(100_000).nullable().optional(),
  yearly_refund: z.enum(['monthly_rate', 'pro_rata', 'none']).optional(),
  renewal_reminder_days: z.number().int().min(1).max(120).nullable().optional(),
  change_notice_days: z.number().int().min(1).max(365).optional(),
});

/** One offered plan as anyone signed in sees it (`GET /plans/public`): the current version's price and features. */
export const publicPlanSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    price_monthly: z.number(),
    price_yearly: z.number(),
    currency: z.string(),
    vat_included: z.boolean(),
    pricing: z.enum(PLAN_PRICING),
    trial_days: z.number().int(),
    /** The included features with the owner's labels (null label = the app's own, `plan.feature.<key>`). */
    features: z.array(z.object({ key: z.string(), label: z.string().nullable() })),
    highlights: z.array(z.string()),
    recommended: z.boolean(),
    min_seats: z.number().int().nullable(),
    limits: planLimitsSchema,
  })
  .meta({ id: 'PublicPlan' });
export type PublicPlan = z.infer<typeof publicPlanSchema>;

/**
 * `GET /plans/public`: the offered plans (visibility `public`, not archived, in the owner's order) and where to turn
 * — what the closed-account screen and a future sign-up show. Every text and link is the owner's (billing settings).
 */
export const planOfferSchema = z
  .object({
    data: z.array(publicPlanSchema),
    upgrade: z.object({ text: z.string().nullable(), url: z.string().nullable() }),
    closed_text: z.string().nullable(),
    contact_url: z.string().nullable(),
  })
  .meta({ id: 'PlanOffer' });
export type PlanOffer = z.infer<typeof planOfferSchema>;
export type UpdateBillingSettings = z.infer<typeof updateBillingSettingsSchema>;

/** One limit as an account sees it: used / limit (null = unlimited), share used (0–100+). */
export const planUsageSchema = z
  .object({
    kind: z.enum(PLAN_LIMIT_KINDS),
    used: z.number(),
    limit: z.number().nullable(),
    pct: z.number().nullable(),
    period: z.enum(['stock', 'month', 'day']),
  })
  .meta({ id: 'PlanUsage' });
export type PlanUsage = z.infer<typeof planUsageSchema>;

export const entitlementsSchema = z
  .object({
    /** No subscription: a legacy / unlimited account. */
    unlimited: z.boolean(),
    status: z.enum(SUBSCRIPTION_STATUSES).nullable(),
    limits: planLimitsSchema,
    /** The version's feature list as stored (empty = every feature). */
    features: z.array(z.string()),
    /** Every feature is included (legacy, or a version that lists none — `planIncludesFeature`). */
    all_features: z.boolean(),
  })
  .meta({ id: 'Entitlements' });

/** One feature on "My plan": included or not (the gated keys, the owner's catalogue and the version's list). */
export const planFeatureAccessSchema = z
  .object({
    key: z.string(),
    /** The owner's catalogue label; null = the app's own label (`plan.feature.<key>`). */
    label: z.string().nullable(),
    included: z.boolean(),
    /** The core enforces it (`PLAN_FEATURE_KEYS`); else it is the owner's own, shown only. */
    gated: z.boolean(),
  })
  .meta({ id: 'PlanFeatureAccess' });
export type PlanFeatureAccess = z.infer<typeof planFeatureAccessSchema>;
export type EntitlementsDto = z.infer<typeof entitlementsSchema>;

/** GET /plan (account admins) and the owner console's account view. */
export const accountPlanSchema = z
  .object({
    subscription: subscriptionSchema.nullable(),
    entitlements: entitlementsSchema,
    usage: z.array(planUsageSchema),
    history: z.array(subscriptionSchema),
    /** The owner's upgrade / contact text and link (billing settings). */
    upgrade: z.object({ text: z.string().nullable(), url: z.string().nullable() }),
    /** The feature catalogue (labels for `entitlements.features`). */
    features: z.array(z.object({ key: z.string(), label: z.string() })),
    /** Every feature with whether the plan includes it (gated keys first, then the owner's own). */
    feature_access: z.array(planFeatureAccessSchema),
  })
  .meta({ id: 'AccountPlan' });
export type AccountPlan = z.infer<typeof accountPlanSchema>;

/**
 * POST /plan/upgrade-request (account admins, also while read-only / suspended; self sign-up ה5): "I want to
 * upgrade" — opens a ticket at the platform's support desk when it is on, and emails the platform owners.
 */
export const upgradeRequestSchema = z
  .object({
    /** The public plan asked for (GET /plans/public); none = "talk to me". */
    plan_id: z.string().max(26).nullable().optional(),
    note: z.string().trim().max(1_000).optional(),
  })
  .meta({ id: 'UpgradeRequest' });
export type UpgradeRequest = z.infer<typeof upgradeRequestSchema>;
export const upgradeRequestResultSchema = z
  .object({ ok: z.literal(true), ticket_id: z.string().nullable() })
  .meta({ id: 'UpgradeRequestResult' });

/** `plan_limit_reached` error details (402): what ran out. */
export type PlanLimitDetails = { kind: PlanLimitKind; limit: number; used: number; upgrade: true };

const DAY = 86_400_000;
const addDays = (iso: Date, days: number) => new Date(iso.getTime() + days * DAY);

type SubscriptionClock = {
  status: SubscriptionStatus;
  statusSince: Date;
  trialEndsAt: Date | null;
  periodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  /**
   * The subscription's own trial-end rule (self sign-up, D32), else null / absent = the billing settings'
   * `trial_end_status`. A trial that ends in read-only by its own rule is suspended after `read_only_days`.
   */
  trialEndStatus?: string | null;
};
type TrialEndStatus = BillingSettings['trial_end_status'];
const TRIAL_END_STATUSES: readonly string[] = ['active', 'past_due', 'read_only'];
const ownTrialEnd = (s: SubscriptionClock): TrialEndStatus | null =>
  s.trialEndStatus && TRIAL_END_STATUSES.includes(s.trialEndStatus) ? (s.trialEndStatus as TrialEndStatus) : null;
type StatusSettings = Pick<
  BillingSettings,
  'past_due_grace_days' | 'read_only_days' | 'trial_end_status' | 'canceled_status'
>;

/**
 * The status that holds now, since when, and when the account becomes (or became) read-only by the schedule
 * (pure; the billing settings decide every step): a trial past its end → `trial_end_status`; a cancellation past
 * the period end → `canceled_status`; `past_due` longer than the grace → `read_only`; that `read_only` longer than
 * `read_only_days` → `suspended`. A `read_only` / `suspended` the owner set by hand stays as it is.
 * `read_only_at` is null when no read-only is scheduled (or the account went straight to suspended).
 */
export const subscriptionStateAt = (
  s: SubscriptionClock,
  settings: StatusSettings,
  now: Date,
): { status: SubscriptionStatus; since: Date; read_only_at: Date | null } => {
  let status = s.status;
  let since = s.statusSince;
  const own = ownTrialEnd(s);
  const trialEnd = own ?? settings.trial_end_status;
  // Closed (plan-lock) is the owner's alone: no schedule moves it, and it never "becomes read-only".
  if (status === 'closed') return { status, since, read_only_at: null };
  if (s.cancelAtPeriodEnd && s.periodEnd && now >= s.periodEnd && status !== 'suspended') {
    const st = settings.canceled_status;
    return { status: st, since: s.periodEnd, read_only_at: st === 'read_only' ? s.periodEnd : null };
  }
  if (status === 'trial' && s.trialEndsAt && now >= s.trialEndsAt) {
    status = trialEnd;
    since = s.trialEndsAt;
    // Its own rule (self sign-up): read-only at once, suspended `read_only_days` later; closed only by hand.
    if (own === 'read_only' && settings.read_only_days !== null) {
      const suspendAt = addDays(since, settings.read_only_days);
      if (now >= suspendAt) return { status: 'suspended', since: suspendAt, read_only_at: since };
    }
  }
  if (status === 'past_due' && settings.past_due_grace_days !== null) {
    const graceEnd = addDays(since, settings.past_due_grace_days);
    if (now < graceEnd) return { status: 'past_due', since, read_only_at: graceEnd };
    if (settings.read_only_days !== null) {
      const suspendAt = addDays(graceEnd, settings.read_only_days);
      if (now >= suspendAt) return { status: 'suspended', since: suspendAt, read_only_at: graceEnd };
    }
    return { status: 'read_only', since: graceEnd, read_only_at: graceEnd };
  }
  // Still ahead: a trial ending in read-only (directly or after the grace), a cancellation ending in read-only.
  let readOnlyAt: Date | null = status === 'read_only' ? since : null;
  if (!readOnlyAt && status === 'trial' && s.trialEndsAt) {
    if (trialEnd === 'read_only') readOnlyAt = s.trialEndsAt;
    else if (trialEnd === 'past_due' && settings.past_due_grace_days !== null)
      readOnlyAt = addDays(s.trialEndsAt, settings.past_due_grace_days);
  }
  if (status !== 'suspended' && s.cancelAtPeriodEnd && s.periodEnd && settings.canceled_status === 'read_only')
    if (!readOnlyAt || s.periodEnd < readOnlyAt) readOnlyAt = s.periodEnd;
  return { status, since, read_only_at: status === 'suspended' ? null : readOnlyAt };
};

/** The status that holds now — see `subscriptionStateAt`. */
export const effectiveSubscriptionStatus = (
  s: SubscriptionClock,
  settings: StatusSettings,
  now: Date,
): SubscriptionStatus => subscriptionStateAt(s, settings, now).status;

/**
 * The limits that hold: the version's, plus what the subscription's add-ons add (an unlimited limit stays
 * unlimited), the seats bought (per seat) as a seat cap, the owner's override on top.
 */
export const mergeLimits = (
  version: PlanLimits,
  seats: number | null,
  overrides: PlanOverrides,
  extras: Partial<Record<PlanLimitKind, number>> = {},
): PlanLimits => {
  const out: Record<string, number | null> = {};
  for (const k of PLAN_LIMIT_KINDS) {
    const base = version[k] ?? null;
    out[k] = base === null ? null : base + (extras[k] ?? 0);
  }
  if (seats !== null) out.seats = out.seats === null ? seats : Math.min(out.seats!, seats);
  for (const k of PLAN_LIMIT_KINDS) if (overrides[k] !== undefined) out[k] = overrides[k] ?? null;
  return out as PlanLimits;
};

// ------------------------------------------------------------------------------------------------ paid upgrade (ה9)

/**
 * Paid upgrade of an account's plan through Stripe (self sign-up ה9, decision ⭐ "the same Stripe connection"): the
 * same Stripe account and keys as the license purchase (owner console → Licensing → Payments), a second kind of
 * product — the platform's public plans, each with a Stripe price per interval. Off by default; the manual "request
 * upgrade" stays. No card at sign-up (decision 9): only when upgrading.
 */
export const PLAN_PAYMENT_INTERVALS = ['month', 'year'] as const;
export type PlanPaymentInterval = (typeof PLAN_PAYMENT_INTERVALS)[number];
const stripePriceId = z
  .string()
  .trim()
  .regex(/^price_[A-Za-z0-9]{6,120}$/, 'stripe_price_id_invalid');

/** GET /platform/plan-payments (platform owner): the secrets only as "set or not". */
export const planPaymentsSchema = z
  .object({
    enabled: z.boolean(),
    secret_key_set: z.boolean(),
    webhook_secret_set: z.boolean(),
    /** Per public plan: its Stripe price for each interval (null = not sold that way). */
    prices: z.record(z.string(), z.object({ month: z.string().nullable(), year: z.string().nullable() })),
    /** Per active add-on: its Stripe price for each interval (null = not sold online that way). */
    addon_prices: z.record(z.string(), z.object({ month: z.string().nullable(), year: z.string().nullable() })),
    /** On, both secrets set and at least one public plan priced: "Upgrade" pays online. */
    ready: z.boolean(),
    /** Paste into Stripe's dashboard (the same endpoint as the license purchase). */
    webhook_url: z.string(),
  })
  .meta({ id: 'PlanPayments' });
export type PlanPayments = z.infer<typeof planPaymentsSchema>;

/** PATCH /platform/plan-payments: only what is sent changes; the secrets are the license purchase's (shared). */
export const updatePlanPaymentsSchema = z
  .object({
    enabled: z.boolean().optional(),
    secret_key: z
      .string()
      .trim()
      .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]{8,240}$/, 'stripe_secret_key_invalid')
      .nullable()
      .optional(),
    webhook_secret: z
      .string()
      .trim()
      .regex(/^whsec_[A-Za-z0-9+/=]{8,240}$/, 'stripe_webhook_secret_invalid')
      .nullable()
      .optional(),
    prices: z
      .record(
        z.string().max(26),
        z.object({ month: stripePriceId.nullable().optional(), year: stripePriceId.nullable().optional() }),
      )
      .optional(),
    addon_prices: z
      .record(
        z.string().max(26),
        z.object({ month: stripePriceId.nullable().optional(), year: stripePriceId.nullable().optional() }),
      )
      .optional(),
  })
  .meta({ id: 'UpdatePlanPayments' });
export type UpdatePlanPayments = z.infer<typeof updatePlanPaymentsSchema>;

/** GET /plan/checkout (account admins): what "Upgrade" can buy online here; available: false = request only. */
export const planCheckoutOptionsSchema = z
  .object({
    available: z.boolean(),
    plans: z.array(
      z.object({ plan_id: z.string(), name: z.string(), intervals: z.array(z.enum(PLAN_PAYMENT_INTERVALS)) }),
    ),
    /** The add-ons that can be paid online, with the intervals they are priced for. */
    addons: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string().nullable(),
        limit_kind: z.enum(PLAN_LIMIT_KINDS),
        unit_amount: z.number(),
        price_monthly: z.number(),
        price_yearly: z.number(),
        currency: z.string(),
        vat_included: z.boolean(),
        plan_ids: z.array(z.string()),
        max_qty: z.number().int(),
        intervals: z.array(z.enum(PLAN_PAYMENT_INTERVALS)),
      }),
    ),
    /** VAT in percent (the pricing page's setting), for the totals the dialog shows. */
    vat_pct: z.number(),
    /** The published purchase documents the admin ticks before paying; empty = nothing to accept. */
    legal: z.array(legalDocSummarySchema),
  })
  .meta({ id: 'PlanCheckoutOptions' });
export type PlanCheckoutOptions = z.infer<typeof planCheckoutOptionsSchema>;

/**
 * POST /plan/checkout: the plan, the interval, and the seats for a per-seat plan (default: the seats
 * in use, at least the plan's minimum) and add-on quantities (only add-ons priced online for that interval).
 */
export const planCheckoutSchema = z
  .object({
    plan_id: z.string().max(26),
    interval: z.enum(PLAN_PAYMENT_INTERVALS),
    seats: z.number().int().min(1).max(100_000).optional(),
    addons: addonQuantitiesSchema.optional(),
    /** The current versions of the purchase documents (`GET /plan/checkout` → `legal`), ticked by the admin. */
    accepted: z.array(legalAcceptanceSchema).max(20).optional(),
  })
  .meta({ id: 'PlanCheckout' });
export type PlanCheckout = z.infer<typeof planCheckoutSchema>;

/**
 * GET /plan/cancel (account admins): what cancelling now would do — computed by the billing settings'
 * rules, shown before the admin confirms. Amounts in major units of `currency`.
 * - `cooling_off`: inside the window after buying — refund less the fee, access ends now;
 * - `period_end`: a monthly plan (or a yearly one under `none`) — no refund, it ends with the paid period;
 * - `yearly_refund`: refund of the unused part, access until the end of the last month counted;
 * - `yearly_no_refund`: the months used cost as much as the year — nothing back, it runs to the year's end.
 */
export const PLAN_CANCEL_CASES = ['cooling_off', 'period_end', 'yearly_refund', 'yearly_no_refund'] as const;
export type PlanCancelCase = (typeof PLAN_CANCEL_CASES)[number];
export const planCancelPreviewSchema = z
  .object({
    /** false: nothing to cancel (no paid subscription, already cancelled, a trial). */
    available: z.boolean(),
    reason: z.enum(['no_subscription', 'already_canceled', 'trial']).nullable(),
    case: z.enum(PLAN_CANCEL_CASES).nullable(),
    interval: z.enum(['month', 'year']).nullable(),
    currency: z.string(),
    paid: z.number(),
    monthly_price: z.number().nullable(),
    months_used: z.number().int().nullable(),
    fee: z.number(),
    refund: z.number(),
    /** When access ends if cancelled now. */
    ends_at: z.string().nullable(),
    period_end: z.string().nullable(),
    /** A payment provider refunds it at once; false = the platform's team refunds it by hand. */
    automatic_refund: z.boolean(),
    /** The subscription terms the cancellation follows (published), for the dialog's link. */
    terms: legalDocSummarySchema.nullable(),
  })
  .meta({ id: 'PlanCancelPreview' });
export type PlanCancelPreview = z.infer<typeof planCancelPreviewSchema>;

/** POST /plan/cancel: confirms what the preview showed (a different refund now → 409 cancel_changed, preview again). */
export const planCancelSchema = z
  .object({ expected_refund: z.number().min(0), reason: z.string().trim().max(1000).optional() })
  .meta({ id: 'PlanCancel' });
export type PlanCancel = z.infer<typeof planCancelSchema>;
