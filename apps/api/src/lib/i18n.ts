// SPDX-License-Identifier: AGPL-3.0-only
import { DEFAULT_LOCALE, isLocale, type Locale, type MessageKey, t } from '@bines/shared';
import type { Db } from '../db/client';
import { getAccountSettings } from '../modules/accounts/accounts.repo';

/**
 * Server-side texts (ANSWERS 6א.4): every name, header or sentence the server writes comes from the i18n catalog
 * in a given language — never a literal. Shared data (a new board's name, a copy's suffix) takes the account's
 * language; what one person downloads (a CSV) takes theirs.
 */
export const st = (key: string, vars?: Record<string, string | number>, locale: Locale = DEFAULT_LOCALE): string =>
  t(key as MessageKey, vars, locale);

/** A stored language tag ("he", "en", "en-US") as a catalog locale; anything else = the default. */
export const asLocale = (v: unknown): Locale => {
  if (isLocale(v)) return v;
  const base = typeof v === 'string' ? v.slice(0, 2).toLowerCase() : '';
  return isLocale(base) ? base : DEFAULT_LOCALE;
};

/** The account's language (Administration → General → language), for texts every member sees. */
export const accountLocale = async (db: Db, accountId: string): Promise<Locale> => {
  const settings = (await getAccountSettings(db, accountId)) as { locale?: { language?: unknown } };
  return asLocale(settings.locale?.language);
};
