// SPDX-License-Identifier: AGPL-3.0-only
import { eq, inArray } from 'drizzle-orm';
import { AppError, type PlanCancel, type PlanCancelPreview } from '@bines/shared';
import { noticeEmail } from '@bines/server-mail';
import { users } from '../../db/schema';
import { assertAccountAdmin } from '../../lib/account-admin';
import { st } from '../../lib/i18n';
import type { AccountContext, AppDeps, SessionUser } from '../../types';
import { recordAudit } from '../audit/audit.repo';
import { purchaseLegal } from '../legal/legal.service';
import { accountMailBrand, platformMailBrand } from '../platform/mail-brand';
import { appLink } from '../platform/public-address';
import { loadBillingSettings } from './billing-settings';
import { cancellationDto, computeCancellation, type StoredCancellation } from './cancellation-rules';
import { forgetEntitlements } from './entitlements';
import { money } from './plan-payments';
import { recordPlanChanged } from './plan-status';
import { activeAdminIds, currentSubscription, updateSubscription, type SubscriptionWithPlan } from './plans.repo';
import { accountPlanView } from './plans.service';
import { listAddons } from './pricing.service';
import { subscriptionControl } from './provider';

/**
 * The account's own cancel: an admin sees what cancelling would do (`GET /plan/cancel`) and confirms
 * it (`POST /plan/cancel`). The rules are the billing settings' (cancellation-rules.ts); the provider that bills the
 * subscription carries it out through its `SubscriptionControl` (none hard-coded); a subscription the owner set by
 * hand is cancelled here and the platform owners are told what to refund. A cancel with nothing refunded can be undone
 * until the period ends (`POST /plan/cancel/undo`).
 */
type Deps = Pick<AppDeps, 'db' | 'env' | 'logger' | 'mailer' | 'secrets'>;
type Actor = { ctx: AccountContext; user: SessionUser };

const toMinor = (v: number) => Math.round(v * 100);

/** What the subscription costs per period for what it holds: the plan (× seats when per seat) and its add-ons. */
const amounts = async (deps: Pick<Deps, 'db'>, sub: SubscriptionWithPlan) => {
  const qty = sub.version.pricing === 'per_seat' ? Math.max(1, sub.seats ?? 1) : 1;
  const held = (sub.addons ?? {}) as Record<string, { qty?: number }>;
  const prices = new Map((await listAddons(deps.db)).map((a) => [a.id, a]));
  let monthly = sub.version.priceMonthlyMinor * qty;
  let yearly = sub.version.priceYearlyMinor * qty;
  for (const [id, h] of Object.entries(held)) {
    const a = prices.get(id);
    const n = typeof h?.qty === 'number' ? h.qty : 0;
    if (!a || n <= 0) continue;
    monthly += toMinor(a.price_monthly) * n;
    yearly += toMinor(a.price_yearly) * n;
  }
  const year = sub.interval === 'year';
  return {
    paidMinor: year ? yearly : monthly,
    // A yearly plan with no monthly price: the yearly share is used instead (the rules handle null).
    monthlyMinor: sub.version.priceMonthlyMinor > 0 ? monthly : null,
    currency: sub.version.currency,
  };
};

const unavailable = (reason: NonNullable<PlanCancelPreview['reason']>, currency = 'ILS'): PlanCancelPreview => ({
  available: false,
  reason,
  case: null,
  interval: null,
  currency,
  paid: 0,
  monthly_price: null,
  months_used: null,
  fee: 0,
  refund: 0,
  ends_at: null,
  period_end: null,
  automatic_refund: false,
  terms: null,
});

