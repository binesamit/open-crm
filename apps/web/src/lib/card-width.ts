// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState, useSyncExternalStore } from 'react';
import { type AppearanceResponse, type CardWidthLimits, cleanCardWidth, resolveCardWidth } from '@bines/shared';
import { api } from './api';

/**
 * F9 cardw: the user's own item card width (px, dragged on the card's edge). The user's value lives on the server
 * (`card_width` of GET / PUT /me/appearance — every device); this device keeps a copy so the card opens at the right
 * width before the server answers. null = the account's default (`defaults.card_width_pct`).
 */
const KEY = 'bines:card-width';

const read = (): number | null => {
  try {
    return cleanCardWidth(JSON.parse(localStorage.getItem(KEY) ?? 'null')) ?? null;
  } catch {
    return null;
  }
};
const write = (px: number | null) => {
  try {
    if (px === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(px));
  } catch {
    // Private mode / blocked storage: the server copy is the source anyway.
  }
};

const listeners = new Set<() => void>();
let current: number | null = typeof window === 'undefined' ? null : read();
const set = (px: number | null) => {
  if (px === current) return;
  current = px;
  write(px);
  listeners.forEach((l) => l());
};
const subscribe = (cb: () => void) => {
  listeners.add(cb);
  return () => listeners.delete(cb);
};

/**
 * Saves made here, counted: a server answer is adopted only when no save was made since its request went out — an
 * older answer (the GET after sign-in, or an earlier save) landing late must not bring back a width already replaced.
 */
let saves = 0;
/** The saves go out one at a time, in order: two requests in flight could reach the server in either order. */
let queue: Promise<unknown> = Promise.resolve();
/** A save waiting for the keys to stop (`saveCardWidthSoon`); any newer save cancels it. */
let soon: ReturnType<typeof setTimeout> | undefined;

/** The server's answer (GET /me/appearance after sign-in, or a save). */
export const adoptServerCardWidth = (r: Pick<AppearanceResponse, 'card_width'> | null | undefined) => {
  if (!r || r.card_width === undefined) return;
  set(cleanCardWidth(r.card_width) ?? null);
};

/** Before a GET of /me/appearance: the adopter for its answer — a no-op if I saved a width meanwhile. */
export const cardWidthAdopter = () => {
  const at = saves;
  return (r: Pick<AppearanceResponse, 'card_width'> | null | undefined) => {
    if (at === saves) adoptServerCardWidth(r);
  };
};

/** Saves my width (null = back to the default): at once here, then on the server (quiet on failure). */
export const saveCardWidth = (px: number | null, accountId?: string) => {
  clearTimeout(soon);
  const at = ++saves;
  set(px);
  const put = queue.then(async () => {
    // A newer save is queued behind this one: it alone needs to reach the server.
    if (at !== saves) return;
    try {
      const r = await api(accountId).put<AppearanceResponse>('/me/appearance', { card_width: px });
      if (at === saves) adoptServerCardWidth(r);
    } catch {
      // Kept on this device; the next save tries again.
    }
  });
  queue = put;
  return put;
};

/** Saves my width once the calls stop for `ms` (a held arrow key is many steps). */
export const saveCardWidthSoon = (px: number, accountId: string | undefined, ms: number) => {
  clearTimeout(soon);
  soon = setTimeout(() => void saveCardWidth(px, accountId), ms);
};

export const useMyCardWidth = () => useSyncExternalStore(subscribe, () => current);

/** The window's width, live. */
export const useViewportWidth = () => {
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    let frame = 0;
    const onResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setVw(window.innerWidth));
    };
    window.addEventListener('resize', onResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
    };
  }, []);
  return vw;
};

/** The card width in effect (px): mine, else the account's default — clamped to this window. */
export const useCardWidth = (limits: CardWidthLimits | undefined) => {
  const mine = useMyCardWidth();
  const viewport = useViewportWidth();
  return { width: resolveCardWidth(mine, viewport, limits), mine, viewport };
};
