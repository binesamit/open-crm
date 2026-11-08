// SPDX-License-Identifier: AGPL-3.0-only
import { inArray } from 'drizzle-orm';
import {
  AppError,
  PLAN_PAYMENT_INTERVALS,
  type PlanCheckout,
  type PlanCheckoutOptions,
  type PlanPaymentInterval,
  type PlanPayments,
  type UpdatePlanPayments,
} from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import { users } from '../../db/schema';
import { assertAccountAdmin } from '../../lib/account-admin';
import { st } from '../../lib/i18n';
import type { AccountContext, AppDeps, SessionUser } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { loadLicenseOps, paymentSecrets, type StoredLicenseOps } from '../license/license-ops.settings';
import { stripeCall } from '../license/license-payments';
import { claimPaymentEvent, releasePaymentEvent, settlePaymentEvent, writeSettingsRow } from '../license/license.repo';
import { accountMailBrand } from '../platform/mail-brand';
import { apiOrigin, appLink } from '../platform/public-address';
import { forgetEntitlements } from './entitlements';
import { loadBillingSettings } from './billing-settings';
import { registerSubscriptionControl, type SubscriptionControl } from './provider';
import { loadPlatformSettings } from '../platform/platform-settings';
import { recordPlanChanged } from './plan-status';
import {
  activeAdminIds,
  currentSubscription,
  insertSubscription,
  seatsUsed,
  subscriptionByProviderRef,
  updateSubscription,
} from './plans.repo';
import { listPlans, listPublicPlans } from './plans.service';
import { listActiveAddons, loadPricingPage, resolveAddons } from './pricing.service';
import { acceptLegal, assertAccepted, purchaseLegal } from '../legal/legal.service';
import type { RequestMeta } from '../../types';
import { findAccountById } from '../accounts/accounts.repo';
import { newId } from '@bines/shared';

/**
 * Paid upgrade through Stripe (self sign-up ה9, decision ⭐ "the same Stripe connection"). One Stripe account: the
 * license purchase's keys (sealed in the `license_ops` row, owner console → Licensing → Payments) also sell the
 * platform's public plans — each plan with a Stripe price per interval (`payments.account_plans`). Off by default;
 * the manual "request upgrade" stays.
 *
 * 1. My plan → Upgrade → POST /plan/checkout (account admins): a Stripe Checkout session (mode subscription) for the
 *    chosen plan and interval, tagged `kind=account_plan` + the account; the admin pays on Stripe's page.
 * 2. Stripe calls the license purchase's webhook (one endpoint, one signing secret); events of an account plan are
 *    handled here (`handlePlanPaymentEvent`), each once: the paid checkout makes the account's subscription the plan's
 *    current version, `active`, with Stripe's period (trial → active) and emails the admins; later invoices renew the
 *    period; a failed payment or a cancelled subscription makes it `past_due`, and the billing settings decide what
 *    follows (grace, read-only, suspended). The subscription's state is read back from Stripe, never from the event.
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'mailer' | 'secrets'>;
type Actor = { ctx: AccountContext; user: SessionUser; requestId?: string; meta?: RequestMeta };
type Prices = Record<string, { month: string | null; year: string | null }>;
const PROVIDER = 'stripe';
const ROW = 'license_ops';

type AccountPlans = { enabled?: boolean; prices?: Prices; addon_prices?: Prices };
const accountPlansOf = (s: StoredLicenseOps) =>
  ((s.payments as { account_plans?: AccountPlans } | undefined)?.account_plans ?? {}) as AccountPlans;

/** The public plans with at least one price, and their priced intervals. */
const pricedPlans = async (deps: Pick<Deps, 'db'>, s: StoredLicenseOps) => {
  const prices = accountPlansOf(s).prices ?? {};
  return (await listPublicPlans(deps.db)).data
    .map((p) => ({
      plan_id: p.id,
      name: p.name,
      intervals: PLAN_PAYMENT_INTERVALS.filter((i) => !!prices[p.id]?.[i]),
    }))
    .filter((p) => p.intervals.length > 0);
};

const ready = async (deps: Pick<Deps, 'db'>, s: StoredLicenseOps) =>
  !!accountPlansOf(s).enabled &&
  !!s.payments?.secret_key_sealed &&
  !!s.payments?.webhook_secret_sealed &&
  (await pricedPlans(deps, s)).length > 0;

