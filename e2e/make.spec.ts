// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * AI agents have their own token scopes: the token dialog offers agents:read / agents:run / agents:write
 * and a token with agents:run only reads agents but cannot manage them (as Make / n8n would call it).
 */
test('a token with agents:run lists agents but cannot create one', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.getByTestId('profile-menu').first().click();
  await page.getByTestId('menu-my-profile').click();
  await page.getByTestId('profile-tab-tokens').click();
  await page.getByTestId('token-new').click();
  await page.getByTestId('token-name').fill(`Make agents ${Date.now().toString(36)}`);

  const scopes = page.getByTestId('token-scopes');
  for (const s of ['agents:read', 'agents:run', 'agents:write']) await expect(scopes).toContainText(s);
  // Only agents:run: untick the defaults, tick agents:run.
  for (const s of ['boards:read', 'items:write', 'updates:write', 'agents:run'])
    await scopes.locator('code', { hasText: new RegExp(`^${s}$`) }).click();
  await page.getByTestId('token-create-confirm').click();
  const secret = (await page.getByTestId('token-secret').textContent())!.trim();

  const call = (method: string, path: string, data?: unknown) =>
    page.request.fetch(`/api/v1${path}`, {
      method,
      headers: { authorization: `Bearer ${secret}`, cookie: '' },
      ...(data !== undefined ? { data } : {}),
    });
  expect((await call('GET', '/agents')).status()).toBe(200);
  const create = await call('POST', '/agents', { name: 'x', connection_id: 'x', model: 'x' });
  expect(create.status()).toBe(403);
  expect(((await create.json()) as { error: { code: string } }).error.code).toBe('insufficient_scope');
  expect((await call('GET', '/boards')).status()).toBe(403);
});
