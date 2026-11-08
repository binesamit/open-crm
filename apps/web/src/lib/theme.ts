// SPDX-License-Identifier: AGPL-3.0-only
import { useState, useSyncExternalStore } from 'react';
import { applyPalette, applyTheme, DEFAULT_PALETTE, paletteById, type Theme } from '@bines/ui';

/**
 * Light / dark / follow the system (11-UI-DESIGN §9, M7.5 stage 4): a per-device choice kept in localStorage,
 * applied to <html data-theme> before the first render (main.tsx).
 */
const KEY = 'bines:theme';

export const storedTheme = (): Theme => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
};

const themeListeners = new Set<() => void>();
let currentTheme: Theme = typeof window === 'undefined' ? 'system' : storedTheme();

/**
 * The current theme and a setter. One store for every place that shows the choice (the avatar menu's "מראה"
 * submenu, the profile page's appearance tab, the phone "אני" screen), so they always agree.
 */
export const useTheme = () => {
  const theme = useSyncExternalStore(
    (cb) => {
      themeListeners.add(cb);
      return () => themeListeners.delete(cb);
    },
    () => currentTheme,
  );
  const choose = (next: Theme) => {
    currentTheme = next;
    applyTheme(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      // Private mode / blocked storage: the choice holds for this visit only.
    }
    themeListeners.forEach((l) => l());
  };
  return [theme, choose] as const;
};

/** The sidebar's collapsed state (a rail of icons), remembered per device. */
const RAIL_KEY = 'bines:sidebar-collapsed';

export const useRail = () => {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = () =>
    setCollapsed((c) => {
      try {
        localStorage.setItem(RAIL_KEY, c ? '0' : '1');
      } catch {
        // Not remembered — still toggles.
      }
      return !c;
    });
  return [collapsed, toggle] as const;
};

/**
 * The sidebar's tone (fix4): the deep-green shell ("dark", the default) or a light one. Per device, like the theme;
 * AppShell puts it on its root as `data-sidebar`, and tokens.css maps the shell tokens to light values only while
 * the interface itself is light — in a dark interface the sidebar stays dark.
 */
export type SidebarTone = 'dark' | 'light';
const TONE_KEY = 'bines:sidebar-tone';
const toneListeners = new Set<() => void>();

const readTone = (): SidebarTone => {
  try {
    return localStorage.getItem(TONE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
};
let tone: SidebarTone = typeof window === 'undefined' ? 'dark' : readTone();

const subscribeTone = (cb: () => void) => {
  toneListeners.add(cb);
  return () => toneListeners.delete(cb);
};

/** The current tone and a setter; every user of the hook (the shell, the avatar menu, "אני") stays in sync. */
export const useSidebarTone = () => {
  const current = useSyncExternalStore(subscribeTone, () => tone);
  const choose = (next: SidebarTone) => {
    tone = next;
    try {
      if (next === 'dark') localStorage.removeItem(TONE_KEY);
      else localStorage.setItem(TONE_KEY, next);
    } catch {
      // Private mode / blocked storage: the choice holds for this visit only.
    }
    toneListeners.forEach((l) => l());
  };
  return [current, choose] as const;
};

/**
 * Round 12: the colour theme (palette, `packages/ui/src/palettes.ts`) — F4 by default, chosen in the profile's
 * appearance tab and the avatar menu's "מראה". Per device like light / dark; applied before the first render.
 */
const PALETTE_KEY = 'bines:palette';
const paletteListeners = new Set<() => void>();

export const storedPalette = (): string => {
  try {
    return paletteById(localStorage.getItem(PALETTE_KEY)).id;
  } catch {
    return DEFAULT_PALETTE;
  }
};
let palette = typeof window === 'undefined' ? DEFAULT_PALETTE : storedPalette();

/** The current palette and a setter; every place that shows it (profile, avatar menu) stays in sync. */
export const usePalette = () => {
  const current = useSyncExternalStore(
    (cb) => {
      paletteListeners.add(cb);
      return () => paletteListeners.delete(cb);
    },
    () => palette,
  );
  const choose = (next: string) => {
    palette = paletteById(next).id;
    applyPalette(palette);
    try {
      if (palette === DEFAULT_PALETTE) localStorage.removeItem(PALETTE_KEY);
      else localStorage.setItem(PALETTE_KEY, palette);
    } catch {
      // Private mode / blocked storage: the choice holds for this visit only.
    }
    paletteListeners.forEach((l) => l());
  };
  return [current, choose] as const;
};
