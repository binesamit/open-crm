// SPDX-License-Identifier: AGPL-3.0-only
/** Bidi marks and spaces Intl puts around a currency / unit. */
const NOISE = /[\s\u00a0\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * r27: the numbers widget's own prefix / suffix next to the value the server formatted with the column's unit
 * ("₪1,200", "1,200 ₪", "45%"). An affix that is already in that text (the same unit, on either side) shows once —
 * not "₪₪1,200". A plain number keeps both affixes as set.
 */
export const numbersAffixes = (serverText: string, prefix?: string, suffix?: string) => {
  const text = serverText.replace(NOISE, '');
  const keep = (affix?: string) => {
    const a = affix?.replace(NOISE, '');
    // Only a unit (some non-digit sign) can repeat the column's; digits are part of the number.
    if (!a || /^[\d.,-]+$/.test(a)) return affix ?? '';
    return /\d/.test(text) && text.includes(a) && !/^-?\d+(\.\d+)?$/.test(text) ? '' : affix!;
  };
  return { prefix: keep(prefix), suffix: keep(suffix) };
};
