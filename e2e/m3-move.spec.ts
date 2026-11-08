// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, rowMenu, signIn } from './helpers';

/** M3 step 5c (07 §3.4–3.7): move to another board through the mapping dialog, undo; item → subitem. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, name: string) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'מספרים', exact: true }).click();
  return page.url();
};
const addItem = async (page: Page, name: string) => {
  const add = page.getByPlaceholder(/\+ הוספת פריט/).first();
  await add.fill(name);
  await add.press('Enter');
  await expect(row(page, name)).toBeVisible();
};

test('move an item to another board with the mapping, undo; make an item a subitem', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const suffix = Date.now().toString(36);
  const targetName = `יעד ${suffix}`;
  const targetUrl = await newBoard(page, targetName);
  const sourceUrl = await newBoard(page, `מקור ${suffix}`);
  await addItem(page, 'Deal');
  await addItem(page, 'Parent');
  await row(page, 'Deal').locator('[data-column-type="numbers"]').click();
  await page.keyboard.type('42');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Deal').locator('[data-column-type="numbers"]')).toHaveText('42');

  // Move: pick the board; "מספרים" maps to "מספרים" by type + title.
  await rowMenu(page, row(page, 'Deal'), 'העברה לבורד אחר');
  const dialog = page.getByTestId('move-dialog');
  await dialog.getByTestId('move-board').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: targetName }).click();
  await expect(dialog.locator('[data-testid="mapping-row"][data-source="מספרים"]')).toContainText('מספרים');
  await page.getByTestId('move-confirm').click();
  await expect(row(page, 'Deal')).toHaveCount(0);
  await expect(page.getByTestId('toast').filter({ hasText: targetName })).toBeVisible();

  // Undo from the toast: back, with its value.
  await page.getByTestId('toast').filter({ hasText: targetName }).getByTestId('toast-action').click();
  await expect(row(page, 'Deal').locator('[data-column-type="numbers"]')).toHaveText('42');

  // Again, and look on the target board.
  await rowMenu(page, row(page, 'Deal'), 'העברה לבורד אחר');
  await page.getByTestId('move-dialog').getByTestId('move-board').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: targetName }).click();
  await page.getByTestId('move-confirm').click();
  await expect(row(page, 'Deal')).toHaveCount(0);
  await page.goto(targetUrl);
  await expect(row(page, 'Deal').locator('[data-column-type="numbers"]')).toHaveText('42');

  // Convert: an item becomes a subitem of another.
  await page.goto(sourceUrl);
  await addItem(page, 'Child');
  await rowMenu(page, row(page, 'Child'), 'הפיכה לתת-פריט של…');
  const convert = page.getByTestId('convert-dialog');
  await convert.getByTestId('convert-parent').filter({ hasText: 'Parent' }).click();
  await page.getByTestId('convert-confirm').click();
  await expect(row(page, 'Parent').getByTestId('subitems-toggle')).toContainText('1');
});
