// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * a voice message in an update — the microphone is pressed to start (never by itself), a red indicator
 * with the time shows while it records, "stop" attaches it as an ordinary audio file that plays in place; ✕ drops
 * it. Chromium's fake microphone (a tone) stands in for a real one.
 */
test.use({
  permissions: ['microphone'],
  // A page answered through page.route loses its "local" address space, and Chrome's Local Network Access check
  // then blocks its upload to the local storage (localhost:9000) — a test artifact (production storage is public).
  launchOptions: {
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-features=LocalNetworkAccessChecks',
    ],
  },
});

/** Every page document answered with this Permissions-Policy (as production serves them). */
const withPolicy = (page: Page, policy: string) =>
  // Only the app's own pages (never /api, the storage upload or assets — those are not intercepted at all).
  page.route(
    (url) =>
      url.origin === new URL(WEB_URL).origin && /^\/(a|login|$)/.test(url.pathname) && !url.pathname.includes('.'),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const res = await route.fetch({ maxRedirects: 0 });
      await route.fulfill({ response: res, headers: { ...res.headers(), 'permissions-policy': policy } });
    },
  );

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

test('record a voice message in an update; cancel drops one', async ({ page }) => {
  forbidNativeDialogs(page);
  // Round 2 (product owner: "only an error pops, the browser never asks"): production pages carry the API's
  // Permissions-Policy (dev's Vite sends none) — the app's pages get the real header here.
  const policy = (await page.request.get('/api/v1/health')).headers()['permissions-policy'] ?? '';
  expect(policy).toContain('microphone=(self)');
  await withPolicy(page, policy);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const tag = uid();
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `קול ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: `פריט ${tag}` } });
  await page.goto(`/a/demo/b/${board.id}`);
  const r = page.locator(`[data-testid="item-row"][data-item-name="פריט ${tag}"]`);
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: `פריט ${tag}` });
  await card.getByLabel(/כתבו עדכון/).click();

  // Cancel: nothing attached.
  await card.getByTestId('composer-record').click();
  await expect(card.getByTestId('composer-recording')).toBeVisible();
  await card.getByTestId('composer-record-cancel').click();
  await expect(card.getByTestId('composer-record')).toBeVisible();
  await expect(card.getByTestId('composer-file-remove')).toHaveCount(0);

  // Record ~2 seconds, stop: attached as an audio file.
  await card.getByTestId('composer-record').click();
  await expect(card.getByTestId('composer-recording-time')).toContainText('0:01', { timeout: 5000 });
  await card.getByTestId('composer-record-stop').click();
  await expect(card.getByTestId('composer-file-remove')).toHaveCount(1, { timeout: 10_000 });
  await card.getByRole('button', { name: 'עדכון', exact: true }).click();

  // Sent: it plays in place.
  const media = card.getByTestId('update-media').first();
  await expect(media).toHaveAttribute('data-kind', 'audio');
  await expect(media.getByTestId('update-file')).toContainText('הקלטה');
  await expect(media.getByTestId('media-player')).toBeVisible();
});

test('a blocked microphone explains in our own dialog how to allow it (no native alert)', async ({ page }) => {
  forbidNativeDialogs(page);
  // The old header: the browser refuses without asking.
  await withPolicy(page, 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const tag = uid();
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `קול חסום ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: `פריט ${tag}` } });
  await page.goto(`/a/demo/b/${board.id}`);
  const r = page.locator(`[data-testid="item-row"][data-item-name="פריט ${tag}"]`);
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: `פריט ${tag}` });
  await card.getByLabel(/כתבו עדכון/).click();
  await card.getByTestId('composer-record').click();
  const dialog = page.getByRole('alertdialog').or(page.getByRole('dialog', { name: 'צריך גישה למיקרופון' }));
  await expect(dialog).toContainText('מיקרופון ← אפשר');
  await expect(card.getByTestId('composer-recording')).toHaveCount(0);
});
