// SPDX-License-Identifier: AGPL-3.0-only
/* The phone app's service worker (PWA פ2/פ4, the planning notes "PWA"). vite-pwa.ts fills in the build id, the files to
 * keep, `swRoute` and `swMarkRead` (src/pwa/precache.ts) and writes it to dist/sw.js; the API serves it (or the kill switch).
 * It keeps ONLY the app's own files. API answers, files and anything else always go to the network untouched. */
const BUILD = '__BUILD__';
const PRECACHE = __PRECACHE__;
const SHELL_CACHE = `bines-shell-${BUILD}`;
const ASSET_CACHE = 'bines-assets';
const STATUS_URL = '/api/v1/public/pwa/status';
const KILL_CHECK_MS = 10 * 60 * 1000;

const swRoute = __SW_ROUTE__;
const swMarkRead = __SW_MARK_READ__;

let lastKillCheck = 0;

/** The owner's kill switch: the worker removes itself (caches too) and the pages reload from the network. */
const checkKillSwitch = async () => {
  if (Date.now() - lastKillCheck < KILL_CHECK_MS) return;
  lastKillCheck = Date.now();
  try {
    const res = await fetch(STATUS_URL, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return;
    const status = await res.json();
    if (status && status.sw_enabled === false) {
      for (const key of await caches.keys()) await caches.delete(key);
      await self.registration.unregister();
      for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
    }
  } catch {
    // Offline: try again next time.
  }
};

self.addEventListener('install', (event) => {
  // No skipWaiting here: the page shows "a new version — refresh" and asks when the person is ready.
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(['/', ...PRECACHE])));
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith('bines-shell-') && key !== SHELL_CACHE) await caches.delete(key);
      await self.clients.claim();
      lastKillCheck = 0;
      await checkKillSwitch();
    })(),
  );
});

/** A page: always the network first (fresh shell after a deploy); offline, the shell kept at install. */
const shell = async (request) => {
  try {
    const response = await fetch(request);
    if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put('/', response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match('/', { cacheName: SHELL_CACHE });
    if (cached) return cached;
    throw new Error('offline');
  }
};

/** A hashed asset: never changes, so the kept copy wins; a new one is kept on first use. */
const asset = async (request) => {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(ASSET_CACHE);
    await cache.put(request, response.clone());
  }
  return response;
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  const route = swRoute(url.pathname, request.method, request.mode);
  if (route === 'network') return;
  if (route === 'shell') {
    event.waitUntil(checkKillSwitch());
    event.respondWith(shell(request));
    return;
  }
  event.respondWith(asset(request));
});

/** A push (פ4): show it; the badge follows the bell's unread count. */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: '', body: event.data ? event.data.text() : '' };
  }
  const tasks = [
    self.registration.showNotification(data.title || '', {
      body: data.body || '',
      tag: data.tag,
      // `tag` = the notification's id: a click marks exactly that one read (with its account).
      data: { url: data.url || '/', id: data.tag, account_id: data.account_id, badge: typeof data.badge === 'number' },
      icon: data.icon,
      dir: 'auto',
    }),
  ];
  if (typeof data.badge === 'number' && 'setAppBadge' in self.navigator)
    tasks.push(data.badge > 0 ? self.navigator.setAppBadge(data.badge) : self.navigator.clearAppBadge());
  event.waitUntil(Promise.all(tasks).catch(() => undefined));
});

/**
 * A click marks the notification read (the bell's endpoint, with the session cookie; signed out = nothing happens),
 * moves the icon's number and tells open windows to refresh the bell.
 */
const markRead = async (data) => {
  const request = swMarkRead(data);
  if (!request) return;
  try {
    const res = await fetch(request.url, request.init);
    if (!res.ok) return;
    const out = await res.json();
    if (data.badge && typeof out.unread_count === 'number' && 'setAppBadge' in self.navigator)
      await (out.unread_count > 0 ? self.navigator.setAppBadge(out.unread_count) : self.navigator.clearAppBadge());
    for (const client of await self.clients.matchAll({ type: 'window' }))
      client.postMessage({ type: 'notifications-read', account_id: data.account_id });
  } catch {
    // Offline or signed out: the bell still shows it unread.
  }
};

/** A click opens exactly the item / update, in an open window of the app when there is one. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  const open = async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((w) => new URL(w.url).origin === self.location.origin);
    if (existing) {
      // The page moves inside the app (no reload); see src/pwa/register.ts.
      existing.postMessage({ type: 'navigate', url: target.pathname + target.search + target.hash });
      await existing.focus();
      return;
    }
    await self.clients.openWindow(target.href);
  };
  event.waitUntil(Promise.all([markRead(data), open()]));
});
