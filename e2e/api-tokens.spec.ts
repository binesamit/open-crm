// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/** M6 stage 6 — a personal API token: created in the UI, shown once, used as an automation platform would, then revoked. */
test('create an API token, use it, revoke it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `Make ${Date.now().toString(36)}`;
  // fix5: my API tokens are a tab of "הפרופיל שלי".
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('menu-my-profile').click();
  await page.getByTestId('profile-tab-tokens').click();
  await page.getByTestId('token-new').click();
  await page.getByTestId('token-name').fill(name);
  await page.getByTestId('token-create-confirm').click();

  const secret = (await page.getByTestId('token-secret').textContent())!.trim();
  expect(secret).toMatch(/^bos_pat_[0-9A-Za-z]{40}$/);

  // As an HTTP module would call it: the bearer token only (no cookie, no account header).
  const call = () =>
    page.request.fetch('/api/v1/auth/me', { headers: { authorization: `Bearer ${secret}`, cookie: '' } });
  expect((await call()).status()).toBe(200);

  await page.getByRole('button', { name: 'סיימתי' }).click();
  const row = page.locator('[data-testid="token-row"]', { hasText: name });
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(secret); // never shown again

  await row.getByTestId('token-revoke').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'השבתה' }).click();
  await expect(row).toHaveCount(0);
  expect((await call()).status()).toBe(401);
});
