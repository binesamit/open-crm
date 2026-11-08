// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';
import {
  columnTypes,
  DEFAULT_LOCALE,
  dirOf,
  getLocale,
  hasMessage,
  isLocale,
  setLocale,
  subscribeLocale,
  t,
  type Locale,
} from '@bines/shared';

/*
 * The UI language (fix3). The signed-in user's `users.locale` decides (set from GET /auth/me and right after the
 * profile is saved); before sign-in, the language used last in this browser, else the browser's language.
 */
const STORAGE_KEY = 'bos:locale';

const browserLocale = (): Locale => {
  try {
    for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
      const base = tag?.slice(0, 2).toLowerCase();
      if (isLocale(base)) return base;
    }
  } catch {
    // no navigator (tests)
  }
  return DEFAULT_LOCALE;
};

/** The language to start with: the last one used here, else the browser's. */
export const initialLocale = (): Locale => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // storage blocked
  }
  return browserLocale();
};

/** Switches the whole UI: `t`, `<html lang dir>`, and the root re-renders (see `useLocale` in main.tsx). */
export const applyLocale = (value: string | null | undefined) => {
  const locale = isLocale(value) ? value : DEFAULT_LOCALE;
  const html = document.documentElement;
  html.lang = locale;
  html.dir = dirOf(locale);
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // storage blocked: the next visit starts from the browser's language
  }
  setLocale(locale);
};

/** The current UI language; components using it re-render when it changes. */
export const useLocale = (): Locale => useSyncExternalStore(subscribeLocale, getLocale, getLocale);

/** A column type's display name in the UI language (falls back to the type's Hebrew label). */
export const columnTypeLabel = (type: string): string => {
  const key = `columnType.${type}`;
  return hasMessage(key) ? t(key) : (columnTypes.get(type)?.labelHe ?? type);
};