/** The active add-ons with at least one Stripe price, and their priced intervals. */
const pricedAddons = async (deps: Pick<Deps, 'db'>, s: StoredLicenseOps) => {
  const prices = accountPlansOf(s).addon_prices ?? {};
  return (await listActiveAddons(deps.db))
    .map(({ active: _a, sort: _s, ...a }) => ({
      ...a,
      intervals: PLAN_PAYMENT_INTERVALS.filter((i) => !!prices[a.id]?.[i]),
    }))
    .filter((a) => a.intervals.length > 0);
};

const dto = async (deps: Deps, s: StoredLicenseOps): Promise<PlanPayments> => {
  const ap = accountPlansOf(s);
  const prices: Prices = {};
  for (const p of (await listPublicPlans(deps.db)).data)
    prices[p.id] = { month: ap.prices?.[p.id]?.month ?? null, year: ap.prices?.[p.id]?.year ?? null };
  const addonPrices: Prices = {};
  for (const a of await listActiveAddons(deps.db))
    addonPrices[a.id] = { month: ap.addon_prices?.[a.id]?.month ?? null, year: ap.addon_prices?.[a.id]?.year ?? null };
  return {
    enabled: !!ap.enabled,
    secret_key_set: !!s.payments?.secret_key_sealed,
    webhook_secret_set: !!s.payments?.webhook_secret_sealed,
    prices,
    addon_prices: addonPrices,
    ready: await ready(deps, s),
    webhook_url: `${await apiOrigin(deps)}/api/v1/public/licenses/webhook/stripe`,
  };
};

// ------------------------------------------------------------------------------------------------ owner

/** GET /platform/plan-payments. */
export const getPlanPayments = async (deps: Deps) => dto(deps, await loadLicenseOps(deps));

/**
 * PATCH /platform/plan-payments: only what is sent changes. The secrets are the license purchase's (one Stripe
 * account). Turning it on needs both secrets and a priced public plan (422 plan_payments_not_ready).
 */
export const updatePlanPayments = async (deps: Deps, owner: SessionUser, patch: UpdatePlanPayments) => {
  const s = await loadLicenseOps(deps);
  const pay = { ...(s.payments ?? {}) } as NonNullable<StoredLicenseOps['payments']> & { account_plans?: AccountPlans };
  if (patch.secret_key !== undefined)
    pay.secret_key_sealed = patch.secret_key ? deps.secrets.seal(patch.secret_key) : null;
  if (patch.webhook_secret !== undefined)
    pay.webhook_secret_sealed = patch.webhook_secret ? deps.secrets.seal(patch.webhook_secret) : null;
  const ap: AccountPlans = { ...(pay.account_plans ?? {}) };
  if (patch.enabled !== undefined) ap.enabled = patch.enabled;
  if (patch.prices) {
    const prices: Prices = { ...(ap.prices ?? {}) };
    for (const [planId, change] of Object.entries(patch.prices)) {
      const cur = prices[planId] ?? { month: null, year: null };
      prices[planId] = {
        month: change.month !== undefined ? change.month : cur.month,
        year: change.year !== undefined ? change.year : cur.year,
      };
    }
    ap.prices = prices;
  }
  if (patch.addon_prices) {
    const prices: Prices = { ...(ap.addon_prices ?? {}) };
    for (const [addonId, change] of Object.entries(patch.addon_prices)) {
      const cur = prices[addonId] ?? { month: null, year: null };
      prices[addonId] = {
        month: change.month !== undefined ? change.month : cur.month,
        year: change.year !== undefined ? change.year : cur.year,
      };
    }
    ap.addon_prices = prices;
  }
  pay.account_plans = ap;
  const next: StoredLicenseOps = { ...s, payments: pay };
  if (ap.enabled && !(await ready(deps, next)))
    throw new AppError('invalid_value', 'plan_payments_not_ready', { field: 'enabled' });
  await writeSettingsRow(deps.db, ROW, next as Record<string, unknown>, owner.id);
  return dto(deps, next);
};

// ------------------------------------------------------------------------------------------------ account

