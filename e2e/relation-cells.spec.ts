// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/** M1.1 #3: relation picker lists without typing, creates a missing item, and chips open the linked card. */
test('relation: list, create, open the linked item', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const stamp = Date.now().toString(36);

  await page.locator('aside a', { hasText: 'לקוחות' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('לקוחות');
  const boardUrl = page.url();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(`לקוח ${stamp}`);
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: `לקוח ${stamp}` }).first();
  await expect(row).toBeVisible();
  const header = page.locator('div.grid').first();
  const i = (await header.locator(':scope > div').allTextContents()).findIndex(
    (x) => x.replace('⋯', '').trim() === 'חשבוניות',
  );
  const cell = row.locator(':scope > div').nth(i);

  // Typing a name that doesn't exist offers to create it in the target board, and links it.
  await cell.click();
  const picker = page.getByTestId('popover');
  await picker.getByPlaceholder('חיפוש פריטים').fill(`חשבונית ${stamp}`);
  await picker.getByRole('button', { name: `יצירת "חשבונית ${stamp}"` }).click();
  await expect(cell.getByTestId('cell-value')).toContainText(`חשבונית ${stamp}`);

  // Without typing, the picker already lists items; the new one is checked.
  await picker.getByPlaceholder('חיפוש פריטים').fill('');
  await expect(picker.getByRole('checkbox').first()).toBeVisible();
  await expect(picker.getByRole('checkbox', { name: `חשבונית ${stamp}` })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();

  // The chip opens the invoice's card over the clients board; closing returns to the board.
  await cell.getByRole('button', { name: `חשבונית ${stamp}` }).click();
  const card = page.getByRole('dialog');
  await expect(card.getByRole('heading', { level: 2 })).toHaveText(`חשבונית ${stamp}`);
  expect(page.url()).toContain(new URL(boardUrl).pathname);
  await card.getByRole('button', { name: 'סגירה' }).click();
  await expect(card).toBeHidden();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('לקוחות');
});
