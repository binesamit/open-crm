// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Prod fix M11 ("דומיין קבוע למערכת"): the platform's public address is a setting in the owner console → Platform
 * settings. It shows the address in effect and its source (setting / WEB_ORIGIN), refuses a path or http, keeps the
 * old address among the previous (still accepted) ones, and the web app's copied links follow it.
 * The test puts the platform's address back the way it found it.
 */
type Settings = {
  settings: { public_address: { web_origin?: string; api_origin?: string; previous_origins: string[] } };
  public_address: { web: string; web_source: string };
};
const NEW = 'https://os.e2e-domain.example';

test('owner console: the system address (domain) is a setting, applied at once', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const headers = { origin: WEB_URL };
  const before = (await (await page.request.get('/api/v1/platform/settings')).json()) as Settings;
  try {
    await page.goto('/owner?section=general');
    const card = page.getByTestId('owner-public-address');
    await expect(card).toBeVisible();
    await expect(page.getByTestId('owner-public-address-web-value')).toHaveText(before.public_address.web);

    // A path / http cannot be saved.
    await page.getByTestId('owner-public-address-web').fill('http://os.e2e-domain.example/app');
    await expect(page.getByTestId('owner-public-address-invalid')).toBeVisible();
    await expect(page.getByTestId('owner-public-address-save')).toBeDisabled();

    await page.getByTestId('owner-public-address-web').fill(NEW);
    await page.getByTestId('owner-public-address-save').click();
    await expect(page.getByTestId('owner-public-address-web-value')).toHaveText(NEW);
    await expect(page.getByTestId('owner-public-address-web-source')).toContainText(/setting|ההגדרה/);
    // The address it moved away from stays accepted (sign-in keeps working on it).
    await expect(page.getByTestId('owner-public-address-previous')).toContainText(before.public_address.web);

    // The web app's copied links follow it (public endpoint).
    const pub = (await (await page.request.get('/api/v1/public/address')).json()) as { web: string; api: string };
    expect(pub).toEqual({ web: NEW, api: NEW });

    // Still signed in and working on the old (local) address.
    expect((await page.request.get('/api/v1/platform/settings')).status()).toBe(200);
  } finally {
    const s = before.settings.public_address;
    await page.request.patch('/api/v1/platform/settings', {
      headers,
      data: {
        public_address: {
          web_origin: s.web_origin ?? null,
          api_origin: s.api_origin ?? null,
          previous_origins: s.previous_origins ?? [],
        },
      },
    });
  }
});