/** GET /plan/checkout (account admins): what Upgrade can pay for online (available: false = request only). */
export const planCheckoutOptions = async (deps: Deps, a: Actor): Promise<PlanCheckoutOptions> => {
  assertAccountAdmin(a.ctx);
  const s = await loadLicenseOps(deps);
  const vat_pct = (await loadPricingPage(deps.db)).vat_pct;
  const legal = await purchaseLegal(deps.db);
  if (!(await ready(deps, s))) return { available: false, plans: [], addons: [], vat_pct, legal };
  return { available: true, plans: await pricedPlans(deps, s), addons: await pricedAddons(deps, s), vat_pct, legal };
};

/** POST /plan/checkout (account admins): a Stripe Checkout session for the plan and interval → its `url`. */
export const createPlanCheckout = async (deps: Deps, a: Actor, input: PlanCheckout) => {
  assertAccountAdmin(a.ctx);
  if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed');
  const s = await loadLicenseOps(deps);
  const secrets = paymentSecrets(deps, s);
  if (!secrets || !(await ready(deps, s))) throw new AppError('not_found', 'Online upgrade is not available');
  const price = accountPlansOf(s).prices?.[input.plan_id]?.[input.interval];
  const offered = (await pricedPlans(deps, s)).some((p) => p.plan_id === input.plan_id);
  const plan = (await listPublicPlans(deps.db)).data.find((p) => p.id === input.plan_id);
  if (!price || !offered || !plan) throw new AppError('invalid_value', 'plan_not_for_sale');
  // The purchase documents: every current version ticked, recorded before Stripe's page opens.
  const purchaseDocs = await purchaseLegal(deps.db);
  assertAccepted(purchaseDocs, input.accepted);
  // Seats: a per-seat plan is bought for the seats asked (default: those in use), at least the
  // plan's minimum and never below the people already in the account; a flat price is one unit.
  const used = await seatsUsed(deps.db, a.ctx.accountId);
  const perSeat = plan.pricing === 'per_seat';
  const seats = perSeat ? Math.max(input.seats ?? used, plan.min_seats ?? 1, 1) : null;
  if (seats !== null && seats < used) throw new AppError('invalid_value', 'seats_below_usage', { field: 'seats' });
  if (seats !== null && plan.limits.seats != null && seats > plan.limits.seats)
    throw new AppError('invalid_value', 'seats_over_plan', { field: 'seats' });
  // Add-ons: each one wanted must be priced online for this interval; it is its own line, its quantity the units.
  const quantities = Object.fromEntries(Object.entries(input.addons ?? {}).filter(([, q]) => q > 0));
  await resolveAddons(deps.db, quantities);
  const addonPrices = accountPlansOf(s).addon_prices ?? {};
  const addonLines = Object.entries(quantities).map(([id, qty]) => {
    const p = addonPrices[id]?.[input.interval];
    if (!p) throw new AppError('invalid_value', 'addon_not_for_sale', { field: id });
    return { price: p, qty };
  });
  const lines: Record<string, string> = {
    'line_items[0][price]': price,
    'line_items[0][quantity]': String(seats ?? 1),
  };
  addonLines.forEach((l, i) => {
    lines[`line_items[${i + 1}][price]`] = l.price;
    lines[`line_items[${i + 1}][quantity]`] = String(l.qty);
  });
  const back = await appLink(deps, `/a/${a.ctx.account.slug}/admin/plan`);
  const meta = {
    kind: 'account_plan',
    account_id: a.ctx.accountId,
    plan_id: input.plan_id,
    interval: input.interval,
    seats: seats === null ? '' : String(seats),
    addons: Object.entries(quantities)
      .map(([id, qty]) => `${id}:${qty}`)
      .join(','),
  };
  const session = await stripeCall(secrets.secretKey, '/checkout/sessions', {
    mode: 'subscription',
    ...lines,
    success_url: `${back}?checkout=success`,
    cancel_url: `${back}?checkout=cancel`,
    customer_email: a.user.email,
    locale: a.user.locale === 'en' ? 'en' : 'auto',
    client_reference_id: a.ctx.accountId,
    ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`metadata[${k}]`, v])),
    ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [`subscription_data[metadata][${k}]`, v])),
  });
  const url = typeof session.url === 'string' ? session.url : null;
  if (!url) throw new AppError('external_error', 'checkout_failed');
  if (purchaseDocs.length)
    await acceptLegal(
      deps,
      a.user,
      purchaseDocs.map((d) => ({ slug: d.slug, version: d.version })),
      'checkout',
      a.meta ?? { ip: null, userAgent: null, requestId: a.requestId ?? '' },
    );
  await recordAudit(deps.db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action: 'plan.checkout_started',
    targetType: 'account',
    targetId: a.ctx.accountId,
    payload: {
      plan_id: input.plan_id,
      interval: input.interval,
      seats,
      addons: quantities,
      session: session.id ?? null,
    },
  });
  return { url };
};

