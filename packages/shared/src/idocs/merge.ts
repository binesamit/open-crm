// SPDX-License-Identifier: AGPL-3.0-only
import type { IdocTotals } from './totals';

/**
 * Merge fields in section texts: `{item.name}`, `{col:key}`, `{col:relation.key}`, `{doc.date}`, `{doc.expires}`,
 * `{account.name}`, `{total.one_time|recurring|grand|vat|subtotal|discount}`. The server resolves everything except
 * `{total.*}` (the page fills those live from its own totals); an unknown field becomes empty text.
 */
export const IDOC_TOKEN = /\{([a-z_]+(?::[a-z0-9_\-.]{1,130}|\.[a-z_]{1,40}))\}/gi;

export const IDOC_TOTAL_TOKENS = ['one_time', 'recurring', 'grand', 'vat', 'subtotal', 'discount'] as const;

/** Every `{…}` field named in a text (for the builder's "missing column" hints). */
export const idocTokensOf = (text: string): string[] => [...text.matchAll(IDOC_TOKEN)].map((m) => m[1]!);

/**
 * Replaces fields through `lookup` (undefined = unknown → empty). `keepTotals` leaves `{total.*}` in place.
 */
export const mergeIdocText = (
  text: string,
  lookup: (token: string) => string | undefined,
  opts: { keepTotals?: boolean } = {},
): string =>
  text.replace(IDOC_TOKEN, (whole, token: string) => {
    if (opts.keepTotals && token.startsWith('total.')) return whole;
    return lookup(token) ?? '';
  });

export const formatIdocMoney = (amount: number, currency: string, locale: 'he' | 'en' = 'he') => {
  try {
    return new Intl.NumberFormat(locale === 'he' ? 'he-IL' : 'en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);
  } catch {
    return `${amount.toLocaleString(locale === 'he' ? 'he-IL' : 'en-US')} ${currency}`;
  }
};

/** `{total.*}` from live totals. */
export const idocTotalLookup =
  (t: IdocTotals, locale: 'he' | 'en' = 'he') =>
  (token: string): string | undefined => {
    const money = (n: number) => formatIdocMoney(n, t.currency, locale);
    switch (token) {
      case 'total.one_time':
        return money(t.one_time);
      case 'total.recurring':
        return money(t.recurring);
      case 'total.grand':
        return money(t.grand_total);
      case 'total.vat':
        return money(t.vat);
      case 'total.subtotal':
        return money(t.subtotal);
      case 'total.discount':
        return money(t.discount);
      default:
        return undefined;
    }
  };
