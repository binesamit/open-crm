// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * r19pwa (the planning notes "PWA"): the phone app. The page points its manifest at the account's (name, colour, icons
 * drawn from the logo); the service worker registers (development: only with the `bines.pwa.dev` flag); without a
 * connection a clear "no connection" screen covers the data; and "turn on this phone" registers a push subscription
 * (the browser's push service is faked — headless Chromium has none).
 */

/** Development registers the worker only when asked; a fake push service answers PushManager. */
const enablePwaDev = (page: Page) =>
  page.addInitScript(() => {
    localStorage.setItem('bines.pwa.dev', '1');
    const endpoint = `https://fcm.googleapis.com/fcm/send/${Math.random().toString(36).slice(2)}`;
    let sub: PushSubscription | null = null;
    const fake = {
      endpoint,
      options: { applicationServerKey: null },
      toJSON: () => ({
        endpoint,
        keys: {
          p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
          auth: 'tBHItJI5svbpez7KI4CCXg',
        },
      }),
      unsubscribe: async () => {
        sub = null;
        return true;
      },
    } as unknown as PushSubscription;
    if ('PushManager' in window) {
      PushManager.prototype.subscribe = async () => (sub = fake);
      PushManager.prototype.getSubscription = async () => sub;
    }
    if ('Notification' in window) {
      Notification.requestPermission = async () => 'granted';
      // The headless shell answers "denied" whatever the context granted.
      Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true });
    }
  });

test('the manifest, icon and theme follow the account', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { accountId } = await ownerContext(page);
  await page.goto('/a/demo');
  const manifest = page.locator('link[rel="manifest"]');
  await expect(manifest).toHaveAttribute('href', `/api/v1/public/pwa/a/${accountId}/manifest.webmanifest`);
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    'href',
    new RegExp(`/api/v1/public/pwa/a/${accountId}/icon/apple-180\\.png`),
  );
  const res = await page.request.get(`/api/v1/public/pwa/a/${accountId}/manifest.webmanifest`);
  expect(res.headers()['content-type']).toContain('application/manifest+json');
  const m = (await res.json()) as { id: string; start_url: string; display: string; icons: { src: string }[] };
  expect(m).toMatchObject({ id: '/a/demo/', display: 'standalone' });
  expect(m.start_url.startsWith('/a/demo')).toBe(true);
  const icon = await page.request.get(m.icons[0]!.src);
  expect(icon.status()).toBe(200);
  expect(icon.headers()['content-type']).toBe('image/png');
});

test('the service worker registers and the offline screen replaces the data', async ({ page, context }) => {
  forbidNativeDialogs(page);
  await enablePwaDev(page);
  await signIn(page);
  await page.goto('/a/demo');
  const script = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL ?? '');
  expect(script).toContain('/sw.js');

  await context.setOffline(true);
  try {
    await expect(page.getByTestId('pwa-offline')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
  await expect(page.getByTestId('pwa-offline')).toBeHidden();
});

test('turn on this phone: a push subscription is registered and listed as this device', async ({ page, context }) => {
  forbidNativeDialogs(page);
  await context.grantPermissions(['notifications'], { origin: WEB_URL });
  await enablePwaDev(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  await page.goto('/a/demo/profile?tab=notifications');
  await expect(page.getByTestId('notif-push-header')).toBeVisible();
  const phone = page.getByTestId('notif-phone');
  await expect(phone).toBeVisible();
  await page.evaluate(async () => navigator.serviceWorker.ready);
  const created = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/me/push-subscriptions') && r.request().method() === 'POST',
  );
  await phone.getByTestId('notif-phone-enable').click();
  expect((await created).status()).toBe(201);
  const mine = phone.locator('[data-testid="notif-phone-device"][data-current="true"]');
  await expect(mine).toBeVisible();

  // Clean up: remove this device (the list in the API is per user and account).
  const list = (await (await page.request.get('/api/v1/me/push-subscriptions', { headers })).json()) as {
    data: { id: string }[];
  };
  for (const d of list.data) await page.request.delete(`/api/v1/me/push-subscriptions/${d.id}`, { headers });
});