// ------------------------------------------------------------------------------------------------ webhook

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' ? v : null);
const fromUnix = (v: number | null) => (v === null ? null : new Date(v * 1000));

/** A Stripe subscription read back: our status, its period (older API: on the subscription; newer: on its item). */
const readSubscription = async (secretKey: string, id: string) => {
  const sub = await stripeCall(secretKey, `/subscriptions/${encodeURIComponent(id)}`);
  const item = obj((obj(sub.items).data as unknown[] | undefined)?.[0]);
  const stripeStatus = str(sub.status) ?? '';
  const periodEnd = fromUnix(num(sub.current_period_end) ?? num(item.current_period_end));
  // The account's cancel inside a yearly period sets `cancel_at`: it ends there, not at the period's end.
  const cancelAt = fromUnix(num(sub.cancel_at));
  return {
    status: (['active', 'trialing'].includes(stripeStatus) ? 'active' : 'past_due') as 'active' | 'past_due',
    periodStart: fromUnix(num(sub.current_period_start) ?? num(item.current_period_start)),
    periodEnd: cancelAt && (!periodEnd || cancelAt < periodEnd) ? cancelAt : periodEnd,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true || !!cancelAt,
  };
};

/** The purchase confirmation: who sells, what was bought, how it renews, how to cancel. */
type Purchase = { interval: PlanPaymentInterval; amountMinor?: number; currency?: string };

