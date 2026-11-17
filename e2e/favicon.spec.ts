// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * f9-icon: the browser tab's icon. Before sign-in the page links the built-in default (public/favicon-*.png); inside
 * an account it shows the account's icon — the home-screen icon (its logo, or the mark in its colour) drawn at 32.
 */

test('the tab icon is the default before sign-in', async ({ page }) => {
  forbidNativeDialogs(page);
  await page.goto('/');
  const icon = page.locator('link[rel="icon"]').first();
  await expect(icon).toHaveAttribute('href', '/favicon-32.png');
  const res = await page.request.get('/favicon-32.png');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('image/png');
  expect((await page.request.get('/favicon.ico')).status()).toBe(200);
});

test("the tab icon follows the account's home-screen icon", async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { accountId } = await ownerContext(page);
  await page.goto('/a/demo');
  const icons = page.locator('link[rel="icon"]');
  const accountIcon = new RegExp(`^/api/v1/public/pwa/a/${accountId}/icon/favicon-32\\.png\\?v=`);
  await expect(icons.first()).toHaveAttribute('href', accountIcon);
  for (const href of await icons.evaluateAll((ls) => ls.map((l) => l.getAttribute('href')))) {
    expect(href).toMatch(accountIcon);
  }
  // Same version as the iOS home-screen icon: both change when the logo or the colour does.
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href');
  const favicon = await icons.first().getAttribute('href');
  expect(favicon!.split('?v=')[1]).toBe(apple!.split('?v=')[1]);
  const res = await page.request.get(favicon!);
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('image/png');
});
