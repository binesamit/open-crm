// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * s37license — the owner console's Enterprise license card (LICENSING-OPTIONS B, structure only): it shows the
 * status, refuses a key that is not signed by the licensor (nothing is installed) and stays "no license". A valid key
 * cannot be made here (the licensor's private key is never in the repo); the API test covers installing one.
 */
test('owner console: license card shows the status and refuses an unsigned key', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const before = (await (await page.request.get('/api/v1/platform/license')).json()) as { state: string };
  test.skip(before.state !== 'none', 'a license is installed on this database — leave it alone');
  // The card lives on the owner console's Licensing tab (docs/LICENSING.md).
  await page.goto('/owner');
  await page.getByTestId('owner-section-licensing').click();
  const card = page.getByTestId('owner-license');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('owner-license-state')).toHaveAttribute('data-state', 'none');
  await expect(card.getByTestId('owner-license-save')).toBeDisabled();
  await card.getByTestId('owner-license-key').fill('lic1.eyJsaWNlbnNlZSI6IngifQ.AAAA');
  const put = page.waitForResponse((r) => r.url().endsWith('/platform/license') && r.request().method() === 'PUT');
  await card.getByTestId('owner-license-save').click();
  expect((await put).status()).toBe(400);
  await expect(card.getByTestId('owner-license-state')).toHaveAttribute('data-state', 'none');
  await expect(card.getByTestId('owner-license-remove')).toHaveCount(0);
});
