// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { PLAN_LIMIT_KINDS, PLAN_PRICING, planLimitsSchema } from './plans';
import { PURCHASABLE_PLANS } from './licensing';

/**
 * The pricing page and its calculator (the planning notes "PRICING"): the platform's public plans with the
 * owner's marketing fields, add-ons that raise one limit each, and the page's own settings (VAT, contact link,
 * questions, which sites may read the JSON). Nothing here names a plan, a price or an add-on: all of it is the
 * owner's data (owner console → Plans). `quotePlan` is the one calculation the page, the upgrade dialog and the
 * server share.
 */

// ------------------------------------------------------------------------------------------------ add-ons

const money = z.number().min(0).max(10_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/);

/**
 * An add-on (decision 5): a unit that raises one limit of the plan by `unit_amount` (e.g. 100 GB of storage, 5,000
 * automation runs, $10 of AI), sold per unit per month / year. `plan_ids` empty = every paid public plan.
 */
export const planAddonInputSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(500).nullable().optional(),
    limit_kind: z.enum(PLAN_LIMIT_KINDS),
    unit_amount: z.number().positive().max(1_000_000_000),
    price_monthly: money.default(0),
    price_yearly: money.default(0),
    currency: currency.default('ILS'),
    vat_included: z.boolean().default(true),
    plan_ids: z.array(z.string().max(26)).max(50).default([]),
    max_qty: z.number().int().min(1).max(1000).default(20),
    sort: z.number().int().min(0).max(10_000).default(0),
    active: z.boolean().default(true),
  })
  .meta({ id: 'PlanAddonInput' });
export type PlanAddonInput = z.input<typeof planAddonInputSchema>;
export const updatePlanAddonSchema = planAddonInputSchema.partial().meta({ id: 'UpdatePlanAddon' });

export const planAddonSchema = z
  .object({
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
    sort: z.number().int(),
    active: z.boolean(),
  })
  .meta({ id: 'PlanAddon' });
export type PlanAddon = z.infer<typeof planAddonSchema>;

// ------------------------------------------------------------------------------------------------ page settings

/** One question on the page (the owner's text). */
export const pricingFaqSchema = z.object({
  q: z.string().trim().min(1).max(200),
  a: z.string().trim().min(1).max(1000),
});

const origin = z
  .string()
  .trim()
  .max(200)
  .regex(/^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/, 'origin_invalid');

/**
 * Owner console → Plans → "Pricing page" (its own `platform_settings` row, `pricing_page`). Off by default: `/pricing` answers
 * "not available" and the JSON is empty until the owner turns it on.
 */
export const pricingPageSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** The page's title and line under it (empty = the app's own). */
    headline: z.string().trim().max(120).default(''),
    subheadline: z.string().trim().max(300).default(''),
    /** The note on "yearly" (e.g. "two months free"; empty = none). */
    yearly_note: z.string().trim().max(40).default(''),
    /** VAT in percent, for the "incl. VAT" switch (decision 3). */
    vat_pct: z.number().min(0).max(100).default(18),
    /** The switch's starting position. */
    vat_default_on: z.boolean().default(false),
    /** "Talk to us" (the custom plan, a question): a web page or mailto:. */
    contact_url: z
      .string()
      .trim()
      .max(500)
      .refine((v) => /^(https?:\/\/|mailto:)\S+$/i.test(v), 'invalid_contact_url')
      .nullable()
      .default(null),
    /** The custom plan's strip ("Enterprise"): its name and line; empty name = no strip. */
    custom_name: z.string().trim().max(80).default(''),
    custom_text: z.string().trim().max(300).default(''),
    faq: z.array(pricingFaqSchema).max(12).default([]),
    /** Sites allowed to read `GET /public/pricing` from a browser (CORS), e.g. the marketing site. */
    cors_origins: z.array(origin).max(10).default([]),
  })
  .meta({ id: 'PricingPageSettings' });
export type PricingPageSettings = z.infer<typeof pricingPageSettingsSchema>;
export const updatePricingPageSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    headline: z.string().trim().max(120).optional(),
    subheadline: z.string().trim().max(300).optional(),
    yearly_note: z.string().trim().max(40).optional(),
    vat_pct: z.number().min(0).max(100).optional(),
    vat_default_on: z.boolean().optional(),
    contact_url: z
      .string()
      .trim()
      .max(500)
      .refine((v) => /^(https?:\/\/|mailto:)\S+$/i.test(v), 'invalid_contact_url')
      .nullable()
      .optional(),
    custom_name: z.string().trim().max(80).optional(),
    custom_text: z.string().trim().max(300).optional(),
    faq: z.array(pricingFaqSchema).max(12).optional(),
    cors_origins: z.array(origin).max(10).optional(),
  })
  .meta({ id: 'UpdatePricingPageSettings' });

// ------------------------------------------------------------------------------------------------ public JSON

export const pricingPlanSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    highlights: z.array(z.string()),
    recommended: z.boolean(),
    min_seats: z.number().int().nullable(),
    price_monthly: z.number(),
    price_yearly: z.number(),
    currency: z.string(),
    vat_included: z.boolean(),
    pricing: z.enum(PLAN_PRICING),
    trial_days: z.number().int(),
    limits: planLimitsSchema,
    features: z.array(z.object({ key: z.string(), label: z.string().nullable() })),
  })
  .meta({ id: 'PricingPlan' });
export type PricingPlan = z.infer<typeof pricingPlanSchema>;

export const pricingAddonSchema = planAddonSchema.omit({ active: true, sort: true }).meta({ id: 'PricingAddon' });
export type PricingAddon = z.infer<typeof pricingAddonSchema>;

