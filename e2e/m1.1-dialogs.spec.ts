// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, rowMenu, signIn } from './helpers';

/** M1.1 #9: deletes confirm through the system dialog, never window.confirm. */
test('delete an item through the system dialog', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.locator('aside a', { hasText: 'לידים' }).first().click();
  const name = `מחיקה ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: name }).first();
  await expect(row).toBeVisible();

  const dialog = page.getByRole('alertdialog');
  await rowMenu(page, row, /^מחיקה/);
  await expect(dialog).toContainText(name);
  await dialog.getByRole('button', { name: 'ביטול' }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();

  await rowMenu(page, row, /^מחיקה/);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(row).toBeVisible();

  await rowMenu(page, row, /^מחיקה/);
  await dialog.getByRole('button', { name: 'מחיקה' }).click();
  await expect(page.locator('div.grid', { hasText: name })).toHaveCount(0);
});
