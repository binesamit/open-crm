// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';

/** The browser's online flag, live (the `online` / `offline` events). Server render / no navigator = online. */
const subscribe = (onChange: () => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};
const read = () => (typeof navigator === 'undefined' ? true : navigator.onLine);

export const useOnline = () => useSyncExternalStore(subscribe, read, () => true);
