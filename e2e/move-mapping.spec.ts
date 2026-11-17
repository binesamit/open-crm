// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, rowMenu, signIn } from './helpers';

/** M4.5 (07 §3.4, 04 §6.2): a move converts between column types, and the mapping is remembered per boards. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, name: string, column: string) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: column, exact: true }).click();
};

test('move with a converted column; the mapping comes back next time', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const suffix = Date.now().toString(36);
  const target = `יעד המרה ${suffix}`;
  await newBoard(page, target, 'טקסט ארוך');
  await newBoard(page, `מקור המרה ${suffix}`, 'טקסט');
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['One', 'Two']) {
    await add.fill(name);
    await add.press('Enter');
  }
  const cell = row(page, 'One').locator('[data-column-type="text"]');
  await cell.click();
  await page.keyboard.type('note');
  await page.keyboard.press('Enter');
  await expect(cell).toContainText('note');

  const openMove = async (name: string) => {
    await rowMenu(page, row(page, name), 'העברה לבורד אחר');
    const dialog = page.getByTestId('move-dialog');
    await dialog.getByTestId('move-board').click();
    await page.getByRole('menu').getByRole('menuitemradio', { name: target }).click();
    return dialog.locator('[data-testid="mapping-row"][data-source="טקסט"]');
  };

  // Text → long text is offered as a conversion (not proposed by itself: another type).
  const mapping = await openMove('One');
  await expect(mapping).toContainText('המידע יאבד');
  await mapping.getByRole('button').click();
  await page
    .getByRole('menu')
    .getByRole('menuitemradio', { name: /טקסט ארוך · יומר/ })
    .click();
  await expect(mapping.getByTestId('mapping-converted')).toBeVisible();
  await page.getByTestId('move-confirm').click();
  await expect(row(page, 'One')).toHaveCount(0);

  // The next move between the same boards starts from that mapping.
  const again = await openMove('Two');
  await expect(again.getByTestId('mapping-converted')).toBeVisible();
});
