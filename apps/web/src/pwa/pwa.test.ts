// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { renderServiceWorker, webBuildId } from '../../vite-pwa';
import { type BundleEntry, buildId, isPrecacheable, precacheList, swMarkRead, swRoute } from './precache';
import {
  badgeValue,
  buildState,
  deviceKind,
  INSTALL_SNOOZE_MS,
  installPrompt,
  isTyping,
  onControllerChange,
  shouldAskPush,
  showUpdateBanner,
  urlBase64ToBytes,
} from './pwa-logic';

const chunk = (fileName: string, isEntry = false, imports: string[] = [], css: string[] = []): BundleEntry => ({
  type: 'chunk',
  fileName,
  isEntry,
  imports,
  viteMetadata: { importedCss: new Set(css) },
});
const asset = (fileName: string): BundleEntry => ({ type: 'asset', fileName });

describe('what the service worker keeps (פ2)', () => {
  it('precaches the entry, its static imports, stylesheets and fonts — never /api, source maps or lazy pages', () => {
    const bundle: Record<string, BundleEntry> = {
      'assets/index-a1.js': chunk('assets/index-a1.js', true, ['assets/vendor-b2.js'], ['assets/index-c3.css']),
      'assets/vendor-b2.js': chunk('assets/vendor-b2.js'),
      'assets/board-lazy-d4.js': chunk('assets/board-lazy-d4.js'),
      'assets/index-c3.css': asset('assets/index-c3.css'),
      'assets/heebo-e5.woff2': asset('assets/heebo-e5.woff2'),
      'assets/index-a1.js.map': asset('assets/index-a1.js.map'),
      'api/v1/boards': asset('api/v1/boards'),
      'sw.js': asset('sw.js'),
      'index.html': asset('index.html'),
    };
    const list = precacheList(bundle);
    expect(list).toEqual([
      '/assets/heebo-e5.woff2',
      '/assets/index-a1.js',
      '/assets/index-c3.css',
      '/assets/vendor-b2.js',
    ]);
    expect(list.some((f) => f.startsWith('/api'))).toBe(false);
    expect(list.some((f) => f.endsWith('.map'))).toBe(false);
  });

  it('never answers an API, MCP or OAuth request, nor any write', () => {
    for (const path of [
      '/api/v1/boards',
      '/api/auth/session',
      '/api',
      '/mcp',
      '/oauth/token',
      '/.well-known/x',
      '/sw.js',
    ])
      expect(swRoute(path, 'GET', 'navigate')).toBe('network');
    expect(swRoute('/a/acme/b/1', 'POST', 'navigate')).toBe('network');
    expect(swRoute('/assets/index-a1.js', 'PUT', 'cors')).toBe('network');
    expect(swRoute('/a/acme/my-work', 'GET', 'navigate')).toBe('shell');
    expect(swRoute('/assets/index-a1.js', 'GET', 'cors')).toBe('asset');
    expect(swRoute('/assets/index-a1.js.map', 'GET', 'cors')).toBe('network');
    // Anything else of ours (an avatar redirect, a public file) goes to the network untouched.
    expect(swRoute('/f/token', 'GET', 'cors')).toBe('network');
    expect(isPrecacheable('api/v1/x.js')).toBe(false);
    expect(isPrecacheable('assets/x.js')).toBe(true);
  });

  it('a different build gives a different worker', () => {
    expect(buildId(['/assets/a.js'])).toBe(buildId(['/assets/a.js']));
    expect(buildId(['/assets/a.js'])).not.toBe(buildId(['/assets/b.js']));
  });

  it('swRoute survives being copied into sw.js as source', () => {
    const copy = new Function(`return (${swRoute.toString()})`)() as typeof swRoute;
    expect(copy('/api/v1/me', 'GET', 'navigate')).toBe('network');
    expect(copy('/a/x', 'GET', 'navigate')).toBe('shell');
  });
});

