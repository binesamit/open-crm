// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  LICENSE_REMINDER_DAYS_DEFAULT,
  type LicenseOps,
  type PurchasablePlan,
  PURCHASABLE_PLANS,
  type PurchasePlan,
  purchasePlanSchema,
  reminderDaysSchema,
  type UpdateLicenseOps,
} from '@bines/shared';
import type { AppDeps, SessionUser } from '../../types';
import { apiOrigin, appLink } from '../platform/public-address';
import { readSettingsRow, writeSettingsRow } from './license.repo';

/**
 * The license server's operations settings — one `platform_settings` row (`license_ops`)
 * expiry reminders (on, 30 and 7 days by default) and the optional online purchase (OFF by default; Stripe first).
 * The provider's secret key and webhook signing secret are sealed with the secret box and never leave the server —
 * the console sees only whether each is set.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'secrets'>;

const ROW = 'license_ops';

export type StoredLicenseOps = {
  reminders?: { enabled?: boolean; days?: number[] };
  payments?: {
    enabled?: boolean;
    secret_key_sealed?: string | null;
    webhook_secret_sealed?: string | null;
    plans?: Partial<Record<PurchasablePlan, Partial<PurchasePlan>>>;
  };
};

const EMPTY_PLAN: PurchasePlan = {
  price_id: '',
  seats: null,
  mode: 'subscription',
  display_amount: null,
  currency: 'USD',
  tiers: [],
};

const planOf = (raw: Partial<PurchasePlan> | undefined): PurchasePlan => {
  const parsed = purchasePlanSchema.safeParse({ ...EMPTY_PLAN, ...raw });
  return parsed.success ? parsed.data : EMPTY_PLAN;
};

export const loadLicenseOps = async (deps: Pick<Deps, 'db'>): Promise<StoredLicenseOps> =>
  ((await readSettingsRow(deps.db, ROW)) ?? {}) as StoredLicenseOps;

/** The reminder settings in effect (the defaults when nothing is stored, or what is stored is not valid). */
export const reminderSettings = (s: StoredLicenseOps) => {
  const days = reminderDaysSchema.safeParse(s.reminders?.days);
  return {
    enabled: s.reminders?.enabled ?? true,
    days: (days.success ? days.data : [...LICENSE_REMINDER_DAYS_DEFAULT]).slice().sort((a, b) => b - a),
  };
};

export const purchasePlans = (s: StoredLicenseOps) =>
  Object.fromEntries(PURCHASABLE_PLANS.map((p) => [p, planOf(s.payments?.plans?.[p])])) as Record<
    PurchasablePlan,
    PurchasePlan
  >;

/**
 * What an edition offers: its tiers (index = the tier's place), or, with none, the single offering
 * (index null). Each with the seats it gives, its provider price (empty = shown only) and the price shown.
 */
export const offersOf = (p: PurchasePlan) =>
  p.tiers.length
    ? p.tiers.map((t, index) => ({ index: index as number | null, ...t }))
    : [{ index: null as number | null, seats: p.seats, price_id: p.price_id, display_amount: p.display_amount }];

/** The offer a purchase names: a tier by its index, else the single offering (undefined = no such offer). */
export const offerOf = (p: PurchasePlan, tier: number | null | undefined) =>
  p.tiers.length ? offersOf(p).find((o) => o.index === (tier ?? 0)) : offersOf(p)[0];

/** The editions on sale: those with a price id (on the single offering or on some tier). */
export const pricedPlans = (s: StoredLicenseOps) =>
  PURCHASABLE_PLANS.filter((p) => offersOf(purchasePlans(s)[p]).some((o) => !!o.price_id)).map((p) => ({
    plan: p,
    ...purchasePlans(s)[p],
  }));

/** On, both secrets set and at least one edition priced: the purchase is live. */
export const paymentsReady = (s: StoredLicenseOps) =>
  !!s.payments?.enabled &&
  !!s.payments.secret_key_sealed &&
  !!s.payments.webhook_secret_sealed &&
  pricedPlans(s).length > 0;

/** The opened secrets for a call to the provider (never logged, never returned). */
export const paymentSecrets = (deps: Pick<Deps, 'secrets'>, s: StoredLicenseOps) => {
  const p = s.payments ?? {};
  if (!p.secret_key_sealed || !p.webhook_secret_sealed) return null;
  return {
    secretKey: deps.secrets.open(p.secret_key_sealed),
    webhookSecret: deps.secrets.open(p.webhook_secret_sealed),
  };
};

export const licenseOpsDto = async (deps: Deps, s: StoredLicenseOps): Promise<LicenseOps> => ({
  reminders: reminderSettings(s),
  payments: {
    provider: 'stripe',
    enabled: !!s.payments?.enabled,
    secret_key_set: !!s.payments?.secret_key_sealed,
    webhook_secret_set: !!s.payments?.webhook_secret_sealed,
    plans: purchasePlans(s),
    ready: paymentsReady(s),
    webhook_url: `${await apiOrigin(deps)}/api/v1/public/licenses/webhook/stripe`,
    buy_url: await appLink(deps, '/buy'),
  },
});

/**
 * PATCH /platform/license-ops: only what is sent changes. Turning the purchase on needs both secrets and a priced
 * edition (422 `invalid_value` payments_not_ready) — the public page never shows a purchase that cannot complete.
 */
export const updateLicenseOps = async (deps: Deps, owner: SessionUser, patch: UpdateLicenseOps) => {
  const s = await loadLicenseOps(deps);
  const pay = { ...(s.payments ?? {}) };
  const p = patch.payments;
  if (p) {
    if (p.enabled !== undefined) pay.enabled = p.enabled;
    if (p.secret_key !== undefined) pay.secret_key_sealed = p.secret_key ? deps.secrets.seal(p.secret_key) : null;
    if (p.webhook_secret !== undefined)
      pay.webhook_secret_sealed = p.webhook_secret ? deps.secrets.seal(p.webhook_secret) : null;
    if (p.plans) {
      const plans = { ...(pay.plans ?? {}) };
      for (const plan of PURCHASABLE_PLANS) {
        const change = p.plans[plan];
        if (change) plans[plan] = { ...planOf(plans[plan]), ...change };
      }
      pay.plans = plans;
    }
  }
  const next: StoredLicenseOps = {
    ...s,
    reminders: { ...reminderSettings(s), ...(patch.reminders ?? {}) },
    payments: pay,
  };
  if (next.payments?.enabled && !paymentsReady(next))
    throw new AppError('invalid_value', 'payments_not_ready', { field: 'payments' });
  await writeSettingsRow(deps.db, ROW, next as Record<string, unknown>, owner.id);
  return licenseOpsDto(deps, next);
};