export const money = (minor: number, currency: string, locale: string) =>
  new Intl.NumberFormat(locale === 'he' ? 'he-IL' : 'en-GB', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(minor / 100);

const disclosureLines = async (
  deps: Deps,
  v: Record<string, string>,
  purchase: Purchase,
  locale: 'he' | 'en',
): Promise<string[]> => {
  const [platform, billing, docs] = await Promise.all([
    loadPlatformSettings(deps.db),
    loadBillingSettings(deps.db),
    purchaseLegal(deps.db),
  ]);
  const legal = platform.legal;
  const interval = st(`plan.paid.disclosure.interval.${purchase.interval}`, v, locale);
  const lines = [
    st(
      'plan.paid.disclosure.seller',
      {
        ...v,
        company: legal.company_legal_name ?? legal.company_name ?? v.product ?? '',
        company_id: legal.company_id ?? '—',
        address: legal.company_address ?? '—',
        email: legal.contact_email ?? '—',
      },
      locale,
    ),
    st(
      'plan.paid.disclosure.deal',
      {
        ...v,
        interval,
        amount:
          purchase.amountMinor !== undefined && purchase.currency
            ? money(purchase.amountMinor, purchase.currency, locale)
            : '—',
      },
      locale,
    ),
    st('plan.paid.disclosure.renews', { ...v, interval }, locale),
  ];
  if (billing.cooling_off_days > 0)
    lines.push(
      st(
        'plan.paid.disclosure.cancel',
        {
          ...v,
          days: billing.cooling_off_days,
          fee_pct: billing.cancel_fee_pct,
          fee_cap:
            billing.cancel_fee_cap === null
              ? '—'
              : money(Math.round(billing.cancel_fee_cap * 100), purchase.currency ?? 'ILS', locale),
        },
        locale,
      ),
    );
  else lines.push(st('plan.paid.disclosure.cancelAnytime', v, locale));
  for (const d of docs)
    lines.push(
      st(
        'plan.paid.disclosure.terms',
        { ...v, title: d.title[locale], url: await appLink(deps, `/legal/${d.slug}`) },
        locale,
      ),
    );
  return lines;
};

const mailAdmins = async (
  deps: Deps,
  accountId: string,
  kind: 'active' | 'failed',
  plan: string,
  purchase?: Purchase,
) => {
  const account = await findAccountById(deps.db, accountId);
  const ids = account ? await activeAdminIds(deps.db, accountId) : [];
  if (!account || !ids.length) return;
  const admins = await deps.db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(inArray(users.id, ids));
  const url = await appLink(deps, `/a/${account.slug}/admin/plan`);
  for (const admin of admins) {
    const brand = await accountMailBrand(deps, account, admin.locale);
    const v = { org: account.name, plan, product: brand.product };
    try {
      await deps.mailer.send(
        noticeEmail({
          to: admin.email,
          brand,
          subject: st(`plan.paid.${kind}.subject`, v, brand.locale),
          title: st(`plan.paid.${kind}.subject`, v, brand.locale),
          hero:
            kind === 'active'
              ? {
                  kind: 'ticket',
                  caption: st('mail.obj.ticket.caption', v, brand.locale),
                  name: account.name,
                  stub: plan,
                  stamp: st('mail.obj.ticket.stamp', v, brand.locale),
                  fields: [[st('mail.obj.ticket.plan', v, brand.locale), plan]],
                }
              : { kind: 'card', stamp: st('mail.obj.card.stamp', v, brand.locale) },
          lines: [
            st(`plan.paid.${kind}.body`, v, brand.locale),
            ...(kind === 'active' && purchase ? await disclosureLines(deps, v, purchase, brand.locale) : []),
          ],
          cta: { label: st('plan.paid.cta', v, brand.locale), url },
          reason: st('signup.trial.reason', v, brand.locale),
        }),
      );
    } catch (err) {
      deps.logger.warn({ err, account: accountId }, 'plan payment email failed');
    }
  }
};

const planNameOf = async (deps: Pick<Deps, 'db'>, versionId: string) =>
  (await listPlans(deps.db)).find((p) => p.versions.some((v) => v.id === versionId))?.name ?? '';

/** The paid checkout: the account's subscription becomes the plan's current version, active, Stripe's period. */
const activate = async (deps: Deps, secretKey: string, o: Obj, eventId: string) => {
  const meta = obj(o.metadata);
  const accountId = str(meta.account_id);
  const planId = str(meta.plan_id);
  const interval = (str(meta.interval) === 'year' ? 'year' : 'month') as PlanPaymentInterval;
  const stripeSub = str(o.subscription);
  if (!accountId || !planId || !stripeSub) return 'ignored' as const;
  const plan = (await listPlans(deps.db)).find((p) => p.id === planId);
  const versionId = plan?.current_version_id;
  if (!plan || !versionId || !(await findAccountById(deps.db, accountId))) return 'ignored' as const;
  const truth = await readSubscription(secretKey, stripeSub);
  const now = new Date();
  const cur = await currentSubscription(deps.db, accountId);
  // What was bought: the seats of a per-seat plan, and the add-ons (a snapshot of each unit now
  // one no longer on offer is skipped rather than failing a paid checkout).
  const seatsMeta = str(meta.seats);
  const seats = seatsMeta && /^\d{1,6}$/.test(seatsMeta) ? Number(seatsMeta) : null;
  const held: Record<string, unknown> = {};
  for (const part of (str(meta.addons) ?? '').split(',')) {
    const [id, qty] = part.split(':');
    if (!id || !qty || !/^\d{1,4}$/.test(qty)) continue;
    Object.assign(held, await resolveAddons(deps.db, { [id]: Number(qty) }).catch(() => ({})));
  }
  const fields = {
    seats,
    addons: held,
    status: truth.status,
    statusSince: now,
    interval,
    periodStart: truth.periodStart ?? now,
    periodEnd: truth.periodEnd,
    trialEndsAt: null,
    trialEndStatus: null,
    cancelAtPeriodEnd: truth.cancelAtPeriodEnd,
    provider: PROVIDER,
    externalId: stripeSub,
    purchasedAt: now,
    cancellation: null,
    renewalRemindedFor: null,
  };
  await deps.db.transaction(async (tx) => {
    let subscriptionId: string;
    if (cur && cur.planVersionId === versionId) {
      subscriptionId = cur.id;
      await updateSubscription(tx, cur.id, fields);
    } else {
      if (cur) await updateSubscription(tx, cur.id, { endedAt: now });
      subscriptionId = newId();
      await insertSubscription(tx, {
        id: subscriptionId,
        accountId,
        planVersionId: versionId,
        ...fields,
        createdBy: null,
      });
    }
    await recordAudit(tx, {
      accountId,
      actorId: null,
      action: 'plan.purchased',
      targetType: 'subscription',
      targetId: subscriptionId,
      payload: { provider: PROVIDER, event_id: eventId, plan_id: planId, interval, before: cur?.status ?? null },
    });
    await recordPlanChanged(tx, [accountId], { id: null, type: 'system' }, 'provider_event');
  });
  forgetEntitlements(accountId);
  const amount = num(o.amount_total);
  const currency = str(o.currency);
  await mailAdmins(deps, accountId, 'active', plan.name, {
    interval,
    ...(amount !== null && currency ? { amountMinor: amount, currency: currency.toUpperCase() } : {}),
  });
  return 'activated' as const;
};

/** A later event of a subscription we know: its state read back from Stripe (renewal, failure, cancel). */
const refresh = async (deps: Deps, secretKey: string, stripeSub: string, type: string, eventId: string) => {
  const sub = await subscriptionByProviderRef(deps.db, PROVIDER, stripeSub);
  if (!sub) return 'ignored' as const;
  const deleted = type === 'customer.subscription.deleted';
  // Deleted after the account's own cancel: it ends as cancelled (the billing settings'
  // `canceled_status` once its period is over), not as a failed payment.
  const selfCancelled = deleted && sub.cancelAtPeriodEnd && !!sub.cancellation;
  const truth = selfCancelled
    ? {
        status: sub.status === 'past_due' ? ('past_due' as const) : ('active' as const),
        periodStart: null,
        periodEnd: null,
        cancelAtPeriodEnd: true,
      }
    : deleted
      ? { status: 'past_due' as const, periodStart: null, periodEnd: null, cancelAtPeriodEnd: false }
      : await readSubscription(secretKey, stripeSub);
  // A failed payment makes it past due at once, whatever Stripe's retries say; the billing settings take it on.
  const status = type === 'invoice.payment_failed' ? 'past_due' : truth.status;
  const now = new Date();
  await deps.db.transaction(async (tx) => {
    await updateSubscription(tx, sub.id, {
      status,
      ...(status !== sub.status ? { statusSince: now } : {}),
      ...(truth.periodStart ? { periodStart: truth.periodStart } : {}),
      ...(truth.periodEnd ? { periodEnd: truth.periodEnd } : {}),
      cancelAtPeriodEnd: truth.cancelAtPeriodEnd,
    });
    await recordAudit(tx, {
      accountId: sub.accountId,
      actorId: null,
      action: 'plan.provider_event',
      targetType: 'subscription',
      targetId: sub.id,
      payload: { provider: PROVIDER, event_id: eventId, type, before: sub.status, after: status },
    });
    await recordPlanChanged(tx, [sub.accountId], { id: null, type: 'system' }, 'provider_event');
  });
  forgetEntitlements(sub.accountId);
  if (status === 'past_due' && sub.status !== 'past_due')
    await mailAdmins(deps, sub.accountId, 'failed', await planNameOf(deps, sub.planVersionId));
  return status === 'past_due' ? ('past_due' as const) : ('renewed' as const);
};

const SUBSCRIPTION_EVENTS = new Set([
  'invoice.paid',
  'invoice.payment_failed',
  'customer.subscription.updated',
  'customer.subscription.deleted',
]);

/**
 * Called by the license purchase's webhook once Stripe's signature is checked: null = not an account plan's event
 * (the license purchase handles it); else handled once (its id recorded; a replay changes nothing; a failure is
 * forgotten so Stripe's retry is handled).
 */
export const handlePlanPaymentEvent = async (deps: Deps, rawBody: string) => {
  const ev = obj(JSON.parse(rawBody));
  const id = str(ev.id);
  const type = str(ev.type) ?? '';
  const o = obj(obj(ev.data).object);
  if (!id) return null;
  let stripeSub: string | null = null;
  if (type === 'checkout.session.completed') {
    if (str(obj(o.metadata).kind) !== 'account_plan') return null;
    const paid = o.payment_status === 'paid' || o.payment_status === 'no_payment_required';
    if (!paid) return { received: true, handled: 'ignored' as const };
  } else if (SUBSCRIPTION_EVENTS.has(type)) {
    stripeSub = type.startsWith('customer.subscription')
      ? str(o.id)
      : (str(o.subscription) ?? str(obj(obj(o.parent).subscription_details).subscription));
    if (!stripeSub || !(await subscriptionByProviderRef(deps.db, PROVIDER, stripeSub))) return null;
  } else return null;
  const secrets = paymentSecrets(deps, await loadLicenseOps(deps));
  if (!secrets) return null;
  if (!(await claimPaymentEvent(deps.db, PROVIDER, id, type))) return { received: true, handled: 'duplicate' as const };
  try {
    const handled = stripeSub
      ? await refresh(deps, secrets.secretKey, stripeSub, type, id)
      : await activate(deps, secrets.secretKey, o, id);
    await settlePaymentEvent(deps.db, PROVIDER, id, null);
    deps.logger.info({ event: id, type, handled }, 'plan payment handled');
    return { received: true, handled };
  } catch (err) {
    await releasePaymentEvent(deps.db, PROVIDER, id);
    deps.logger.error({ err: err instanceof Error ? err.message : 'error', event: id, type }, 'plan payment failed');
    throw err;
  }
};

// ------------------------------------------------------------------------------------------------ cancel / refund

/**
 * The built-in Stripe connection's side of the account's own cancel: end the subscription (now, at a
 * date, or at the period's end), undo a cancel at period end, and refund a share of the last payment.
 */
const stripeControl = (secretKey: string): SubscriptionControl => ({
  async cancel(externalId, when) {
    const path = `/subscriptions/${encodeURIComponent(externalId)}`;
    if (when.at === 'now') await stripeCall(secretKey, path, undefined, 'DELETE');
    else if (when.at === 'period_end') await stripeCall(secretKey, path, { cancel_at_period_end: 'true' });
    else
      await stripeCall(secretKey, path, {
        cancel_at: String(Math.floor(when.date.getTime() / 1000)),
        proration_behavior: 'none',
      });
  },
  async resume(externalId) {
    await stripeCall(secretKey, `/subscriptions/${encodeURIComponent(externalId)}`, { cancel_at_period_end: 'false' });
  },
  async refundLastPayment(externalId, share) {
    const sub = await stripeCall(secretKey, `/subscriptions/${encodeURIComponent(externalId)}?expand[]=latest_invoice`);
    const inv = obj(sub.latest_invoice);
    const paid = num(inv.amount_paid) ?? 0;
    const currency = (str(inv.currency) ?? '').toUpperCase();
    const amount = Math.min(paid, Math.round(paid * Math.max(0, Math.min(1, share))));
    if (amount <= 0 || !currency) return null;
    // Older API versions: the invoice names its payment; newer ones list it under /invoice_payments.
    let paymentIntent = str(inv.payment_intent) ?? str(obj(inv.payment_intent).id);
    let charge = str(inv.charge);
    if (!paymentIntent && !charge && str(inv.id)) {
      const list = await stripeCall(secretKey, `/invoice_payments?invoice=${encodeURIComponent(str(inv.id)!)}&limit=1`);
      const payment = obj(obj((list.data as unknown[] | undefined)?.[0]).payment);
      paymentIntent = str(payment.payment_intent);
      charge = str(payment.charge);
    }
    if (!paymentIntent && !charge) throw new Error('stripe refund: no payment found for the last invoice');
    await stripeCall(secretKey, '/refunds', {
      ...(paymentIntent ? { payment_intent: paymentIntent } : { charge }),
      amount: String(amount),
      'metadata[kind]': 'account_plan_cancel',
    });
    return { amountMinor: amount, currency };
  },
});

registerSubscriptionControl(PROVIDER, async (deps: Pick<Deps, 'db' | 'secrets'>) => {
  const secrets = paymentSecrets(deps, await loadLicenseOps(deps));
  return secrets ? stripeControl(secrets.secretKey) : null;
});
