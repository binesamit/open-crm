// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addMonths, computeCancellation, monthsStarted } from '../src/modules/billing/cancellation-rules';

/**
 * The account's own cancel, the product owner's rules: a monthly plan is never refunded after the window; a yearly
 * one refunds what was paid less the months used at the monthly price (a started month counts); nothing back when
 * that reaches the yearly price; inside the window, a refund less the fee (the lower of the share and the cap).
 */
const settings = {
  cooling_off_days: 14,
  cancel_fee_pct: 5,
  cancel_fee_cap: 100,
  yearly_refund: 'monthly_rate' as const,
};
const d = (s: string) => new Date(`${s}T10:00:00Z`);

describe('cancellation rules', () => {
  it('counts started months and clamps month ends', () => {
    expect(monthsStarted(d('2026-01-15'), d('2026-01-15'))).toBe(1);
    expect(monthsStarted(d('2026-01-15'), d('2026-02-14'))).toBe(1);
    expect(monthsStarted(d('2026-01-15'), d('2026-02-15'))).toBe(2);
    expect(monthsStarted(d('2026-01-15'), d('2026-05-20'))).toBe(5);
    expect(addMonths(d('2026-01-31'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('inside the window: refund less the fee — the share or the cap, the lower', () => {
    const base = {
      interval: 'year' as const,
      monthlyMinor: 12_000,
      purchasedAt: d('2026-01-01'),
      periodStart: d('2026-01-01'),
      periodEnd: d('2027-01-01'),
      now: d('2026-01-10'),
      settings,
    };
    // 5% of ₪1,200 = ₪60 (under the ₪100 cap)
    expect(computeCancellation({ ...base, paidMinor: 120_000 })).toMatchObject({
      case: 'cooling_off',
      feeMinor: 6_000,
      refundMinor: 114_000,
    });
    // 5% of ₪4,000 = ₪200 → capped at ₪100
    const big = computeCancellation({ ...base, paidMinor: 400_000 });
    expect(big).toMatchObject({ case: 'cooling_off', feeMinor: 10_000, refundMinor: 390_000 });
    expect(big.endsAt).toEqual(base.now);
    // no cap
    expect(
      computeCancellation({ ...base, paidMinor: 400_000, settings: { ...settings, cancel_fee_cap: null } }).feeMinor,
    ).toBe(20_000);
    // the window closed (day 15), or none at all
    expect(computeCancellation({ ...base, paidMinor: 120_000, now: d('2026-01-16') }).case).not.toBe('cooling_off');
    expect(
      computeCancellation({ ...base, paidMinor: 120_000, settings: { ...settings, cooling_off_days: 0 } }).case,
    ).not.toBe('cooling_off');
    // a subscription the owner set by hand has no purchase moment: no window
    expect(computeCancellation({ ...base, paidMinor: 120_000, purchasedAt: null }).case).not.toBe('cooling_off');
  });

  it('monthly after the window: no refund, it ends with the paid month', () => {
    const r = computeCancellation({
      interval: 'month',
      paidMinor: 12_000,
      monthlyMinor: 12_000,
      purchasedAt: d('2026-01-01'),
      periodStart: d('2026-03-01'),
      periodEnd: d('2026-04-01'),
      now: d('2026-03-20'),
      settings,
    });
    expect(r).toMatchObject({ case: 'period_end', refundMinor: 0, feeMinor: 0 });
    expect(r.endsAt).toEqual(d('2026-04-01'));
  });

  it('yearly: paid less the months used at the monthly price, access to the end of the last month counted', () => {
    // ₪1,200 a year, ₪120 a month, 4 months started → 1,200 − 480 = ₪720
    const r = computeCancellation({
      interval: 'year',
      paidMinor: 120_000,
      monthlyMinor: 12_000,
      purchasedAt: d('2026-01-01'),
      periodStart: d('2026-01-01'),
      periodEnd: d('2027-01-01'),
      now: d('2026-04-10'),
      settings,
    });
    expect(r).toMatchObject({ case: 'yearly_refund', monthsUsed: 4, refundMinor: 72_000 });
    expect(r.endsAt).toEqual(d('2026-05-01'));
  });

  it('yearly: nothing back when the months used reach the yearly price — it runs to the end of the year', () => {
    // ₪1,000 a year, ₪120 a month: 9 months = ₪1,080 ≥ ₪1,000
    const r = computeCancellation({
      interval: 'year',
      paidMinor: 100_000,
      monthlyMinor: 12_000,
      purchasedAt: d('2026-01-01'),
      periodStart: d('2026-01-01'),
      periodEnd: d('2027-01-01'),
      now: d('2026-09-05'),
      settings,
    });
    expect(r).toMatchObject({ case: 'yearly_no_refund', refundMinor: 0, monthsUsed: 9 });
    expect(r.endsAt).toEqual(d('2027-01-01'));
  });

  it('yearly under the other settings: pro rata, none, or no monthly price', () => {
    const base = {
      interval: 'year' as const,
      paidMinor: 120_000,
      monthlyMinor: 15_000,
      purchasedAt: null,
      periodStart: d('2026-01-01'),
      periodEnd: d('2027-01-01'),
      now: d('2026-03-10'),
    };
    expect(computeCancellation({ ...base, settings: { ...settings, yearly_refund: 'pro_rata' } })).toMatchObject({
      case: 'yearly_refund',
      refundMinor: 90_000,
    });
    expect(computeCancellation({ ...base, settings: { ...settings, yearly_refund: 'none' } }).case).toBe('period_end');
    expect(computeCancellation({ ...base, monthlyMinor: null, settings }).refundMinor).toBe(90_000);
  });
});
