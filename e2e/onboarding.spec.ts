// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * "How to start?": a starter kit the owner marks "shown" is a card on the start screen, reached from
 * the sidebar's "+" menu; "skip" goes back home. (Building is covered by the API tests — nothing is built here.)
 */
const origin = { origin: WEB_URL };

test('the start screen shows the gallery kit and is reached from the "+" menu', async ({ page }) => {
  test.setTimeout(90_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const kits = (await (await page.request.get('/api/v1/platform/starter-kits')).json()) as {
    data: { key: string; name: string }[];
  };
  test.skip(!kits.data.length, 'no starter kit in this database');
  const kit = kits.data[0]!;
  const saved = await page.request.patch(`/api/v1/platform/starter-kits/${kit.key}`, {
    headers: origin,
    data: { gallery: { show: true, recommended: true, order: 0, illustration: 'kanban' } },
  });
  expect(saved.status()).toBe(200);

  await page.goto('/a/demo');
  await page.getByTestId('sidebar-add').first().click();
  await page.getByTestId('add-start').click();
  await expect(page).toHaveURL(/\/a\/demo\/start$/);
  await expect(page.getByTestId('start-page')).toBeVisible();
  const card = page.getByTestId(`start-kit-${kit.key}`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(kit.name);

  await page.getByTestId('start-skip').click();
  await expect(page).toHaveURL(/\/a\/demo$/);
  await page.request.patch(`/api/v1/platform/starter-kits/${kit.key}`, {
    headers: origin,
    data: { gallery: { show: false } },
  });
});
