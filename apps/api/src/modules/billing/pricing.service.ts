// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import {
  type AddonQuantities,
  AppError,
  newId,
  PLAN_LIMIT_KINDS,
  type PlanAddon,
  planAddonInputSchema,
  type PlanLimitKind,
  type PricingPageSettings,
  pricingPageSettingsSchema,
  type PublicPricing,
  PURCHASABLE_PLANS,
  type SubscriptionAddons,
  type updatePlanAddonSchema,
  type updatePricingPageSettingsSchema,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import { planAddons } from '../../db/schema';
import type { AppDeps, SessionUser } from '../../types';
import { readSettingsRow, writeSettingsRow } from '../license/license.repo';
import { loadLicenseOps, offersOf, paymentsReady, purchasePlans } from '../license/license-ops.settings';
import { licenseSigner } from '../license/license-signing';
import { signupConfig } from '../signup/signup.service';
import { loadBillingSettings } from './billing-settings';
import { listPublicPlans } from './plans.service';

/**
 * The pricing page (the planning notes "PRICING"): the owner's add-ons, the page's settings (its own
 * `platform_settings` row, `pricing_page`), and the public JSON (`GET /public/pricing`) the page, the upgrade dialog
 * and any site the owner lists read. Every price, name and text is the owner's; nothing is seeded.
 */

const toMinor = (v: number) => Math.round(v * 100);
const fromMinor = (v: number) => v / 100;
const isLimitKind = (k: string): k is PlanLimitKind => (PLAN_LIMIT_KINDS as readonly string[]).includes(k);

// ------------------------------------------------------------------------------------------------ add-ons

type AddonRow = typeof planAddons.$inferSelect;

const addonDto = (r: AddonRow): PlanAddon => ({
  id: r.id,
  name: r.name,
  description: r.description,
  limit_kind: isLimitKind(r.limitKind) ? r.limitKind : 'storage_gb',
  unit_amount: r.unitAmount,
  price_monthly: fromMinor(r.priceMonthlyMinor),
  price_yearly: fromMinor(r.priceYearlyMinor),
  currency: r.currency,
  vat_included: r.vatIncluded,
  plan_ids: Array.isArray(r.planIds) ? r.planIds : [],
  max_qty: r.maxQty,
  sort: r.sort,
  active: r.active,
});

const addonValues = (v: Partial<z.output<typeof planAddonInputSchema>>) => ({
  ...(v.name !== undefined ? { name: v.name } : {}),
  ...(v.description !== undefined ? { description: v.description?.trim() || null } : {}),
  ...(v.limit_kind !== undefined ? { limitKind: v.limit_kind } : {}),
  ...(v.unit_amount !== undefined ? { unitAmount: v.unit_amount } : {}),
  ...(v.price_monthly !== undefined ? { priceMonthlyMinor: toMinor(v.price_monthly) } : {}),
  ...(v.price_yearly !== undefined ? { priceYearlyMinor: toMinor(v.price_yearly) } : {}),
  ...(v.currency !== undefined ? { currency: v.currency } : {}),
  ...(v.vat_included !== undefined ? { vatIncluded: v.vat_included } : {}),
  ...(v.plan_ids !== undefined ? { planIds: [...new Set(v.plan_ids)] } : {}),
  ...(v.max_qty !== undefined ? { maxQty: v.max_qty } : {}),
  ...(v.sort !== undefined ? { sort: v.sort } : {}),
  ...(v.active !== undefined ? { active: v.active } : {}),
});

/** Every add-on (the owner console), in the owner's order. */
export const listAddons = async (db: Db): Promise<PlanAddon[]> =>
  (await db.select().from(planAddons).orderBy(asc(planAddons.sort), asc(planAddons.createdAt))).map(addonDto);

/** The add-ons on offer (active). */
export const listActiveAddons = async (db: Db) => (await listAddons(db)).filter((a) => a.active);

const findAddon = async (db: Db, id: string) => {
  const row = (await db.select().from(planAddons).where(eq(planAddons.id, id)).limit(1))[0];
  if (!row) throw new AppError('not_found', 'Add-on not found');
  return row;
};

export const createAddon = async (db: Db, owner: SessionUser, input: z.input<typeof planAddonInputSchema>) => {
  const v = planAddonInputSchema.parse(input);
  const id = newId();
  await db.insert(planAddons).values({
    id,
    name: v.name,
    limitKind: v.limit_kind,
    unitAmount: v.unit_amount,
    ...addonValues(v),
    createdBy: owner.id,
  });
  return addonDto(await findAddon(db, id));
};

/** Changing an add-on never changes what subscriptions already hold (they keep a snapshot). */
export const updateAddon = async (db: Db, id: string, input: z.infer<typeof updatePlanAddonSchema>) => {
  await findAddon(db, id);
  await db
    .update(planAddons)
    .set({ ...addonValues(input), updatedAt: new Date() })
    .where(eq(planAddons.id, id));
  return addonDto(await findAddon(db, id));
};

export const deleteAddon = async (db: Db, id: string) => {
  await findAddon(db, id);
  await db.delete(planAddons).where(eq(planAddons.id, id));
};

/**
 * Quantities → what a subscription holds (a snapshot of each add-on's unit at this moment). 0 drops it. An unknown,
 * inactive or over-the-maximum add-on is refused (422 `addon_invalid`) — except one already `held` at the same
 * quantity, which keeps its snapshot (an add-on taken off sale stays with those who have it).
 */
