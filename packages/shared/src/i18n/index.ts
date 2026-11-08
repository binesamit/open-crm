// SPDX-License-Identifier: AGPL-3.0-only
import he from './he.json';
import en from './en.json';

export type MessageKey = keyof typeof he;
export type Locale = 'he' | 'en';

// en.json must have exactly the keys of he.json (checked by test/i18n.test.ts).
const catalogs: Record<Locale, Record<MessageKey, string>> = { he, en: en as Record<MessageKey, string> };

export const DEFAULT_LOCALE: Locale = 'he';
export const LOCALES: readonly Locale[] = ['he', 'en'];
/** Each language's name in itself (endonym) — the one place it is written (audit 2026-10-10 ux #21). */
export const LANGUAGE_NAMES: Readonly<Record<Locale, string>> = { he: 'עברית', en: 'English' };
export const isLocale = (v: unknown): v is Locale => v === 'he' || v === 'en';

/*
 * The runtime locale (fix3): the web app sets it from the signed-in user (users.locale) and re-renders on change;
 * `t` without an explicit locale uses it. The server never sets it, so server code keeps passing a locale (or gets
 * the default).
 */
let current: Locale = DEFAULT_LOCALE;
const listeners = new Set<() => void>();

export const getLocale = (): Locale => current;
export const setLocale = (locale: Locale) => {
  if (locale === current) return;
  current = locale;
  for (const fn of listeners) fn();
};
/** For `useSyncExternalStore(subscribeLocale, getLocale)`. */
export const subscribeLocale = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Whether a key exists (for keys built at runtime, e.g. `columnType.${type}`). */
export const hasMessage = (key: string): key is MessageKey => Object.prototype.hasOwnProperty.call(he, key);

/** `t('invite.title', { account: 'Acme' })` — `{name}` placeholders are replaced from `vars`. */
export const t = (key: MessageKey, vars?: Record<string, string | number>, locale: Locale = current): string => {
  const template = catalogs[locale]?.[key] ?? he[key] ?? String(key);
  return vars ? template.replace(/\{(\w+)\}/g, (m, name: string) => String(vars[name] ?? m)) : template;
};

/*
 * Keys in code (dedup-1): write them as literals — `t('owner.license.title')`, or `msgKey('…')` where a key is kept
 * for later — so a missing key fails the typecheck. Never wrap `t` in a local `(key: string) => t(key as MessageKey)`:
 * that hides every missing key. A key built at runtime goes through `tDynamic` / `dynamicKey` (one place, greppable);
 * the web's keys test (apps/web/src/i18n-keys.test.ts) checks every literal key and the static prefix of every
 * built one against he.json and en.json.
 */

/** A message key kept for later (`{ label: msgKey('nav.home') }`): typed — a missing key fails the typecheck. */
export const msgKey = <K extends MessageKey>(key: K): K => key;

/** A key built at runtime (`columnType.${type}`). Unchecked by the compiler; a missing one renders as the key. */
export const dynamicKey = (key: string): MessageKey => key as MessageKey;

/** `t` for a key built at runtime (see `dynamicKey`). */
export const tDynamic = (key: string, vars?: Record<string, string | number>, locale?: Locale): string =>
  t(dynamicKey(key), vars, locale);

export const dirOf = (locale: Locale): 'rtl' | 'ltr' => (locale === 'he' ? 'rtl' : 'ltr');

const RTL_SCRIPT = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}]/u;
const LETTER = /\p{L}/u;

/** The direction of a text by its first strong letter (as `dir="auto"` does); null when it has none. */
export const firstStrongDir = (text: string): 'rtl' | 'ltr' | null => {
  for (const ch of text) {
    if (!LETTER.test(ch)) continue;
    return RTL_SCRIPT.test(ch) ? 'rtl' : 'ltr';
  }
  return null;
};

/** The BCP 47 tag for Intl formatting of a locale ("he-IL" / "en-US"). */
export const intlLocale = (locale: Locale = current): string => (locale === 'he' ? 'he-IL' : 'en-US');

export { he, en };
