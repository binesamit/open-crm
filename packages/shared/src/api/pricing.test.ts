// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addonExtras, mergeLimits } from './plans';
import { quotePlan } from './pricing';

/** The calculator's one calculation: per seat or flat, monthly or yearly, VAT, add-ons, limits. */
const pro = {
  id: 'pro',
  price_monthly: 85,
  price_yearly: 828,
  vat_included: false,
  pricing: 'per_seat' as const,
  min_seats: null,
  limits: {},
};
const storage = {
  id: 'st',
  price_monthly: 29,
  price_yearly: 290,
  vat_included: false,
  plan_ids: [],
  max_qty: 20,
};

describe('quotePlan', () => {
  it('per seat, monthly, before VAT', () => {
    const q = quotePlan(pro, { seats: 8, interval: 'month', withVat: false, vatPct: 18 });
    expect(q).toMatchObject({ unit_month: 85, seats_billed: 8, month_total: 680, year_total: 8160, yearly_saving: 0 });
    expect(q.paid).toBe(true);
    expect(q.fits).toBe(true);
  });

  it('yearly: the yearly price over 12 months, and what it saves over monthly', () => {
    const q = quotePlan(pro, { seats: 8, interval: 'year', withVat: false, vatPct: 18 });
    expect(q.unit_month).toBe(69);
    expect(q.month_total).toBe(552);
    expect(q.yearly_saving).toBe((680 - 552) * 12);
  });

  it('VAT added on prices without it, taken out of prices that hold it', () => {
    expect(quotePlan(pro, { seats: 1, interval: 'month', withVat: true, vatPct: 18 }).month_total).toBeCloseTo(100.3);
    const incl = { ...pro, price_monthly: 118, vat_included: true };
    expect(quotePlan(incl, { seats: 1, interval: 'month', withVat: false, vatPct: 18 }).month_total).toBeCloseTo(100);
    expect(quotePlan(incl, { seats: 1, interval: 'month', withVat: true, vatPct: 18 }).month_total).toBeCloseTo(118);
  });

  it('a minimum of seats; a flat price is one unit whatever the people', () => {
    expect(
      quotePlan({ ...pro, min_seats: 3 }, { seats: 1, interval: 'month', withVat: false, vatPct: 0 }),
    ).toMatchObject({
      seats_billed: 3,
      month_total: 255,
    });
    const flat = { ...pro, pricing: 'flat' as const, price_monthly: 200 };
    expect(quotePlan(flat, { seats: 40, interval: 'month', withVat: false, vatPct: 0 })).toMatchObject({
      seats_billed: 1,
      month_total: 200,
    });
  });

  it('add-ons: per unit, capped at their maximum, only on paid plans they apply to', () => {
    const q = quotePlan(pro, {
      seats: 2,
      interval: 'month',
      withVat: false,
      vatPct: 0,
      addons: [storage, { ...storage, id: 'other', plan_ids: ['basic'] }],
      quantities: { st: 2, other: 5 },
    });
    expect(q.addons_month).toBe(58);
    expect(q.month_total).toBe(170 + 58);
    expect(
      quotePlan(pro, {
        seats: 1,
        interval: 'month',
        withVat: false,
        vatPct: 0,
        addons: [storage],
        quantities: { st: 99 },
      }).addons_month,
    ).toBe(29 * 20);
    const free = { ...pro, price_monthly: 0, price_yearly: 0 };
    const q2 = quotePlan(free, {
      seats: 1,
      interval: 'month',
      withVat: false,
      vatPct: 0,
      addons: [storage],
      quantities: { st: 1 },
    });
    expect(q2).toMatchObject({ paid: false, month_total: 0, addons_month: 0 });
  });

  it('fits: the plan’s seat limit', () => {
    const free = { ...pro, price_monthly: 0, price_yearly: 0, limits: { seats: 2 } };
    expect(quotePlan(free, { seats: 2, interval: 'month', withVat: false, vatPct: 0 }).fits).toBe(true);
    expect(quotePlan(free, { seats: 3, interval: 'month', withVat: false, vatPct: 0 }).fits).toBe(false);
  });

  it('a plan with no yearly price shows no yearly saving', () => {
    const monthlyOnly = { ...pro, price_yearly: 0 };
    expect(quotePlan(monthlyOnly, { seats: 1, interval: 'year', withVat: false, vatPct: 0 }).yearly_saving).toBe(0);
  });
});

describe('add-on extras in the limits', () => {
  it('adds to a set limit, never to an unlimited one; the override still wins', () => {
    const extras = addonExtras({
      a: { qty: 2, limit_kind: 'storage_gb', amount: 200, name: 'S' },
      b: { qty: 1, limit_kind: 'items', amount: 1000, name: 'I' },
    });
    expect(extras).toEqual({ storage_gb: 200, items: 1000 });
    const merged = mergeLimits({ storage_gb: 100, items: null }, null, {}, extras);
    expect(merged.storage_gb).toBe(300);
    expect(merged.items).toBeNull();
    expect(mergeLimits({ storage_gb: 100 }, null, { storage_gb: 5 }, extras).storage_gb).toBe(5);
  });
});
