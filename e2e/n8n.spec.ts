// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * sync-n8n — the automation action "send to integrations" (n8n / Make triggers listen to it): added from the
 * builder's action menu, saved, and shown in the board's automations.
 */
test('an automation can send its item to the subscribed integrations', async ({ page }) => {
  test.setTimeout(90_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`n8n ${run}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();

  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  await page.getByTestId('auto-custom').click();
  const builder = page.getByTestId('automation-builder');
  await expect(builder).toBeVisible();

  await page.getByTestId('auto-add-action').click();
  // The menu entry's label comes from i18n (auto.kind.send_to_integrations).
  await page.getByRole('menuitem', { name: /אינטגרציות|integrations|send_to_integrations/i }).click();
  const action = builder.locator('[data-testid="auto-action"][data-type="send_to_integrations"]');
  await expect(action).toBeVisible();
  await expect(builder.locator('[data-slot$=".channel"]')).toBeVisible();

  await page.getByTestId('auto-title').fill(`n8n ${run}`);
  await page.getByTestId('auto-save').click();
  const row = page.locator('[data-testid="automation-row"]', { hasText: `n8n ${run}` });
  await expect(row).toBeVisible();

  // Clean up.
  await row.getByTestId('automation-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row).toHaveCount(0);
});