/** A self-hosted edition on sale (license server only): its tiers, each a seat count and a yearly price. */
export const pricingEditionSchema = z.object({
  plan: z.enum(PURCHASABLE_PLANS),
  currency: z.string(),
  tiers: z.array(
    z.object({
      index: z.number().int(),
      /** null = unlimited. */
      seats: z.number().int().nullable(),
      /** The yearly price shown (null = "talk to us"). */
      amount: z.number().nullable(),
    }),
  ),
});

/**
 * `GET /public/pricing` — no sign-in; CORS for the owner's listed sites. `enabled: false` = the page is off (every
 * list empty). `signup_open`: the plans' buttons start a trial at /signup; else they go to `contact_url`.
 */
export const publicPricingSchema = z
  .object({
    enabled: z.boolean(),
    headline: z.string(),
    subheadline: z.string(),
    yearly_note: z.string(),
    plans: z.array(pricingPlanSchema),
    addons: z.array(pricingAddonSchema),
    vat_pct: z.number(),
    vat_default_on: z.boolean(),
    contact_url: z.string().nullable(),
    custom: z.object({ name: z.string(), text: z.string() }).nullable(),
    faq: z.array(pricingFaqSchema),
    signup_open: z.boolean(),
    /** The feature catalogue's labels (the comparison table). */
    features: z.array(z.object({ key: z.string(), label: z.string() })),
    /** The self-hosted editions (the license server only; null elsewhere). */
    self_host: z.object({ buy_available: z.boolean(), editions: z.array(pricingEditionSchema) }).nullable(),
  })
  .meta({ id: 'PublicPricing' });
export type PublicPricing = z.infer<typeof publicPricingSchema>;

// ------------------------------------------------------------------------------------------------ the calculation

export type QuoteInterval = 'month' | 'year';
type QuotePlan = Pick<
  PricingPlan,
  'id' | 'price_monthly' | 'price_yearly' | 'vat_included' | 'pricing' | 'min_seats' | 'limits'
>;
type QuoteAddon = Pick<PricingAddon, 'id' | 'price_monthly' | 'price_yearly' | 'vat_included' | 'plan_ids' | 'max_qty'>;

export type PlanQuote = {
  /** Price per seat per month at this interval (per-seat plans), else the plan's monthly price. */
  unit_month: number;
  /** Seats charged: the people asked for, at least the plan's minimum (1 for a flat price). */
  seats_billed: number;
  /** The add-ons' share of a month. */
  addons_month: number;
  month_total: number;
  year_total: number;
  /** What paying yearly saves over paying monthly, per year (0 when monthly is chosen or it saves nothing). */
  yearly_saving: number;
  /** The plan holds this many people (its seat limit). */
  fits: boolean;
  /** A paid plan (some price above 0). */
  paid: boolean;
};

/** An add-on applies to a plan when it names none, or names this one — and only to paid plans. */
export const addonAppliesTo = (addon: Pick<QuoteAddon, 'plan_ids'>, plan: Pick<QuotePlan, 'id'>, paid: boolean) =>
  paid && (addon.plan_ids.length === 0 || addon.plan_ids.includes(plan.id));

/**
 * The price of a plan for `seats` people (pure). Prices are stored as the owner wrote them: monthly per month,
 * yearly per year (per seat when `pricing` is per_seat); `vat_included` says whether they hold VAT. The result is in
 * the plan's currency, with VAT when `withVat`, without it otherwise.
 */
export const quotePlan = (
  plan: QuotePlan,
  input: {
    seats: number;
    interval: QuoteInterval;
    withVat: boolean;
    vatPct: number;
    addons?: readonly QuoteAddon[];
    quantities?: Record<string, number>;
  },
): PlanQuote => {
  const vat = 1 + Math.max(0, input.vatPct) / 100;
  const net = (amount: number, included: boolean) => (included ? amount / vat : amount);
  const show = (amount: number) => (input.withVat ? amount * vat : amount);
  const seats = Math.max(1, Math.floor(input.seats || 1));
  const perSeat = plan.pricing === 'per_seat';
  const seatsBilled = perSeat ? Math.max(seats, plan.min_seats ?? 1) : 1;
  const paid = plan.price_monthly > 0 || plan.price_yearly > 0;
  const monthOf = (interval: QuoteInterval) => {
    const raw = interval === 'year' ? plan.price_yearly / 12 : plan.price_monthly;
    return net(raw, plan.vat_included);
  };
  const addonsOf = (interval: QuoteInterval) =>
    (input.addons ?? []).reduce((sum, a) => {
      const qty = Math.min(a.max_qty, Math.max(0, Math.floor(input.quantities?.[a.id] ?? 0)));
      if (!qty || !addonAppliesTo(a, plan, paid)) return sum;
      const raw = interval === 'year' ? a.price_yearly / 12 : a.price_monthly;
      return sum + qty * net(raw, a.vat_included);
    }, 0);
  const totalOf = (interval: QuoteInterval) => monthOf(interval) * seatsBilled + addonsOf(interval);
  const month = totalOf(input.interval);
  // A plan with no yearly price is not sold yearly: no saving to show.
  const saving = input.interval === 'year' && plan.price_yearly > 0 ? Math.max(0, (totalOf('month') - month) * 12) : 0;
  const cap = plan.limits?.seats;
  return {
    unit_month: show(monthOf(input.interval)),
    seats_billed: seatsBilled,
    addons_month: show(addonsOf(input.interval)),
    month_total: show(month),
    year_total: show(month * 12),
    yearly_saving: show(saving),
    fits: cap === null || cap === undefined || seats <= cap,
    paid,
  };
};
