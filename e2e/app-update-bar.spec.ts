// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * s4f-pwa (the planning notes "PWA"): "must refresh to continue". The page compares its build with the server's
 * (GET /public/pwa/status). Another build → the existing "a new version — refresh" bar; a build the server marks
 * breaking for this page (breaking_epoch above the page's) → one screen with only "refresh", which never reloads by
 * itself — not even while someone types. The status answer is faked here (the dev server's build is 'dev').
 */

const fakeStatus = (page: Page, status: { build: string; breaking_epoch: number }) =>
  page.route('**/api/v1/public/pwa/status', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'cache-control': 'no-store' },
      body: JSON.stringify({ sw_enabled: true, ...status }),
    }),
  );

test('a newer build shows the "new version" bar, which can be closed for now', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await fakeStatus(page, { build: 'e2e-next-build', breaking_epoch: 0 });
  await page.goto('/a/demo');
  const bar = page.getByTestId('pwa-update-banner');
  await expect(bar).toBeVisible();
  await expect(page.getByTestId('pwa-must-refresh')).toHaveCount(0);
  await bar.getByRole('button', { name: 'אחר כך' }).click();
  await expect(bar).toBeHidden();
});

test('the same build (or a server that does not know its own) shows nothing', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await fakeStatus(page, { build: 'dev', breaking_epoch: 999 });
  // The check runs on start: once it answered, nothing may appear.
  const checked = page.waitForResponse('**/api/v1/public/pwa/status');
  await page.goto('/a/demo');
  await checked;
  await expect(page.getByTestId('nav-my-work')).toBeVisible();
  await expect(page.getByTestId('pwa-update-banner')).toHaveCount(0);
  await expect(page.getByTestId('pwa-must-refresh')).toHaveCount(0);
});

test('a breaking build blocks with only "refresh" — never reloads by itself, reloads on the button', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await fakeStatus(page, { build: 'e2e-breaking-build', breaking_epoch: 999 });
  await page.goto('/a/demo');
  // A marker that a reload would wipe.
  await page.evaluate(() => ((window as unknown as { __s4f: number }).__s4f = 1));

  const screen = page.getByTestId('pwa-must-refresh');
  await expect(screen).toBeVisible();
  await expect(screen).toHaveAttribute('role', 'alertdialog');
  await expect(page.getByTestId('pwa-update-banner')).toHaveCount(0);
  // Only one way out.
  await expect(screen.getByRole('button')).toHaveCount(1);
  await expect(page.getByTestId('pwa-must-refresh-button')).toBeFocused();

  // Typing somewhere (and time passing) never reloads the page.
  await page.keyboard.type('טיוטה');
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as unknown as { __s4f?: number }).__s4f)).toBe(1);

  // The new build is live after the refresh.
  await page.unroute('**/api/v1/public/pwa/status');
  await fakeStatus(page, { build: 'dev', breaking_epoch: 0 });
  await Promise.all([page.waitForEvent('load'), page.getByTestId('pwa-must-refresh-button').click()]);
  expect(await page.evaluate(() => (window as unknown as { __s4f?: number }).__s4f)).toBeUndefined();
  await expect(page.getByTestId('pwa-must-refresh')).toHaveCount(0);
});