describe('the "new version" bar (פ2)', () => {
  const doc = (active: Partial<HTMLElement> | null, dialog = false) =>
    ({
      activeElement: active as Element | null,
      querySelector: () => (dialog ? ({} as Element) : null),
    }) as unknown as Document;

  it('knows when someone is typing or has a dialog open', () => {
    expect(isTyping(doc({ tagName: 'INPUT', isContentEditable: false }))).toBe(true);
    expect(isTyping(doc({ tagName: 'TEXTAREA', isContentEditable: false }))).toBe(true);
    expect(isTyping(doc({ tagName: 'DIV', isContentEditable: true }))).toBe(true);
    expect(isTyping(doc({ tagName: 'BUTTON', isContentEditable: false }))).toBe(false);
    expect(isTyping(doc({ tagName: 'BODY', isContentEditable: false }, true))).toBe(true);
  });

  it('never reloads under someone typing; reloads when asked here or when nobody is looking', () => {
    expect(onControllerChange({ requestedHere: true, typing: true, hidden: false })).toBe('reload');
    expect(onControllerChange({ requestedHere: false, typing: true, hidden: true })).toBe('banner');
    expect(onControllerChange({ requestedHere: false, typing: false, hidden: false })).toBe('banner');
    expect(onControllerChange({ requestedHere: false, typing: false, hidden: true })).toBe('reload');
  });

  it('shows the bar while an update waits, until closed', () => {
    expect(showUpdateBanner({ waiting: true, activated: false, dismissed: false })).toBe(true);
    expect(showUpdateBanner({ waiting: false, activated: true, dismissed: false })).toBe(true);
    expect(showUpdateBanner({ waiting: true, activated: false, dismissed: true })).toBe(false);
    expect(showUpdateBanner({ waiting: false, activated: false, dismissed: false })).toBe(false);
  });
});