const evaluate = async (deps: Deps, accountId: string, now = new Date()) => {
  const sub = await currentSubscription(deps.db, accountId);
  if (!sub) return { sub: null, preview: unavailable('no_subscription') } as const;
  const a = await amounts(deps, sub);
  if (sub.cancelAtPeriodEnd || sub.cancellation)
    return { sub, preview: unavailable('already_canceled', a.currency) } as const;
  if (!sub.purchasedAt && sub.trialEndsAt && sub.trialEndsAt > now)
    return { sub, preview: unavailable('trial', a.currency) } as const;
  if (a.paidMinor <= 0) return { sub, preview: unavailable('no_subscription', a.currency) } as const;
  const settings = await loadBillingSettings(deps.db);
  const out = computeCancellation({
    interval: sub.interval === 'year' ? 'year' : 'month',
    paidMinor: a.paidMinor,
    monthlyMinor: a.monthlyMinor,
    purchasedAt: sub.purchasedAt,
    periodStart: sub.periodStart,
    periodEnd: sub.periodEnd,
    now,
    settings,
  });
  const terms = (await purchaseLegal(deps.db))[0] ?? null;
  const control = sub.provider && sub.externalId ? await subscriptionControl(sub.provider, deps) : null;
  const preview: PlanCancelPreview = {
    available: true,
    reason: null,
    case: out.case,
    interval: sub.interval === 'year' ? 'year' : 'month',
    currency: a.currency,
    paid: a.paidMinor / 100,
    monthly_price: a.monthlyMinor === null ? null : a.monthlyMinor / 100,
    months_used: out.monthsUsed,
    fee: out.feeMinor / 100,
    refund: out.refundMinor / 100,
    ends_at: out.endsAt ? out.endsAt.toISOString() : null,
    period_end: sub.periodEnd ? sub.periodEnd.toISOString() : null,
    automatic_refund: !!control,
    terms,
  };
  return { sub, preview, out, amounts: a, control } as const;
};

/** GET /plan/cancel (account admins). */
export const previewCancel = async (deps: Deps, a: Actor): Promise<PlanCancelPreview> => {
  assertAccountAdmin(a.ctx);
  return (await evaluate(deps, a.ctx.accountId)).preview;
};

const adminRecipients = async (deps: Pick<Deps, 'db'>, accountId: string) => {
  const ids = await activeAdminIds(deps.db, accountId);
  return ids.length
    ? deps.db.select({ email: users.email, locale: users.locale }).from(users).where(inArray(users.id, ids))
    : [];
};

const dateIn = (d: Date | null, locale: string) =>
  d
    ? new Intl.DateTimeFormat(locale === 'he' ? 'he-IL' : 'en-GB', {
        dateStyle: 'long',
        timeZone: 'Asia/Jerusalem',
      }).format(d)
    : '—';

