// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, rowMenu, signIn } from './helpers';

/** M3 step 1 (07 §5.2–5.3): delete → toast "ביטול" brings it back; trash page restores in place. */
const addItem = async (page: Page, name: string) => {
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
  await expect(row).toBeVisible();
  return row;
};

const deleteRow = async (page: Page, row: ReturnType<Page['locator']>) => {
  await rowMenu(page, row, /^מחיקה/);
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row).toHaveCount(0);
};

test('undo a delete from the toast', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.locator('aside a', { hasText: 'לידים' }).first().click();
  const name = `ביטול ${Date.now().toString(36)}`;
  const row = await addItem(page, name);
  await deleteRow(page, row);

  const toast = page.getByTestId('toast').filter({ hasText: name });
  await expect(toast).toContainText('הועבר לסל המחזור');
  await toast.getByTestId('toast-action').click();
  await expect(page.locator(`[data-testid="item-row"][data-item-name="${name}"]`)).toBeVisible();
  await expect(page.getByTestId('toast').filter({ hasText: 'הפעולה בוטלה' })).toBeVisible();
  // Toasts fade away by themselves (the pointer resting on one would hold it).
  await page.mouse.move(5, 700);
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 12_000 });
});

test('restore from the trash page', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.locator('aside a', { hasText: 'לידים' }).first().click();
  const boardUrl = page.url();
  const name = `סל ${Date.now().toString(36)}`;
  await deleteRow(page, await addItem(page, name));

  await page.getByTestId('profile-menu').click();
  await page.getByTestId('menu-trash').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('סל מחזור');
  await page.getByLabel('חיפוש בסל').fill(name);
  const entry = page.locator(`[data-testid="trash-row"][data-name="${name}"]`);
  await expect(entry).toContainText('פריט');
  await expect(entry).toContainText('לידים');
  await entry.getByTestId('trash-restore').click();
  await expect(entry).toHaveCount(0);
  await expect(page.getByTestId('toast').filter({ hasText: 'שוחזר' })).toBeVisible();

  await page.goto(boardUrl);
  await expect(page.locator(`[data-testid="item-row"][data-item-name="${name}"]`)).toBeVisible();
});