describe('install suggestion and push question (פ3/פ4)', () => {
  const base = {
    enabled: true,
    after: 3,
    visits: 3,
    snoozedUntil: null,
    now: 1_000,
    standalone: false,
    device: 'ios' as const,
    canPrompt: false,
  };
  it('appears from the 3rd phone visit, not installed, not snoozed', () => {
    expect(installPrompt(base)).toBe('ios');
    expect(installPrompt({ ...base, visits: 2 })).toBe('hidden');
    expect(installPrompt({ ...base, standalone: true })).toBe('hidden');
    expect(installPrompt({ ...base, enabled: false })).toBe('hidden');
    expect(installPrompt({ ...base, device: 'other' })).toBe('hidden');
    expect(installPrompt({ ...base, snoozedUntil: 1_000 + INSTALL_SNOOZE_MS })).toBe('hidden');
    expect(installPrompt({ ...base, snoozedUntil: 500 })).toBe('ios');
    expect(installPrompt({ ...base, device: 'android' })).toBe('hidden');
    expect(installPrompt({ ...base, device: 'android', canPrompt: true })).toBe('android');
    expect(INSTALL_SNOOZE_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('tells the device apart', () => {
    expect(deviceKind('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('ios');
    expect(deviceKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe('ios');
    expect(deviceKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe('other');
    expect(deviceKind('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile')).toBe('android');
    expect(deviceKind('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('other');
  });

  it('asks about push once, from the installed app, before the browser does', () => {
    const p = {
      pushEnabled: true,
      supported: true,
      permission: 'default' as const,
      subscribed: false,
      asked: false,
      standalone: true,
      device: 'android' as const,
    };
    expect(shouldAskPush(p)).toBe(true);
    expect(shouldAskPush({ ...p, standalone: false })).toBe(false);
    expect(shouldAskPush({ ...p, asked: true })).toBe(false);
    expect(shouldAskPush({ ...p, permission: 'denied' })).toBe(false);
    expect(shouldAskPush({ ...p, subscribed: true })).toBe(false);
    expect(shouldAskPush({ ...p, pushEnabled: false })).toBe(false);
  });

  it('decodes the VAPID key and computes the badge', () => {
    expect([...urlBase64ToBytes('AQID_w')]).toEqual([1, 2, 3, 255]);
    expect(badgeValue(4, true)).toBe(4);
    expect(badgeValue(4, false)).toBe(0);
    expect(badgeValue(0, true)).toBe(0);
  });
});

describe('a clicked push is marked read (s4f)', () => {
  const ID = '01JABCDEFGHJKMNPQRSTVWXYZ0';
  const ACCOUNT = '01JACCOUNT0000000000000000';

  it('builds the bell request: same-origin cookie, the account header, never cached', () => {
    const req = swMarkRead({ id: ID, account_id: ACCOUNT, url: '/a/x' });
    expect(req).toEqual({
      url: '/api/v1/me/notifications/read',
      init: {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json', 'x-account-id': ACCOUNT },
        body: JSON.stringify({ ids: [ID] }),
      },
    });
    // An older payload (no ids) or something odd: no request, the click still opens the item.
    expect(swMarkRead({ url: '/a/x' })).toBeNull();
    expect(swMarkRead(null)).toBeNull();
    expect(swMarkRead({ id: ID, account_id: 'a b' })).toBeNull();
    expect(swMarkRead({ id: 7, account_id: ACCOUNT })).toBeNull();
  });

  /** Runs the real sw.js (as the build writes it) against a fake service-worker scope. */
  const runWorker = () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const posted: unknown[] = [];
    const badges: number[] = [];
    const calls: { url: string; init: RequestInit }[] = [];
    const windowClient = {
      url: 'https://app.test/a/acme',
      postMessage: (m: unknown) => posted.push(m),
      focus: async () => undefined,
    };
    const self = {
      location: { origin: 'https://app.test' },
      addEventListener: (type: string, fn: (e: unknown) => void) => (handlers[type] = fn),
      clients: { matchAll: async () => [windowClient], openWindow: async () => null, claim: async () => undefined },
      registration: { showNotification: async () => undefined, unregister: async () => true },
      navigator: { setAppBadge: async (n: number) => badges.push(n), clearAppBadge: async () => badges.push(0) },
      skipWaiting: () => undefined,
    };
    const fetchFake = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, json: async () => ({ ok: true, unread_count: 4 }) };
    };
    new Function('self', 'caches', 'fetch', renderServiceWorker(['/assets/index-a1.js']))(self, {}, fetchFake);
    const click = async (data: unknown) => {
      let done: Promise<unknown> = Promise.resolve();
      handlers.notificationclick!({
        notification: { data, close: () => undefined },
        waitUntil: (p: Promise<unknown>) => (done = p),
      });
      await done;
    };
    return { click, calls, posted, badges };
  };

  it('the service worker posts it on click, moves the badge and tells open windows', async () => {
    const w = runWorker();
    await w.click({ url: '/a/acme/b/1/i/2?tab=updates', id: ID, account_id: ACCOUNT, badge: true });
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]!.url).toBe('/api/v1/me/notifications/read');
    expect(w.calls[0]!.init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' });
    expect(w.badges).toEqual([4]);
    expect(w.posted).toContainEqual({ type: 'notifications-read', account_id: ACCOUNT });
    expect(w.posted).toContainEqual({ type: 'navigate', url: '/a/acme/b/1/i/2?tab=updates' });

    // The badge switched off for this person: the icon is left alone. An old payload: no request at all.
    const quiet = runWorker();
    await quiet.click({ url: '/a/acme', id: ID, account_id: ACCOUNT, badge: false });
    expect(quiet.badges).toEqual([]);
    const old = runWorker();
    await old.click({ url: '/a/acme' });
    expect(old.calls).toHaveLength(0);
  });
});

describe('"must refresh to continue" (s4f)', () => {
  it('compares the page build with the server build and its breaking epoch', () => {
    const base = { appBuild: 'aaa', appEpoch: 1, serverEpoch: 1 };
    expect(buildState({ ...base, serverBuild: 'aaa' })).toBe('current');
    // The server does not know its build (development): never a bar.
    expect(buildState({ ...base, serverBuild: 'dev' })).toBe('current');
    expect(buildState({ ...base, serverBuild: '' })).toBe('current');
    expect(buildState({ ...base, serverBuild: 'bbb' })).toBe('stale');
    expect(buildState({ ...base, serverBuild: 'bbb', serverEpoch: 2 })).toBe('must_refresh');
    // Same build never forces, whatever the epochs say.
    expect(buildState({ ...base, serverBuild: 'aaa', serverEpoch: 9 })).toBe('current');
  });

  it('the bar shows for a newer build, and gives way to the must-refresh screen', () => {
    const s = { waiting: false, activated: false, dismissed: false };
    expect(showUpdateBanner({ ...s, stale: true })).toBe(true);
    expect(showUpdateBanner({ ...s, stale: true, dismissed: true })).toBe(false);
    expect(showUpdateBanner({ ...s, stale: true, mustRefresh: true })).toBe(false);
  });

  it('the build id: given, else the deployed commit, else the build time', () => {
    expect(webBuildId({ PWA_BUILD_ID: ' b42 ' }, 0)).toBe('b42');
    expect(webBuildId({ RAILWAY_GIT_COMMIT_SHA: '0123456789abcdef' }, 0)).toBe('0123456789ab');
    expect(webBuildId({}, 36 ** 3)).toBe('1000');
  });
});
