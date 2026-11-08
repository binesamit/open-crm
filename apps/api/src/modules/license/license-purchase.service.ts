// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  DEFAULT_GRACE_DAYS,
  EDITION_FEATURES,
  EDITION_SUPPORT,
  LICENSE_TERM_DAYS,
  type PublicCheckout,
  type PublicPurchaseConfig,
  PURCHASABLE_PLANS,
  type PurchasablePlan,
} from '@bines/shared';
import type { AppDeps } from '../../types';
import { RateLimiter } from '../../lib/rate-limit';
import { ipBucket } from '../../lib/client-ip';
import { appLink } from '../platform/public-address';
import {
  claimPaymentEvent,
  findLicenseBySubscription,
  releasePaymentEvent,
  settlePaymentEvent,
  type IssuedLicenseRow,
} from './license.repo';
import { insertSigned, limited, newRef, renewRow, sendKeyEmail, signerOr404 } from './license-server.service';
import {
  loadLicenseOps,
  offerOf,
  offersOf,
  paymentSecrets,
  paymentsReady,
  pricedPlans,
  purchasePlans,
} from './license-ops.settings';
import { type PaymentEvent, paymentProvider } from './license-payments';
import { handlePlanPaymentEvent } from '../billing/plan-payments';

/**
 * Buying a license online — on the license server only, and only once the owner set the payment
 * provider up (Licensing → Payments). Until then every purchase endpoint answers 404 and the pages hide the purchase.
 * Issuing and renewing by hand are not affected.
 *
 * 1. `/buy` → POST /public/licenses/checkout (rate-limited) → the provider's hosted payment page.
 * 2. The provider calls POST /public/licenses/webhook/{provider}: signature checked (401 otherwise), each event
 *    handled once (its id is recorded; a replay changes nothing): a completed checkout issues the key (the same
 *    signing service as the owner's "Issue") and emails it; a subscription's next paid invoice renews it (+1 year)
 *    and emails the new key.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'mailer' | 'secrets'>;

const checkoutPerIp = new RateLimiter(20, 60 * 60_000);
export const resetPurchaseLimits = () => checkoutPerIp.clear();

const DAY_MS = 86_400_000;

/** GET /public/licenses/purchase: what can be bought here (available: false = hide the purchase). */
export const publicPurchaseConfig = async (deps: Deps): Promise<PublicPurchaseConfig> => {
  await signerOr404(deps);
  const s = await loadLicenseOps(deps);
  if (!paymentsReady(s)) return { available: false, plans: [] };
  return {
    available: true,
    plans: pricedPlans(s).map((p) => ({
      plan: p.plan,
      seats: p.seats,
      amount: p.display_amount,
      currency: p.currency,
      // Only the tiers that can be bought online (a tier without a price is shown on the pricing page only).
      tiers: p.tiers.length
        ? offersOf(p)
            .filter((o) => !!o.price_id)
            .map((o) => ({ index: o.index ?? 0, seats: o.seats, amount: o.display_amount }))
        : [],
    })),
  };
};

/** POST /public/licenses/checkout: a checkout session at the provider; the buyer is sent to its `url`. */
export const createCheckout = async (deps: Deps, input: PublicCheckout, ip: string | null) => {
  await signerOr404(deps);
  limited(checkoutPerIp, ipBucket(ip));
  const s = await loadLicenseOps(deps);
  const secrets = paymentSecrets(deps, s);
  const price = purchasePlans(s)[input.plan];
  if (!paymentsReady(s) || !secrets) throw new AppError('not_found', 'Not found');
  const offer = offerOf(price, input.tier);
  if (!offer?.price_id) throw new AppError('invalid_value', 'plan_not_for_sale', { field: 'plan' });
  const locale = input.locale ?? 'he';
  try {
    const session = await paymentProvider('stripe')!.createCheckout(secrets, {
      plan: input.plan,
      tier: offer.index,
      priceId: offer.price_id,
      mode: price.mode,
      instanceId: input.instance_id ?? null,
      email: input.email ?? null,
      locale,
      successUrl: await appLink(deps, `/buy/success?locale=${locale}`),
      cancelUrl: await appLink(deps, `/buy?canceled=1&plan=${input.plan}`),
    });
    return { url: session.url };
  } catch (err) {
    deps.logger.warn({ err: err instanceof Error ? err.message : 'error' }, 'license checkout failed');
    throw new AppError('external_error', 'The payment provider could not start the checkout');
  }
};

const isPurchasable = (p: string | null): p is PurchasablePlan =>
  !!p && (PURCHASABLE_PLANS as readonly string[]).includes(p);

