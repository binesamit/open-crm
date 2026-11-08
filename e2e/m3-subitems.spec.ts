// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, rowMenu, signIn } from './helpers';

/** M3 step 4 (D14): subitems open under the item, on their own columns, indented one step per level. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
/** Right edge of a row's name (RTL: the start side) — deeper levels sit further in. */
const nameEdge = async (page: Page, name: string) => {
  const box = (await row(page, name).getByText(name, { exact: true }).boundingBox())!;
  return box.x + box.width;
};

test('add subitems and a sub-subitem; own columns; stairs; collapse; kept after reload', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`סאב ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת פריט|\+ הוספת/).first();
  await add.fill('Parent');
  await add.press('Enter');
  await expect(row(page, 'Parent')).toBeVisible();

  // The arrow by the name opens the (empty) subitems table with its "add" field.
  await row(page, 'Parent').hover();
  await row(page, 'Parent').getByTestId('subitems-toggle').click();
  const subAdd = page.getByLabel('+ הוספת תת-פריט');
  await subAdd.fill('Sub 1');
  await subAdd.press('Enter');
  await expect(row(page, 'Sub 1')).toBeVisible();
  await expect(row(page, 'Parent').getByTestId('subitems-toggle')).toContainText('1');

  // Own columns: the subitems header has the sub-board's columns, the board's header does not.
  const subhead = page.getByTestId('subhead').first();
  await expect(subhead).toContainText('אחראי');
  await expect(subhead).toContainText('סטטוס');
  await expect(page.getByTestId('header-row').first()).not.toContainText('אחראי');

  // Stairs: the subitem's name starts further in than its parent's.
  expect((await nameEdge(page, 'Parent')) - (await nameEdge(page, 'Sub 1'))).toBeGreaterThan(25);

  // A sub-subitem from the subitem's menu, one more step in.
  await rowMenu(page, row(page, 'Sub 1'), 'הוספת תת-פריט');
  // The new level's "add" field takes focus.
  const focused = page.locator('input:focus');
  await expect(focused).toHaveAttribute('aria-label', '+ הוספת תת-פריט');
  await focused.fill('Sub 1.1');
  await focused.press('Enter');
  await expect(row(page, 'Sub 1.1')).toBeVisible();
  expect((await nameEdge(page, 'Sub 1')) - (await nameEdge(page, 'Sub 1.1'))).toBeGreaterThan(25);

  // Open rows are not remembered across visits (product decision): closed after a reload; the arrow opens them.
  await page.reload();
  await expect(row(page, 'Sub 1')).toHaveCount(0);
  await row(page, 'Parent').getByTestId('subitems-toggle').click();
  await expect(row(page, 'Sub 1')).toBeVisible();
  await row(page, 'Parent').getByTestId('subitems-toggle').click();
  await expect(row(page, 'Sub 1')).toHaveCount(0);
  await expect(row(page, 'Sub 1.1')).toHaveCount(0);
});
