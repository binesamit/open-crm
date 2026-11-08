// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';
import { DEFAULT_ICON_STYLE, type IconStyle } from '@bines/shared';

/**
 * the icon style in effect (the user's, else the account's default, else `duo`). `lib/appearance.ts` owns
 * the value (device copy + server); this small store only hands it to every `Icon` without importing the API client,
 * and mirrors it on <html data-icon-style> for CSS and tests.
 */
let current: IconStyle = DEFAULT_ICON_STYLE;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

export const setIconStyle = (style: IconStyle) => {
  if (typeof document !== 'undefined') document.documentElement.setAttribute('data-icon-style', style);
  if (style === current) return;
  current = style;
  listeners.forEach((l) => l());
};

export const useIconStyle = () =>
  useSyncExternalStore(
    subscribe,
    () => current,
    () => current,
  );
