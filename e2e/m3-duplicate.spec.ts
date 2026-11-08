// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, rowMenu, signIn } from './helpers';

/** M3 step 5b (07 §4.2): duplicate an item from its menu (copy right below), undo from the toast; a group copy. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const order = (page: Page) =>
  page.locator('[data-testid="item-row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-item-name')));

test('duplicate an item and a group', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  const boardName = `שכפול ${Date.now().toString(36)}`;
  await page.getByLabel('שם הבורד').fill(boardName);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(boardName);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['A', 'B']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }

  await rowMenu(page, row(page, 'A'), /^שכפול$/);
  await expect(row(page, 'A (עותק)')).toBeVisible();
  expect(await order(page)).toEqual(['A', 'A (עותק)', 'B']);
  await page.getByTestId('toast').filter({ hasText: 'שוכפל' }).getByTestId('toast-action').click();
  await expect(row(page, 'A (עותק)')).toHaveCount(0);

  const section = page.getByTestId('board-section').first();
  await section.hover();
  await section.getByRole('button', { name: /^פעולות לקבוצה/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'שכפול הקבוצה' }).click();
  await expect(page.getByTestId('board-section')).toHaveCount(2);
  await expect(page.getByTestId('board-section').nth(1)).toContainText('(עותק)');
  // The copied section's header can show a moment before its rows.
  await expect.poll(async () => (await order(page)).filter((n) => n === 'A')).toHaveLength(2);
});
