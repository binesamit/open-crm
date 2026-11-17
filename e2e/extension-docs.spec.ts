// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * s37docs: the extension developer guide is reachable for outside developers — served by the deployment at
 * /api/docs/extensions (and /quickstart), linked from the API reference and from Administration → Extensions →
 * "For developers".
 */
test('the extension developer guide is served and linked from the developer tab', async ({ page }) => {
  forbidNativeDialogs(page);

  // Public pages: no sign-in needed.
  await page.goto('/api/docs/extensions');
  await expect(page.getByTestId('ext-docs')).toBeVisible();
  await expect(page.locator('h1')).toContainText('developer guide');
  await page.locator('nav a', { hasText: 'Quickstart' }).click();
  await expect(page).toHaveURL(/\/api\/docs\/extensions\/quickstart$/);
  await expect(page.locator('h1')).toContainText('Quickstart');

  // In the app: the developer tab links to the same pages on this origin.
  await signIn(page);
  await page.goto('/a/demo/admin/extensions');
  await page.getByTestId('ext-tab-dev').click();
  await expect(page.getByTestId('ext-dev-guide')).toHaveAttribute('href', '/api/docs/extensions');
  await expect(page.getByTestId('ext-dev-quickstart')).toHaveAttribute('href', '/api/docs/extensions/quickstart');
  const [guide] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('ext-dev-guide').click()]);
  await expect(guide.getByTestId('ext-docs')).toBeVisible();
  await expect(page.getByTestId('ext-dev-tools')).not.toContainText('npx create-bines-app');
});
