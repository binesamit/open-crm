// SPDX-License-Identifier: AGPL-3.0-only
import type { CostAllocation } from '@bines/shared';

/** Pure parts of the costs module: pricing with free allowances, the forecast, splitting, paths. */

export type PriceRule = {
  id: string;
  metric: string;
  service: string;
  price: number;
  currency: string;
  freePerMonth: number;
  effectiveFrom: string;
};

export type QuantityEntry = { key: string; day: string; metric: string; service: string; quantity: number };
export type Priced = { cost: number | null; currency: string | null };

/** The rule for a metric's service on a day: an exact service before `*`, then the latest that started by then. */
export const pickRule = (rules: PriceRule[], metric: string, service: string, day: string) => {
  let best: PriceRule | undefined;
  for (const r of rules) {
    if (r.metric !== metric || r.effectiveFrom > day || (r.service !== '*' && r.service !== service)) continue;
    if (
      !best ||
      (r.service !== '*' && best.service === '*') ||
      (r.service === best.service && r.effectiveFrom > best.effectiveFrom)
    )
      best = r;
  }
  return best;
};

/**
 * Cost of each quantity: its rule's price × what is left after the rule's monthly free units — the free units go to
 * the month's earliest days first (across every source and service the rule covers). No rule = unpriced (null).
 */
export const priceEntries = (entries: QuantityEntry[], rules: PriceRule[]): Map<string, Priced> => {
  const out = new Map<string, Priced>();
  const freeLeft = new Map<string, number>();
  const sorted = [...entries].sort((a, b) =>
    a.day === b.day ? a.service.localeCompare(b.service) || a.key.localeCompare(b.key) : a.day < b.day ? -1 : 1,
  );
  for (const e of sorted) {
    const rule = pickRule(rules, e.metric, e.service, e.day);
    if (!rule) {
      out.set(e.key, { cost: null, currency: null });
      continue;
    }
    const bucket = `${rule.id}|${e.day.slice(0, 7)}`;
    const free = freeLeft.get(bucket) ?? rule.freePerMonth;
    const used = Math.min(Math.max(e.quantity, 0), free);
    freeLeft.set(bucket, free - used);
    out.set(e.key, { cost: round6((e.quantity - used) * rule.price), currency: rule.currency });
  }
  return out;
};

export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
export const round2 = (n: number) => Math.round(n * 100) / 100;

export const daysInMonth = (day: string) => {
  const [y, m] = day.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const dayRange = (from: string, to: string) => {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 1000; d = addDays(d, 1)) out.push(d);
  return out;
};

/**
 * The month's forecast on `today`: what the days before today cost, plus the daily average of the (up to) 7 days
 * before today for today and every day left. `byDay` = day → cost.
 */
export const monthForecast = (byDay: Map<string, number>, today: string) => {
  const monthStart = `${today.slice(0, 7)}-01`;
  let before = 0;
  for (const [d, v] of byDay) if (d >= monthStart && d < today) before += v;
  const week = dayRange(addDays(today, -7), addDays(today, -1));
  const avg = week.reduce((s, d) => s + (byDay.get(d) ?? 0), 0) / week.length;
  const left = daysInMonth(today) - Number(today.slice(8, 10)) + 1;
  return round2(before + avg * left);
};

/**
 * Shared costs split between accounts: `usage` in proportion to each account's own costs (equally when none has
 * any), `equal`, or `seats` (active members).
 */
export const allocate = (
  shared: number,
  accounts: { id: string; direct: number; seats: number }[],
  method: CostAllocation,
): Map<string, number> => {
  const out = new Map<string, number>();
  if (!accounts.length) return out;
  const weight = (a: (typeof accounts)[number]) =>
    method === 'usage' ? Math.max(a.direct, 0) : method === 'seats' ? Math.max(a.seats, 0) : 1;
  let total = accounts.reduce((s, a) => s + weight(a), 0);
  const w = total > 0 ? weight : () => 1;
  if (total <= 0) total = accounts.length;
  for (const a of accounts) out.set(a.id, round2((shared * w(a)) / total));
  return out;
};

/** `data.total_usd`, `items[0].cost`, `result.0.amount` → the value at that path (undefined when absent). */
export const valueAtPath = (obj: unknown, path: string): unknown => {
  let cur: unknown = obj;
  for (const part of path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
};

/** A number from a JSON value: 12.5 / "12.5" / "$12.50" / "1,234.5". */
export const numberFrom = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string' || !/\d/.test(v)) return null;
  const n = Number(v.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};
