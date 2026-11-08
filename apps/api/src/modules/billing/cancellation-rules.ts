// SPDX-License-Identifier: AGPL-3.0-only
import type { BillingSettings, PlanCancelCase } from '@bines/shared';
import type { accountSubscriptions } from '../../db/schema';

/**
 * The account's own cancellation: pure rules, from the billing settings. Amounts in minor units.
 *
 * - inside `cooling_off_days` of buying: refund what was paid less the fee (`cancel_fee_pct` of it, at most
 *   `cancel_fee_cap`), access ends now;
 * - a monthly plan after that: no refund, it ends with the paid month (no renewal);
 * - a yearly plan after that, by `yearly_refund`: `monthly_rate` = what was paid less the months used at the monthly
 *   price (a started month counts as a whole one), access until the end of the last month counted; `pro_rata` = the
 *   unused months' share of the year; `none` = like a monthly plan. When the months used cost as much as the year,
 *   nothing comes back and the plan runs to the end of the paid year.
 */
export type CancelRulesInput = {
  interval: 'month' | 'year';
  paidMinor: number;
  /** The same seats and add-ons at the monthly price; null = no monthly price (the yearly share is used). */
  monthlyMinor: number | null;
  purchasedAt: Date | null;
  periodStart: Date;
  periodEnd: Date | null;
  now: Date;
  settings: Pick<BillingSettings, 'cooling_off_days' | 'cancel_fee_pct' | 'cancel_fee_cap' | 'yearly_refund'>;
};

export type CancelOutcome = {
  case: PlanCancelCase;
  feeMinor: number;
  refundMinor: number;
  monthsUsed: number | null;
  /** When access ends; null = the period has no end (an open-ended subscription ends with nothing to bill). */
  endsAt: Date | null;
};

const DAY = 86_400_000;

/** `from` plus whole months, the day clamped to the target month's length (31 Jan + 1 = 28/29 Feb). */
export const addMonths = (from: Date, months: number) => {
  const d = new Date(from);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
};

/** How many months of the period have started by `now` (the first one counts at once). */
export const monthsStarted = (start: Date, now: Date) => {
  let k = 1;
  while (k < 1200 && addMonths(start, k) <= now) k++;
  return k;
};

export const computeCancellation = (i: CancelRulesInput): CancelOutcome => {
  const s = i.settings;
  const inWindow =
    !!i.purchasedAt && s.cooling_off_days > 0 && i.now.getTime() < i.purchasedAt.getTime() + s.cooling_off_days * DAY;
  if (inWindow) {
    const pct = Math.round((i.paidMinor * s.cancel_fee_pct) / 100);
    const feeMinor = s.cancel_fee_cap === null ? pct : Math.min(pct, Math.round(s.cancel_fee_cap * 100));
    return {
      case: 'cooling_off',
      feeMinor,
      refundMinor: Math.max(0, i.paidMinor - feeMinor),
      monthsUsed: null,
      endsAt: i.now,
    };
  }
  if (i.interval === 'month' || s.yearly_refund === 'none')
    return { case: 'period_end', feeMinor: 0, refundMinor: 0, monthsUsed: null, endsAt: i.periodEnd };
  const monthsUsed = Math.min(12, monthsStarted(i.periodStart, i.now));
  const usedMinor =
    s.yearly_refund === 'pro_rata' || i.monthlyMinor === null
      ? Math.round((i.paidMinor * monthsUsed) / 12)
      : monthsUsed * i.monthlyMinor;
  const refundMinor = Math.max(0, i.paidMinor - usedMinor);
  if (refundMinor <= 0)
    return { case: 'yearly_no_refund', feeMinor: 0, refundMinor: 0, monthsUsed, endsAt: i.periodEnd };
  const lastMonth = addMonths(i.periodStart, monthsUsed);
  return {
    case: 'yearly_refund',
    feeMinor: 0,
    refundMinor,
    monthsUsed,
    endsAt: i.periodEnd && i.periodEnd < lastMonth ? i.periodEnd : lastMonth,
  };
};

/** What `account_subscriptions.cancellation` holds. */
export type StoredCancellation = {
  case: PlanCancelCase;
  refund_minor: number;
  currency: string;
  at: string;
  by: string | null;
  ends_at: string | null;
};

export const readCancellation = (raw: unknown): StoredCancellation | null => {
  const c = raw as Partial<StoredCancellation> | null | undefined;
  return c && typeof c.case === 'string' && typeof c.at === 'string' ? (c as StoredCancellation) : null;
};

/** The subscription DTO's `cancellation`: resumable while nothing was refunded and the period has not ended. */
export const cancellationDto = (
  s: Pick<typeof accountSubscriptions.$inferSelect, 'cancellation' | 'cancelAtPeriodEnd' | 'periodEnd' | 'endedAt'>,
  now: Date,
) => {
  const c = readCancellation(s.cancellation);
  if (!c) return null;
  return {
    case: c.case,
    refund: c.refund_minor / 100,
    currency: c.currency,
    at: c.at,
    resumable:
      !s.endedAt &&
      s.cancelAtPeriodEnd &&
      c.refund_minor === 0 &&
      c.case !== 'cooling_off' &&
      (!s.periodEnd || s.periodEnd > now),
  };
};
