// SPDX-License-Identifier: AGPL-3.0-only
import type { IdocLinesSection, IdocSettings, IdocSummarySection } from './sections';

/**
 * The money of an interactive document, computed the same way on the server (what is written to columns, signed
 * and stored) and on the page (live while the client ticks). Pure: no I/O, no rounding until the end (agorot /
 * cents: two decimals).
 */

/** One row of a row section as the page holds it (amounts already read from the row's columns). */
export type IdocRowAmounts = {
  key: string;
  /** Chosen (fixed sections: always). */
  selected: boolean;
  /** Null when the section has no quantity column. */
  qty: number | null;
  price: number | null;
  unit_price: number | null;
  recurring_price: number | null;
  recurring_unit_price: number | null;
  /** Keys of rows this one needs chosen. */
  requires: string[];
};

export type IdocRowTotal = { one_time: number; recurring: number };

export type IdocSectionTotals = {
  section_id: string;
  totals: IdocLinesSection['totals'];
  one_time: number;
  recurring: number;
  chosen: number;
};

export type IdocTotals = {
  sections: IdocSectionTotals[];
  /** `main` sections, before discount and VAT (net when prices include VAT). */
  one_time: number;
  recurring: number;
  discount: number;
  /** one_time − discount. */
  subtotal: number;
  vat: number;
  /** subtotal + vat. */
  grand_total: number;
  recurring_vat: number;
  recurring_total: number;
  third_party_one_time: number;
  third_party_recurring: number;
  schedule: { label: string; percent: number; amount: number }[];
  vat_percent: number;
  currency: string;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : 0);

/** One row's amounts: fixed parts once, unit parts × quantity (no quantity column = 1 for recurring units). */
export const idocRowTotal = (row: IdocRowAmounts): IdocRowTotal => {
  const qty = row.qty ?? 1;
  return {
    one_time: num(row.price) + num(row.unit_price) * qty,
    recurring: num(row.recurring_price) + num(row.recurring_unit_price) * qty,
  };
};

/**
 * Applies the section's choice rules to the client's ticks: `fixed` = every row; `single` = at most one (the first
 * ticked); a row whose required rows are not all chosen is not chosen either (repeated until stable, so chains of
 * requirements fall together).
 */
export const effectiveSelection = (mode: IdocLinesSection['mode'], rows: IdocRowAmounts[]): Set<string> => {
  if (mode === 'fixed') return new Set(rows.map((r) => r.key));
  let chosen = rows.filter((r) => r.selected).map((r) => r.key);
  if (mode === 'single') chosen = chosen.slice(0, 1);
  const set = new Set(chosen);
  for (let changed = true; changed;) {
    changed = false;
    for (const r of rows)
      if (set.has(r.key) && r.requires.some((k) => !set.has(k))) {
        set.delete(r.key);
        changed = true;
      }
  }
  return set;
};

export const computeIdocTotals = (
  sections: { section: IdocLinesSection; rows: IdocRowAmounts[] }[],
  summary: IdocSummarySection | null,
  settings: Pick<IdocSettings, 'vat_percent' | 'prices_include_vat' | 'currency'>,
): IdocTotals => {
  const perSection: IdocSectionTotals[] = [];
  let oneTime = 0;
  let recurring = 0;
  let tpOne = 0;
  let tpRec = 0;
  for (const { section, rows } of sections) {
    if (section.hidden) continue;
    const chosen = effectiveSelection(section.mode, rows);
    let one = 0;
    let rec = 0;
    for (const r of rows) {
      if (!chosen.has(r.key)) continue;
      const t = idocRowTotal(r);
      one += t.one_time;
      rec += t.recurring;
    }
    perSection.push({
      section_id: section.id,
      totals: section.totals,
      one_time: round2(one),
      recurring: round2(rec),
      chosen: chosen.size,
    });
    if (section.totals === 'main') {
      oneTime += one;
      recurring += rec;
    } else if (section.totals === 'third_party') {
      tpOne += one;
      tpRec += rec;
    }
  }
  const d = summary && !summary.hidden ? summary.discount : null;
  const discount = d ? Math.min(oneTime, d.kind === 'percent' ? (oneTime * Math.min(d.value, 100)) / 100 : d.value) : 0;
  const rate = settings.vat_percent / 100;
  const afterDiscount = oneTime - discount;
  // Prices that include VAT: the VAT is the part of the amount; else it is added on top.
  const vatOf = (amount: number) => (settings.prices_include_vat ? amount - amount / (1 + rate) : amount * rate);
  const subtotal = settings.prices_include_vat ? afterDiscount - vatOf(afterDiscount) : afterDiscount;
  const vat = vatOf(afterDiscount);
  const grand = subtotal + vat;
  const recVat = vatOf(recurring);
  const recNet = settings.prices_include_vat ? recurring - recVat : recurring;
  const schedule: IdocTotals['schedule'] = [];
  const parts = summary && !summary.hidden ? summary.schedule : [];
  let given = 0;
  parts.forEach((p, i) => {
    const amount =
      i === parts.length - 1 && parts.reduce((s, x) => s + x.percent, 0) === 100
        ? round2(grand) - given
        : round2((grand * p.percent) / 100);
    given += amount;
    schedule.push({ label: p.label, percent: p.percent, amount: round2(amount) });
  });
  return {
    sections: perSection,
    one_time: round2(settings.prices_include_vat ? oneTime - vatOf(oneTime) : oneTime),
    recurring: round2(recNet),
    discount: round2(discount),
    subtotal: round2(subtotal),
    vat: round2(vat),
    grand_total: round2(grand),
    recurring_vat: round2(recVat),
    recurring_total: round2(recNet + recVat),
    third_party_one_time: round2(tpOne),
    third_party_recurring: round2(tpRec),
    schedule,
    vat_percent: settings.vat_percent,
    currency: settings.currency,
  };
};

/**
 * The summary settings that count for a document with several summary sections (a "summary" and a "payment
 * schedule", say): the first discount and the first non-empty schedule of the visible ones. Null = none visible.
 */
export const mergedIdocSummary = (sections: { kind: string; hidden?: boolean }[]): IdocSummarySection | null => {
  const all = sections.filter((s): s is IdocSummarySection => s.kind === 'summary' && !s.hidden);
  if (!all.length) return null;
  return {
    ...all[0]!,
    discount: all.find((s) => s.discount)?.discount ?? null,
    schedule: all.find((s) => s.schedule.length)?.schedule ?? [],
  };
};
