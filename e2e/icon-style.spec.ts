// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * (product decision: an icon look of our own): profile → appearance → "Icon style" — two-tone by
 * default, applied live to every icon (<html data-icon-style>, each icon's own data-icon-style), saved for the user;
 * the account's default (Administration → General) applies to whoever never chose.
 */
const api = (path: string) => `/api/v1${path}`;

test.afterEach(async ({ page }) => {
  const { headers } = await ownerContext(page);
  await page.request.put(api('/me/appearance'), { headers: { origin: headers.origin }, data: { icon_style: null } });
  await page.request.patch(api('/accounts/me'), {
    headers,
    data: { settings: { defaults: { icon_style: 'duo' } } },
  });
  await page.evaluate(() => localStorage.removeItem('bines:appearance'));
});

/** The style in effect for me in demo (with the account's default). */
const styleOf = async (page: Page) => {
  const { headers } = await ownerContext(page);
  return ((await (await page.request.get(api('/me/appearance'), { headers })).json()) as { icon_style: string })
    .icon_style;
};

test('icon style: two-tone by default, a choice applies live to every icon and is saved', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/profile?tab=appearance');
  const picker = page.getByTestId('icon-style-picker');
  await expect(picker).toBeVisible();
  await expect(page.getByTestId('icon-style-picker-duo')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-icon-style', 'duo');
  // Each card shows its own style, whatever is in effect.
  await expect(page.getByTestId('icon-style-picker-solid').locator('svg').first()).toHaveAttribute(
    'data-icon-style',
    'solid',
  );

  await page.getByTestId('icon-style-picker-sharp').click();
  await expect(page.locator('html')).toHaveAttribute('data-icon-style', 'sharp');
  // The app's icons outside the picker follow at once.
  const outside = page.locator('svg[data-icon-style]:not([data-testid^="icon-style-picker"] svg)');
  await expect(outside.first()).toHaveAttribute('data-icon-style', 'sharp');
  await expect(page.locator('svg[data-icon-style="duo"]:not([data-testid^="icon-style-picker"] svg)')).toHaveCount(0);
  await expect.poll(() => styleOf(page)).toBe('sharp');

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-icon-style', 'sharp');
  await expect(page.getByTestId('icon-style-picker-sharp')).toHaveAttribute('aria-checked', 'true');

  // The earlier look stays available.
  await page.getByTestId('icon-style-picker-line').click();
  await expect(page.locator('html')).toHaveAttribute('data-icon-style', 'line');
  await expect.poll(() => styleOf(page)).toBe('line');
});

test("the account's default icon style applies to members who never chose", async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/admin/general');
  const picker = page.getByTestId('admin-icon-style');
  await picker.scrollIntoViewIfNeeded();
  await expect(page.getByTestId('admin-icon-style-duo')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('admin-icon-style-bold').click();
  await expect(page.getByTestId('admin-icon-style-bold')).toHaveAttribute('aria-checked', 'true');
  // I never chose my own: the next load brings the account's default.
  await expect.poll(() => styleOf(page)).toBe('bold');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-icon-style', 'bold');
});