export const resolveAddons = async (
  db: Db,
  quantities: AddonQuantities,
  held: SubscriptionAddons = {},
): Promise<SubscriptionAddons> => {
  const wanted = Object.entries(quantities).filter(([, qty]) => qty > 0);
  if (!wanted.length) return {};
  const all = new Map((await listAddons(db)).map((a) => [a.id, a]));
  const out: SubscriptionAddons = {};
  for (const [id, qty] of wanted) {
    if (held[id]?.qty === qty) {
      out[id] = held[id];
      continue;
    }
    const a = all.get(id);
    if (!a || !a.active || qty > a.max_qty) throw new AppError('invalid_value', 'addon_invalid', { field: id });
    out[id] = { qty, limit_kind: a.limit_kind, amount: qty * a.unit_amount, name: a.name };
  }
  return out;
};

// ------------------------------------------------------------------------------------------------ page settings

const ROW = 'pricing_page';
const CACHE_MS = 30_000;
let cache: { at: number; value: PricingPageSettings } | null = null;

export const loadPricingPage = async (db: Db): Promise<PricingPageSettings> => {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const parsed = pricingPageSettingsSchema.safeParse((await readSettingsRow(db, ROW)) ?? {});
  const value = parsed.success ? parsed.data : pricingPageSettingsSchema.parse({});
  cache = { at: Date.now(), value };
  return value;
};

export const forgetPricingPage = () => {
  cache = null;
};

/** PATCH /platform/pricing-page: only what is sent changes. */
export const updatePricingPage = async (
  db: Db,
  owner: SessionUser,
  patch: z.infer<typeof updatePricingPageSettingsSchema>,
) => {
  const current = await loadPricingPage(db);
  const changes = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const next = pricingPageSettingsSchema.parse({ ...current, ...changes });
  await writeSettingsRow(db, ROW, next as Record<string, unknown>, owner.id);
  cache = null;
  return next;
};

// ------------------------------------------------------------------------------------------------ public JSON

type Deps = AppDeps;

/** The self-hosted editions with their tiers (the license server only; null elsewhere). */
const selfHost = async (deps: Deps): Promise<PublicPricing['self_host']> => {
  if (!(await licenseSigner(deps))) return null;
  const s = await loadLicenseOps(deps);
  const plans = purchasePlans(s);
  const editions = PURCHASABLE_PLANS.map((plan) => ({
    plan,
    currency: plans[plan].currency,
    tiers: offersOf(plans[plan])
      .filter((o) => o.display_amount !== null || !!o.price_id)
      .map((o) => ({ index: o.index ?? 0, seats: o.seats, amount: o.display_amount })),
  }));
  return { buy_available: paymentsReady(s), editions };
};

/**
 * GET /public/pricing (no sign-in): the page off = `enabled: false` and every list empty. On: the public plans at
 * their current version (the owner's order) with the marketing fields and limits, the active add-ons, the page's
 * texts, whether sign-up is open, and (the license server) the self-hosted editions.
 */
export const publicPricing = async (deps: Deps): Promise<PublicPricing> => {
  const page = await loadPricingPage(deps.db);
  if (!page.enabled)
    return {
      enabled: false,
      headline: '',
      subheadline: '',
      yearly_note: '',
      plans: [],
      addons: [],
      vat_pct: page.vat_pct,
      vat_default_on: page.vat_default_on,
      contact_url: null,
      custom: null,
      faq: [],
      signup_open: false,
      features: [],
      self_host: null,
    };
  const [offer, addons, billing, signup, host] = await Promise.all([
    listPublicPlans(deps.db),
    listActiveAddons(deps.db),
    loadBillingSettings(deps.db),
    signupConfig(deps).catch(() => ({ open: false })),
    selfHost(deps),
  ]);
  return {
    enabled: true,
    headline: page.headline,
    subheadline: page.subheadline,
    yearly_note: page.yearly_note,
    plans: offer.data.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      highlights: p.highlights,
      recommended: p.recommended,
      min_seats: p.min_seats,
      price_monthly: p.price_monthly,
      price_yearly: p.price_yearly,
      currency: p.currency,
      vat_included: p.vat_included,
      pricing: p.pricing,
      trial_days: p.trial_days,
      limits: p.limits,
      features: p.features,
    })),
    addons: addons.map(({ active: _a, sort: _s, ...a }) => a),
    vat_pct: page.vat_pct,
    vat_default_on: page.vat_default_on,
    contact_url: page.contact_url,
    custom: page.custom_name ? { name: page.custom_name, text: page.custom_text } : null,
    faq: page.faq,
    signup_open: signup.open,
    features: billing.features,
    self_host: host,
  };
};

/**
 * The sites the owner listed may read `GET /public/pricing` from a browser (no cookies). Runs before the
 * platform's own CORS and puts the listed origin back after it.
 */
export const pricingCors =
  (deps: Pick<AppDeps, 'db'>): MiddlewareHandler =>
  async (c, next) => {
    await next();
    const origin = c.req.header('origin');
    if (!origin || c.req.method !== 'GET') return;
    const page = await loadPricingPage(deps.db).catch(() => null);
    if (!page?.enabled || !page.cors_origins.includes(origin)) return;
    c.res.headers.set('Access-Control-Allow-Origin', origin);
    c.res.headers.delete('Access-Control-Allow-Credentials');
    c.res.headers.append('Vary', 'Origin');
  };