/** A completed checkout → a new license (or the one this subscription already has, for a delayed replay). */
const issuePurchased = async (deps: Deps, provider: string, ev: Extract<PaymentEvent, { kind: 'purchase' }>) => {
  if (!isPurchasable(ev.plan)) return null;
  if (ev.subscriptionId) {
    const existing = await findLicenseBySubscription(deps.db, provider, ev.subscriptionId);
    if (existing) return existing;
  }
  const s = await loadLicenseOps(deps);
  const plan = ev.plan;
  const row = await insertSigned(
    deps,
    {
      ref: newRef(),
      licensee: (ev.name ?? '').trim().slice(0, 200) || ev.email || 'Customer',
      plan,
      features: [...EDITION_FEATURES[plan]],
      // The tier bought gives its seats; else the edition's single offering.
      seats: (offerOf(purchasePlans(s)[plan], ev.tier) ?? offerOf(purchasePlans(s)[plan], null))?.seats ?? null,
      instanceId: ev.instanceId && /^[A-Za-z0-9-]{8,64}$/.test(ev.instanceId) ? ev.instanceId : null,
      expires: new Date(Date.now() + LICENSE_TERM_DAYS * DAY_MS),
      graceDays: DEFAULT_GRACE_DAYS,
      support: EDITION_SUPPORT[plan],
    },
    {
      email: ev.email,
      issuedBy: null,
      payment: {
        paymentProvider: provider,
        paymentCustomerId: ev.customerId,
        paymentSubscriptionId: ev.subscriptionId,
      },
    },
  );
  if (row.email) await sendKeyEmail(deps, row.email, row, ev.locale);
  return row;
};

/** A subscription's next paid period → the license renewed (+1 year) and the new key emailed. */
const renewPaid = async (deps: Deps, provider: string, subscriptionId: string) => {
  const row = await findLicenseBySubscription(deps.db, provider, subscriptionId);
  if (!row || row.revokedAt) return null;
  await renewRow(deps, row);
  const renewed = (await findLicenseBySubscription(deps.db, provider, subscriptionId))!;
  if (renewed.email) await sendKeyEmail(deps, renewed.email, renewed, undefined);
  return renewed;
};

/**
 * POST /public/licenses/webhook/{provider}. 404 where this is not a license server or the provider is not set up;
 * 401 on a bad signature (nothing read further); 200 otherwise — a replayed event id answers `duplicate`.
 */
export const handlePaymentWebhook = async (
  deps: Deps,
  providerKey: string,
  rawBody: string,
  headers: Record<string, string>,
) => {
  const provider = paymentProvider(providerKey);
  const s = await loadLicenseOps(deps);
  const secrets = paymentSecrets(deps, s);
  if (!provider || !secrets) throw new AppError('not_found', 'Not found');
  if (!provider.verifyWebhook(secrets, rawBody, headers)) throw new AppError('unauthenticated', 'invalid_signature');
  // One Stripe account, one endpoint: an account plan's events (self sign-up ה9) are the plan upgrades' — on any
  // installation that sells its plans, license server or not.
  if (provider.key === 'stripe') {
    let planEvent: Awaited<ReturnType<typeof handlePlanPaymentEvent>>;
    try {
      planEvent = await handlePlanPaymentEvent(deps, rawBody);
    } catch (err) {
      if (err instanceof SyntaxError) throw new AppError('bad_request', 'invalid_event');
      throw err;
    }
    if (planEvent) return planEvent;
  }
  await signerOr404(deps);
  let ev: PaymentEvent;
  try {
    ev = provider.parseEvent(rawBody);
  } catch {
    throw new AppError('bad_request', 'invalid_event');
  }
  if (!ev.id) throw new AppError('bad_request', 'invalid_event');
  if (ev.kind === 'ignored') return { received: true, handled: 'ignored' as const };
  if (!(await claimPaymentEvent(deps.db, provider.key, ev.id, ev.type)))
    return { received: true, handled: 'duplicate' as const };
  let license: IssuedLicenseRow | null;
  try {
    license =
      ev.kind === 'purchase'
        ? await issuePurchased(deps, provider.key, ev)
        : await renewPaid(deps, provider.key, ev.subscriptionId);
  } catch (err) {
    // Not recorded: the provider retries, and the retry is handled.
    await releasePaymentEvent(deps.db, provider.key, ev.id);
    deps.logger.error(
      { err: err instanceof Error ? err.message : 'error', event: ev.id, type: ev.type },
      'license payment webhook failed',
    );
    throw err;
  }
  await settlePaymentEvent(deps.db, provider.key, ev.id, license?.id ?? null);
  if (license) deps.logger.info({ event: ev.id, type: ev.type, license: license.ref }, 'license payment handled');
  return { received: true, handled: license ? (ev.kind === 'purchase' ? 'issued' : 'renewed') : 'ignored' } as const;
};
