// SPDX-License-Identifier: AGPL-3.0-only
import { useSyncExternalStore } from 'react';
import type { MyTour, TourStep } from '@bines/shared';

/**
 * Guided tours: which tour runs now and on which step — one at a time, for the whole page — plus
 * the hand-offs that cross a navigation or a browser tab:
 * - a tour waiting for its screen ("show me in the app" from a guide, a tour started from the list): this tab only;
 * - the owner console's on-screen picker and preview, opened in another tab of the app (same browser).
 * Nothing here is data: progress lives on the server, these are moments of one person's screen.
 */
export type RunnableStep = TourStep & { media?: string | null; media_type?: string | null };
export type RunnableTour = Pick<MyTour, 'id' | 'title' | 'route'> & {
  steps: RunnableStep[];
  guide_slug?: string | null;
};
export type Running = { tour: RunnableTour; step: number; preview: boolean };

let running: Running | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const startTour = (tour: RunnableTour, opts: { preview?: boolean } = {}) => {
  if (!tour.steps.length) return;
  running = { tour, step: 0, preview: !!opts.preview };
  emit();
};
export const stopTour = () => {
  running = null;
  emit();
};
export const goToStep = (step: number) => {
  if (!running) return;
  running = { ...running, step: Math.max(0, Math.min(step, running.tour.steps.length - 1)) };
  emit();
};
export const runningTour = () => running;
export const useRunningTour = () => useSyncExternalStore(subscribe, () => running);

// ---- a tour waiting for its screen (this tab)

const PENDING = 'bos.tour.pending';
const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const setPendingTour = (id: string | null) =>
  safe(() => (id ? sessionStorage.setItem(PENDING, id) : sessionStorage.removeItem(PENDING)), undefined);
export const pendingTour = () => safe(() => sessionStorage.getItem(PENDING), null);

// ---- the owner console's picker / preview (another tab of the app)

/** `pick`: the next click on a marked element points the step at it; `preview`: run a draft tour here. */
export type AuthorMode = { mode: 'pick' | 'preview'; tourId: string; stepId?: string; title?: string; at: number };
const AUTHOR = 'bos.tour.author';
/** The console tab listens for this key: a step got its element. */
export const PICKED_KEY = 'bos.tour.picked';
/** A request older than this is stale (a forgotten tab). */
const AUTHOR_TTL = 30 * 60_000;

export const setAuthorMode = (m: Omit<AuthorMode, 'at'> | null) =>
  safe(
    () =>
      m ? localStorage.setItem(AUTHOR, JSON.stringify({ ...m, at: Date.now() })) : localStorage.removeItem(AUTHOR),
    undefined,
  );

export const readAuthorMode = (): AuthorMode | null => {
  const raw = safe(() => localStorage.getItem(AUTHOR), null);
  if (!raw) return null;
  try {
    const m = JSON.parse(raw) as AuthorMode;
    if ((m.mode !== 'pick' && m.mode !== 'preview') || typeof m.tourId !== 'string') return null;
    return Date.now() - Number(m.at) < AUTHOR_TTL ? m : null;
  } catch {
    return null;
  }
};

const authorSubscribe = (l: () => void) => {
  const on = (e: StorageEvent) => {
    if (e.key === AUTHOR) l();
  };
  window.addEventListener('storage', on);
  listeners.add(l);
  return () => {
    window.removeEventListener('storage', on);
    listeners.delete(l);
  };
};
let authorCache: { raw: string | null; value: AuthorMode | null } = { raw: null, value: null };
const authorSnapshot = () => {
  const raw = safe(() => localStorage.getItem(AUTHOR), null);
  if (raw !== authorCache.raw) authorCache = { raw, value: readAuthorMode() };
  return authorCache.value;
};
/** The picker / preview request of the console, live (another tab may set it while this one is open). */
export const useAuthorMode = () => useSyncExternalStore(authorSubscribe, authorSnapshot);
export const clearAuthorMode = () => {
  setAuthorMode(null);
  emit();
};

/** The tour's element on the screen: the first visible one with its mark. */
export const findAnchor = (anchor: string | null | undefined): HTMLElement | null => {
  if (!anchor) return null;
  const all = document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(anchor)}"]`);
  for (const el of all) if (el.getClientRects().length) return el;
  return null;
};
