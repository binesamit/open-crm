// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M3 step 5d (07 §4.1, §4.3): duplicate a board with its items; save a board as a template and use it. */
const boardMenu = async (page: Page, name: string, item: string) => {
  const row = page.getByTestId('board-row').filter({ hasText: name }).first();
  await row.hover();
  await row.getByRole('button', { name: /^פעולות ל/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
};

test('duplicate a board with its items, save it as a template, create a board from it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `מקור ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const add = page.getByPlaceholder(/\+ הוספת פריט/).first();
  await add.fill('Row 1');
  await add.press('Enter');
  await expect(page.locator('[data-testid="item-row"][data-item-name="Row 1"]')).toBeVisible();

  await boardMenu(page, name, 'שכפול הבורד');
  const dialog = page.getByTestId('board-copy-dialog');
  await expect(dialog.getByRole('textbox')).toHaveValue(`העתק של ${name}`);
  await dialog.getByTestId('board-copy-mode').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'מבנה ופריטים' }).click();
  await page.getByTestId('board-copy-confirm').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`העתק של ${name}`);
  await expect(page.locator('[data-testid="item-row"][data-item-name="Row 1"]')).toBeVisible();

  await boardMenu(page, name, 'שמירה כתבנית');
  await page.getByTestId('template-dialog').getByRole('textbox').fill(`תבנית ${name}`);
  await page.getByTestId('template-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'נשמרה' })).toBeVisible();

  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`מתבנית ${name}`);
  await page.getByRole('button', { name: 'תבנית', exact: true }).click();
  await page
    .getByRole('menu')
    .getByRole('menuitemradio', { name: `תבנית ${name}` })
    .click();
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`מתבנית ${name}`);
  await expect(page.locator('[data-testid="item-row"]')).toHaveCount(0);
});

test('a template with items, managed on the account page', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `פריטים ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת פריט/).first();
  for (const item of ['Task 1', 'Task 2']) {
    await add.fill(item);
    await add.press('Enter');
  }
  await expect(page.locator('[data-testid="item-row"][data-item-name="Task 2"]')).toBeVisible();

  await boardMenu(page, name, 'שמירה כתבנית');
  await page.getByTestId('template-dialog').getByRole('textbox').fill(`עם פריטים ${name}`);
  await page.getByTestId('template-with-items').check();
  await page.getByTestId('template-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'נשמרה' })).toBeVisible();

  // A board from it starts with the items.
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`מתבנית ${name}`);
  await page.getByRole('button', { name: 'תבנית', exact: true }).click();
  await page
    .getByRole('menu')
    .getByRole('menuitemradio', { name: `עם פריטים ${name}` })
    .click();
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`מתבנית ${name}`);
  await expect(page.locator('[data-testid="item-row"]')).toHaveCount(2);

  // Administration → templates lists it: rename, then delete.
  await page.goto('/a/demo/admin/templates');
  const row = page.locator(`[data-testid="template-row"][data-name="עם פריטים ${name}"]`);
  await expect(row).toContainText('מבנה ו-2 פריטים');
  await row.getByRole('button', { name: /^פעולות לתבנית/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'שינוי שם' }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(`שונה ${name}`);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  const renamed = page.locator(`[data-testid="template-row"][data-name="שונה ${name}"]`);
  await expect(renamed).toBeVisible();
  await renamed.getByRole('button', { name: /^פעולות לתבנית/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'מחיקה' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(renamed).toHaveCount(0);
});
