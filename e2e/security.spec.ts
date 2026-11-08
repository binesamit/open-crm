// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Security S-11 / S-14 in the app: an inbound-webhook automation always has a secret (generated on save), shown to
 * its manager with a copy button and accepted only in the X-Bines-Secret header; profile photos refuse SVG.
 */
test('an inbound automation gets a secret on save; only the header opens it', async ({ page }) => {
  test.setTimeout(90_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  const { headers } = await ownerContext(page);
  const workspaces = (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as {
    data: { id: string }[];
  };
  const board = (await (
    await page.request.post('/api/v1/boards', {
      headers,
      data: { name: `נכנס ${run}`, workspace_id: workspaces.data[0]!.id },
    })
  ).json()) as { id: string };
  const created = (await (
    await page.request.post(`/api/v1/boards/${board.id}/automations`, {
      headers,
      data: {
        title: `נכנס ${run}`,
        recipe: {
          trigger: { type: 'webhook_in', item_lookup: { column: 'id', path: 'item_id' } },
          actions: [{ type: 'set_item_name', name: '{item.name} ✓' }],
        },
        is_active: true,
      },
    })
  ).json()) as { id: string; recipe: { trigger: { secret: string } } };
  const secret = created.recipe.trigger.secret;
  expect(secret.length).toBeGreaterThanOrEqual(16);

  // The builder shows the secret with a copy button; the list has no "no secret" warning.
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('board-automations').click();
  const row = page.locator('[data-testid="automation-row"]', { hasText: `נכנס ${run}` });
  await expect(row.getByTestId('automation-inbound')).toBeVisible();
  await expect(row.getByTestId('automation-inbound-no-secret')).toHaveCount(0);
  await row.getByTestId('automation-edit').click();
  await expect(page.getByTestId('auto-inbound-secret')).toHaveValue(secret);
  await expect(page.getByTestId('auto-inbound-secret-copy')).toBeVisible();

  // Header: accepted. URL: refused, even with the right secret.
  const hook = `/api/v1/hooks/in/${created.id}`;
  expect((await page.request.post(hook, { headers: { 'x-bines-secret': secret }, data: {} })).status()).toBe(202);
  expect((await page.request.post(`${hook}?secret=${secret}`, { data: {} })).status()).toBe(401);
});

test('the profile photo picker offers raster images only', async ({ page }) => {
  await signIn(page);
  await page.goto('/a/demo/me');
  const input = page.getByTestId('me-avatar-input');
  await expect(input).toHaveAttribute('accept', /image\/png/);
  expect(await input.getAttribute('accept')).not.toContain('svg');
});
