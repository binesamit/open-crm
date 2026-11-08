// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';

/**
 * Live presence in docs: what this person chose on this device — see where the others stand (their block
 * lit in their colour), and let the others see where I stand. Both on by default; kept in the browser only.
 */
export type PresencePrefs = { showOthers: boolean; shareMine: boolean };

const KEY = 'bines:doc-presence';
const DEFAULTS: PresencePrefs = { showOthers: true, shareMine: true };

const read = (): PresencePrefs => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PresencePrefs> | null;
    return {
      showOthers: typeof raw?.showOthers === 'boolean' ? raw.showOthers : DEFAULTS.showOthers,
      shareMine: typeof raw?.shareMine === 'boolean' ? raw.shareMine : DEFAULTS.shareMine,
    };
  } catch {
    return DEFAULTS;
  }
};

let current: PresencePrefs = typeof window === 'undefined' ? DEFAULTS : read();
const listeners = new Set<() => void>();

export const presencePrefs = () => current;

export const setPresencePrefs = (patch: Partial<PresencePrefs>) => {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private mode / blocked storage: the choice holds until the page reloads.
  }
  listeners.forEach((l) => l());
};

export const subscribePresencePrefs = (cb: () => void) => {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
};

export const usePresencePrefs = () => useSyncExternalStore(subscribePresencePrefs, presencePrefs, () => DEFAULTS);