/** POST /plan/cancel (account admins): carries out what the preview showed. */
export const cancelPlan = async (deps: Deps, a: Actor, input: PlanCancel) => {
  assertAccountAdmin(a.ctx);
  if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed');
  const now = new Date();
  const ev = await evaluate(deps, a.ctx.accountId, now);
  if (!ev.preview.available || !('out' in ev) || !ev.out) throw new AppError('conflict', 'cancel_not_available');
  const { sub, out, preview, control } = ev;
  if (Math.abs(preview.refund - input.expected_refund) > 0.005) throw new AppError('conflict', 'cancel_changed');
  if (sub.provider && sub.externalId && !control) throw new AppError('external_error', 'billing_provider_unavailable');

  // 1. The provider stops billing (and refunds); a refund that fails after the cancel is left to the owners.
  let refunded: { amountMinor: number; currency: string } | null = null;
  let refundFailed = false;
  if (control && sub.externalId) {
    const when =
      out.case === 'cooling_off'
        ? ({ at: 'now' } as const)
        : out.case === 'yearly_refund' && out.endsAt
          ? ({ at: 'date', date: out.endsAt } as const)
          : ({ at: 'period_end' } as const);
    await control.cancel(sub.externalId, when);
    if (out.refundMinor > 0) {
      try {
        refunded = await control.refundLastPayment(sub.externalId, out.refundMinor / ev.amounts.paidMinor);
      } catch (err) {
        refundFailed = true;
        deps.logger.error(
          { err: err instanceof Error ? err.message : 'error', account: a.ctx.accountId },
          'plan cancel: refund failed',
        );
      }
    }
  }

  // 2. Our record: it ends at `ends_at` (the billing settings' `canceled_status` takes over from there).
  const stored: StoredCancellation = {
    case: out.case,
    refund_minor: out.refundMinor,
    currency: ev.amounts.currency,
    at: now.toISOString(),
    by: a.user.id,
    ends_at: out.endsAt ? out.endsAt.toISOString() : null,
  };
  await deps.db.transaction(async (tx) => {
    await updateSubscription(tx, sub.id, {
      cancelAtPeriodEnd: true,
      ...(out.endsAt ? { periodEnd: out.endsAt } : {}),
      cancellation: stored,
    });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'plan.canceled',
      targetType: 'subscription',
      targetId: sub.id,
      payload: {
        case: out.case,
        paid_minor: ev.amounts.paidMinor,
        fee_minor: out.feeMinor,
        refund_minor: out.refundMinor,
        refunded_minor: refunded?.amountMinor ?? 0,
        months_used: out.monthsUsed,
        ends_at: stored.ends_at,
        provider: sub.provider,
        reason: input.reason ?? null,
      },
    });
    await recordPlanChanged(tx, [a.ctx.accountId], { id: a.user.id, type: 'user' }, 'canceled');
  });
  forgetEntitlements(a.ctx.accountId);

  // 3. The cancellation confirmation to the admins; the owners hear of a refund they must make by hand.
  const account = a.ctx.account;
  const url = await appLink(deps, `/a/${account.slug}/admin/plan`);
  for (const admin of await adminRecipients(deps, a.ctx.accountId)) {
    const brand = await accountMailBrand(deps, account, admin.locale);
    const l = brand.locale;
    const v = {
      org: account.name,
      product: brand.product,
      plan: sub.plan.name,
      refund: money(out.refundMinor, ev.amounts.currency, l),
      fee: money(out.feeMinor, ev.amounts.currency, l),
      ends: dateIn(out.endsAt, l),
    };
    try {
      await deps.mailer.send(
        noticeEmail({
          to: admin.email,
          brand,
          subject: st('plan.cancel.mail.subject', v, l),
          title: st('plan.cancel.mail.subject', v, l),
          lines: [st(`plan.cancel.mail.${out.case}`, v, l)],
          cta: { label: st('plan.paid.cta', v, l), url },
          reason: st('signup.trial.reason', v, l),
        }),
      );
    } catch (err) {
      deps.logger.warn({ err, account: account.id }, 'plan cancel email failed');
    }
  }
  if (out.refundMinor > 0 && (!control || refundFailed || !refunded)) {
    const owners = await deps.db
      .select({ email: users.email, locale: users.locale })
      .from(users)
      .where(eq(users.isPlatformOwner, true));
    const ownerUrl = await appLink(deps, '/owner');
    for (const o of owners) {
      const brand = await platformMailBrand(deps, o.locale);
      const l = brand.locale;
      const v = {
        org: account.name,
        slug: account.slug,
        product: brand.product,
        refund: money(out.refundMinor, ev.amounts.currency, l),
      };
      try {
        await deps.mailer.send(
          noticeEmail({
            to: o.email,
            brand,
            subject: st('plan.cancel.owner.subject', v, l),
            title: st('plan.cancel.owner.subject', v, l),
            lines: [st('plan.cancel.owner.body', v, l)],
            cta: { label: st('plan.upgradeRequest.mail.cta', v, l), url: ownerUrl },
            reason: st('plan.upgradeRequest.mail.reason', v, l),
          }),
        );
      } catch (err) {
        deps.logger.warn({ err }, 'plan cancel owner email failed');
      }
    }
  }
  return accountPlanView(deps.db, a.ctx.accountId);
};

/** POST /plan/cancel/undo (account admins): a cancel with nothing refunded, before the period ends, is undone. */
export const undoCancel = async (deps: Deps, a: Actor) => {
  assertAccountAdmin(a.ctx);
  if (a.ctx.support) throw new AppError('forbidden', 'support_not_allowed');
  const sub = await currentSubscription(deps.db, a.ctx.accountId);
  if (!sub || !cancellationDto(sub, new Date())?.resumable) throw new AppError('conflict', 'cancel_not_resumable');
  if (sub.provider && sub.externalId) {
    const control = await subscriptionControl(sub.provider, deps);
    if (!control) throw new AppError('external_error', 'billing_provider_unavailable');
    await control.resume(sub.externalId);
  }
  await deps.db.transaction(async (tx) => {
    await updateSubscription(tx, sub.id, { cancelAtPeriodEnd: false, cancellation: null });
    await recordAudit(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      action: 'plan.cancel_undone',
      targetType: 'subscription',
      targetId: sub.id,
      payload: {},
    });
    await recordPlanChanged(tx, [a.ctx.accountId], { id: a.user.id, type: 'user' }, 'cancel_undone');
  });
  forgetEntitlements(a.ctx.accountId);
  return accountPlanView(deps.db, a.ctx.accountId);
};
