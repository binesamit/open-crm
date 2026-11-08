// SPDX-License-Identifier: AGPL-3.0-only
import { create } from 'zustand';
import { PWA_BREAKING_EPOCH, type PwaStatus } from '@bines/shared';
import { buildState, isTyping, onControllerChange } from './pwa-logic';
import { safeRedirect } from '../lib/safe-redirect';

/** This bundle's build id (vite-pwa.ts → `define`); 'dev' from the dev server and in unit tests. */
declare const __APP_BUILD__: string | undefined;
export const APP_BUILD = typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'dev';

/**
 * The service worker from the page's side (PWA פ2): registers /sw.js (production builds; in development only when
 * localStorage `bines.pwa.dev` = '1'), watches for a new version, applies it when asked, and obeys the kill switch.
 */
type PwaState = {
  /** A new version is installed and waits for "refresh". */
  waiting: ServiceWorker | null;
  /** A new version already took over (another tab refreshed) while someone was typing here. */
  activated: boolean;
  /** The server runs a newer build than this page (GET /public/pwa/status): "a new version — refresh". */
  stale: boolean;
  /** …and it is marked breaking for this page (PWA_BREAKING_EPOCH): only "refresh" is left. */
  mustRefresh: boolean;
  /** The bar was closed for now. */
  dismissed: boolean;
  registration: ServiceWorkerRegistration | null;
  /** Android / desktop Chrome offered to install (kept for our own button, פ3). */
  installEvent: InstallPromptEvent | null;
};

/** Chromium's `beforeinstallprompt` event (not in the DOM typings). */
export type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
export const usePwaStore = create<PwaState>(() => ({
  waiting: null,
  activated: false,
  stale: false,
  mustRefresh: false,
  dismissed: false,
  registration: null,
  installEvent: null,
}));

/** Keeps the browser's install offer for our own gentle bar instead of the browser's mini-infobar. */
let capturing = false;
export const captureInstallPrompt = () => {
  if (capturing) return;
  capturing = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    usePwaStore.setState({ installEvent: e as InstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => usePwaStore.setState({ installEvent: null }));
};

const STATUS_URL = '/api/v1/public/pwa/status';
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const DEV_FLAG = 'bines.pwa.dev';

const devEnabled = () => {
  try {
    return localStorage.getItem(DEV_FLAG) === '1';
  } catch {
    return false;
  }
};

export const swSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator;

/** The owner turned the worker off: remove it and its caches (the next load comes from the network). */
const obeyKillSwitch = async () => {
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return false;
    const status = (await res.json()) as PwaStatus;
    if (status.sw_enabled) return false;
    for (const reg of await navigator.serviceWorker.getRegistrations()) await reg.unregister();
    if ('caches' in window) for (const key of await caches.keys()) await caches.delete(key);
    return true;
  } catch {
    return false;
  }
};

let requestedHere = false;
let navigateTo: ((url: string) => void) | null = null;
let notificationsRead: ((accountId: string) => void) | null = null;

/** In-app navigation for a push click on an open window (the worker posts `{type: 'navigate', url}`). */
export const onPushNavigate = (fn: (url: string) => void) => {
  navigateTo = fn;
};

/** A push was clicked and marked read by the worker: the open page refreshes that account's bell. */
export const onNotificationsRead = (fn: (accountId: string) => void) => {
  notificationsRead = fn;
};

/** "Refresh" on the bar (or the must-refresh screen): the waiting worker takes over, then this tab reloads. */
export const applyUpdate = () => {
  const { waiting } = usePwaStore.getState();
  requestedHere = true;
  if (waiting) waiting.postMessage({ type: 'SKIP_WAITING' });
  else window.location.reload();
};

/** Compares the server's build with this page's (never reloads by itself — the bar / screen asks). */
export const checkBuild = async () => {
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return;
    const status = (await res.json()) as PwaStatus;
    const state = buildState({
      appBuild: APP_BUILD,
      appEpoch: PWA_BREAKING_EPOCH,
      serverBuild: status.build,
      serverEpoch: status.breaking_epoch ?? 0,
    });
    if (state === 'current') return;
    const before = usePwaStore.getState();
    usePwaStore.setState({
      stale: true,
      mustRefresh: state === 'must_refresh',
      // Closed for now stays closed until the page reloads.
      dismissed: before.stale ? before.dismissed : false,
    });
  } catch {
    // Offline: next time.
  }
};

const BUILD_CHECK_MS = 10 * 60 * 1000;
const BUILD_RECHECK_MIN_MS = 60 * 1000;
let watching = false;

/**
 * "Must refresh to continue" (PWA): the server's build is compared on start, when the page becomes visible again
 * (at most once a minute) and every 10 minutes — with or without a service worker.
 */
export const startBuildWatch = () => {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  let last = Date.now();
  void checkBuild();
  setInterval(() => {
    last = Date.now();
    void checkBuild();
  }, BUILD_CHECK_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || Date.now() - last < BUILD_RECHECK_MIN_MS) return;
    last = Date.now();
    void checkBuild();
  });
};

const track = (reg: ServiceWorkerRegistration) => {
  const set = usePwaStore.setState;
  set({ registration: reg });
  // Only an update counts (a first install has no controller yet).
  const watch = (worker: ServiceWorker | null) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller)
        set({ waiting: worker, dismissed: false });
    });
  };
  if (reg.waiting && navigator.serviceWorker.controller) set({ waiting: reg.waiting });
  watch(reg.installing);
  reg.addEventListener('updatefound', () => watch(reg.installing));
};

let started = false;

export const startServiceWorker = async () => {
  if (started || !swSupported()) return;
  if (!import.meta.env.PROD && !devEnabled()) return;
  started = true;
  if (await obeyKillSwitch()) return;
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // The first install claiming the page is not a new version.
    if (!hadController && !requestedHere && !usePwaStore.getState().waiting) return;
    const next = onControllerChange({
      requestedHere,
      typing: isTyping(document),
      hidden: document.visibilityState === 'hidden',
    });
    if (next === 'reload') window.location.reload();
    else usePwaStore.setState({ waiting: null, activated: true, dismissed: false });
  });
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: string; url?: string; account_id?: string } | null;
    // Same-origin paths only (lib/safe-redirect) (`//host` is not one): the sender is our own worker, this is defence in depth.
    if (data?.type === 'navigate' && typeof data.url === 'string' && safeRedirect(data.url) === data.url) {
      if (navigateTo) navigateTo(data.url);
      else window.location.assign(data.url);
    }
    if (data?.type === 'notifications-read' && data.account_id) notificationsRead?.(data.account_id);
  });
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    track(reg);
    const check = () => void reg.update().catch(() => undefined);
    setInterval(check, UPDATE_CHECK_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') check();
    });
  } catch {
    // No worker (private mode, blocked): the app works as a plain site.
  }
};

/** The registration once the worker is ready (push needs it); null when there is none. */
export const readyRegistration = async (): Promise<ServiceWorkerRegistration | null> => {
  if (!swSupported()) return null;
  const known = usePwaStore.getState().registration ?? (await navigator.serviceWorker.getRegistration('/')) ?? null;
  if (!known) return null;
  return navigator.serviceWorker.ready;
};
