// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';
import {
  cleanEmailOpen,
  cleanIconStyle,
  cleanMotion,
  DEFAULT_EMAIL_OPEN,
  DEFAULT_ICON_STYLE,
  type Appearance,
  type AppearanceResponse,
  DENSITIES,
  DENSITY_SCALE,
  type Density,
  type EmailOpen,
  type IconStyle,
  type MotionPref,
  resolveMotion,
  scaledRowPx,
  TEXT_SCALE,
  TEXT_SIZES,
  type TextSize,
} from '@bines/shared';
import { api } from './api';
import { cardWidthAdopter } from './card-width';
import { setIconStyle } from './icon-style';

/**
 * Round 13 (product owner: "font size per user"): text size + table density. The user's choice lives in their profile
 * settings on the server (GET / PUT /me/appearance — the same on every device); this device keeps a copy so the
 * first paint is already right (applied in main.tsx), and may override it for itself ("only on this device").
 *
 * Applied as <html data-text-size data-density> + `--ui-scale` (styles.css): the root font size scales every rem
 * (text, spacing, controls, icons); the board table multiplies its row heights by `useAppearance().rowPx`.
 */
const KEY = 'bines:appearance';

export type DeviceAppearance = Appearance & {
  /** r16motion: animations — `system` follows the device's reduced-motion setting. */
  motion: MotionPref;
  /** the icon style in effect (mine, else the account's default). */
  icon_style: IconStyle;
  /** what a click on an email address does (mine, else the account's default). */
  email_open: EmailOpen;
  /** This device keeps its own value and ignores the account-wide one. */
  device: boolean;
};

const DEFAULT: DeviceAppearance = {
  text_size: 'normal',
  density: 'normal',
  motion: 'system',
  icon_style: DEFAULT_ICON_STYLE,
  email_open: DEFAULT_EMAIL_OPEN,
  device: false,
};

const read = (): DeviceAppearance => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<DeviceAppearance> | null;
    if (!raw) return DEFAULT;
    return {
      text_size: (TEXT_SIZES as readonly unknown[]).includes(raw.text_size) ? (raw.text_size as TextSize) : 'normal',
      density: (DENSITIES as readonly unknown[]).includes(raw.density) ? (raw.density as Density) : 'normal',
      motion: cleanMotion(raw.motion) ?? 'system',
      icon_style: cleanIconStyle(raw.icon_style) ?? DEFAULT_ICON_STYLE,
      email_open: cleanEmailOpen(raw.email_open) ?? DEFAULT_EMAIL_OPEN,
      device: raw.device === true,
    };
  } catch {
    return DEFAULT;
  }
};

const write = (v: DeviceAppearance) => {
  try {
    if (
      v.text_size === 'normal' &&
      v.density === 'normal' &&
      v.motion === 'system' &&
      v.icon_style === DEFAULT_ICON_STYLE &&
      v.email_open === DEFAULT_EMAIL_OPEN &&
      !v.device
    )
      localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(v));
  } catch {
    // Private mode / blocked storage: holds for this visit only.
  }
};

/** Puts the appearance on <html> (before the first render, and on every change). */
export const applyAppearance = (a: Appearance, root: HTMLElement = document.documentElement) => {
  if (a.text_size === 'normal') root.removeAttribute('data-text-size');
  else root.setAttribute('data-text-size', a.text_size);
  if (a.density === 'normal') root.removeAttribute('data-density');
  else root.setAttribute('data-density', a.density);
  root.style.setProperty('--ui-scale', String(TEXT_SCALE[a.text_size]));
  root.style.setProperty('--density-scale', String(DENSITY_SCALE[a.density]));
};

/**
 * r16motion: puts the animations in effect on <html data-motion="full|reduced|off"> — styles.css reads it, so no
 * component needs per-call logic. `system` follows prefers-reduced-motion, live (a change on the device applies).
 */
const reducedQuery = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;
let motionPref: MotionPref = 'system';
let watching = false;
export const applyMotion = (pref: MotionPref, root: HTMLElement = document.documentElement) => {
  motionPref = pref;
  const query = reducedQuery();
  root.setAttribute('data-motion', resolveMotion(pref, !!query?.matches));
  if (!watching && query) {
    watching = true;
    query.addEventListener?.('change', () => applyMotion(motionPref, root));
  }
};

export const storedAppearance = (): DeviceAppearance => (typeof window === 'undefined' ? DEFAULT : read());

const listeners = new Set<() => void>();
let current: DeviceAppearance = storedAppearance();
setIconStyle(current.icon_style);
const set = (next: DeviceAppearance) => {
  current = next;
  applyAppearance(next);
  applyMotion(next.motion);
  setIconStyle(next.icon_style);
  write(next);
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/** The server's answer (after sign-in, and after a save): adopted unless this device keeps its own. */
export const adoptServerAppearance = (
  r: Pick<AppearanceResponse, 'text_size' | 'density'> & {
    motion?: MotionPref;
    icon_style?: IconStyle;
    email_open?: EmailOpen;
  },
) => {
  if (current.device) return;
  const motion = r.motion ?? 'system';
  const icon_style = cleanIconStyle(r.icon_style) ?? DEFAULT_ICON_STYLE;
  const email_open = cleanEmailOpen(r.email_open) ?? DEFAULT_EMAIL_OPEN;
  if (
    r.text_size === current.text_size &&
    r.density === current.density &&
    motion === current.motion &&
    icon_style === current.icon_style &&
    email_open === current.email_open
  )
    return;
  set({ text_size: r.text_size, density: r.density, motion, icon_style, email_open, device: false });
};

/** GET /me/appearance once the user is known (the shell); quiet on failure (the device copy stays). */
export const syncAppearance = async (accountId?: string) => {
  try {
    const adoptCardWidth = cardWidthAdopter();
    const r = await api(accountId).get<AppearanceResponse>('/me/appearance');
    adoptServerAppearance(r);
    adoptCardWidth(r);
  } catch {
    // offline / older server: keep what this device has
  }
};

/**
 * The appearance in effect and how to change it. `choose` applies at once (live), saves for the user on the server
 * (unless this device keeps its own) — `device` switches the per-device override on / off.
 */
export const useAppearance = () => {
  const value = useSyncExternalStore(subscribe, () => current);
  const choose = async (patch: Partial<DeviceAppearance>, accountId?: string) => {
    if (patch.device === false && current.device) {
      // Back to the user's value from the server (this device's own one is dropped).
      set({ ...current, device: false });
      await syncAppearance(accountId);
      return;
    }
    const next = { ...current, ...patch };
    set(next);
    if (next.device) return;
    try {
      const r = await api(accountId).put<AppearanceResponse>('/me/appearance', {
        text_size: next.text_size,
        density: next.density,
        motion: next.motion,
        // Only when chosen here: an icon style that came from the account's default stays a default.
        ...(patch.icon_style ? { icon_style: patch.icon_style } : {}),
        ...(patch.email_open ? { email_open: patch.email_open } : {}),
      });
      adoptServerAppearance(r);
    } catch {
      // Saved on this device; the server copy follows next time.
    }
  };
  /** A row height (px at normal size) at this appearance — `dense` rows also follow the density. */
  const rowPx = (px: number, dense = true) => scaledRowPx(px, value, dense);
  return { value, choose, rowPx, scale: TEXT_SCALE[value.text_size] };
};
