// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** After M3 feedback: subitems are multi-selected with their own batch bar; the footer calculation is chosen per column. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, prefix: string) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`${prefix} ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת פריט|\+ הוספת/).first();
  await add.fill('Parent');
  await add.press('Enter');
  await expect(row(page, 'Parent')).toBeVisible();
};

test('subitems: check several, their own batch bar; checking an item clears them', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, 'בחירת סאב');
  await row(page, 'Parent').hover();
  await row(page, 'Parent').getByTestId('subitems-toggle').click();
  const subAdd = page.getByLabel('+ הוספת תת-פריט');
  for (const n of ['Sub A', 'Sub B', 'Sub C']) {
    await subAdd.fill(n);
    await subAdd.press('Enter');
    await expect(row(page, n)).toBeVisible();
  }

  await row(page, 'Sub A').getByTestId('row-select').click();
  await row(page, 'Sub C')
    .getByTestId('row-select')
    .click({ modifiers: ['Shift'] });
  const bar = page.getByTestId('batch-bar');
  await expect(bar.getByTestId('batch-count')).toHaveText('3');
  // Subitems stay under their parent: no move to another board from here.
  await expect(bar.getByRole('button', { name: 'לבורד אחר' })).toHaveCount(0);

  // One batch at a time: checking the parent item replaces the subitem selection.
  await row(page, 'Parent').getByTestId('row-select').click();
  await expect(bar.getByTestId('batch-count')).toHaveText('1');
  await expect(row(page, 'Sub A')).not.toHaveAttribute('data-selected', 'true');
  await bar.getByRole('button', { name: 'ביטול הבחירה' }).click();

  // The subitems' bar acts on the sub-board: delete two of them.
  await row(page, 'Sub A').getByTestId('row-select').click();
  await row(page, 'Sub B').getByTestId('row-select').click();
  await bar.getByRole('button', { name: 'מחיקה', exact: true }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row(page, 'Sub A')).toHaveCount(0);
  await expect(row(page, 'Sub B')).toHaveCount(0);
  await expect(row(page, 'Sub C')).toBeVisible();
});

test('footer: choose what a column sums up', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, 'סיכום');
  const boardId = /\/b\/([^/?]+)/.exec(page.url())![1]!;
  const accounts = (await (await page.request.get('/api/v1/me/accounts')).json()) as {
    data: { id: string; slug: string }[];
  };
  const headers = { 'x-account-id': accounts.data.find((a) => a.slug === 'demo')!.id };
  const res = await page.request.post(`/api/v1/boards/${boardId}/columns`, {
    headers,
    data: { title: 'סטטוס', type: 'status' },
  });
  expect(res.ok()).toBe(true);
  await page.reload();
  const footer = page.getByTestId('summary-row').first();
  const status = footer.getByRole('button', { name: /חישוב בשורת הסיכום — סטטוס/ });
  await status.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemradio', { name: 'התפלגות' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'מולאו' }).click();
  await expect(status).toContainText('0/1');
  await expect(status).toContainText('מולאו');

  await status.click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'ללא' }).click();
  await expect(status).not.toContainText('0/1');
});
