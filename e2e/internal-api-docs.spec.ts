// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * the internal API reference — every route, internal ones too — for the platform owner only, at
 * /api/docs/internal (same renderer and look as the public /api/docs), linked from the owner console's Platform
 * settings and, for the owner only, from the public reference. Anyone else gets a plain 404.
 */
test('the internal API reference is the owner’s alone and linked from the owner console', async ({ page, request }) => {
  forbidNativeDialogs(page);

  // Signed out: 404, page and document alike; the public reference has no link to it.
  expect((await request.get('/api/docs/internal')).status()).toBe(404);
  expect((await request.get('/api/docs/internal/openapi.json')).status()).toBe(404);
  await page.goto('/api/docs');
  await expect(page.getByTestId('internal-docs-link')).toHaveCount(0);

  // The owner: the owner console links to both references.
  await signIn(page);
  await page.goto('/owner?section=general');
  await expect(page.getByTestId('owner-platform-settings')).toBeVisible();
  await expect(page.getByTestId('owner-api-docs-public')).toHaveAttribute('href', '/api/docs');
  await expect(page.getByTestId('owner-api-docs-internal')).toHaveAttribute('href', '/api/docs/internal');
  const [ref] = await Promise.all([page.waitForEvent('popup'), page.getByTestId('owner-api-docs-internal').click()]);
  await expect(ref.getByTestId('internal-docs-banner')).toContainText('Internal — subject to change');
  // The renderer shows the hand-written channels and the operations, labelled.
  await expect(ref.getByText('Docs collaboration WebSocket').first()).toBeVisible({ timeout: 30_000 });
  await expect(ref.getByText('Internal', { exact: true }).first()).toBeVisible();

  // The public reference links to it — for the owner only.
  await page.goto('/api/docs');
  await expect(page.getByTestId('internal-docs-link')).toHaveAttribute('href', '/api/docs/internal');
});
