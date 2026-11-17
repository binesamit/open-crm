// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M1.1 #18: a text cell suggests the column's existing values; free text still works. */
test('text cell suggests existing values', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`הצעות ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'טקסט', exact: true }).click();

  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['א', 'ב', 'ג', 'ד']) {
    await add.fill(`שורה ${name}`);
    await add.press('Enter');
  }
  const cell = (row: string) =>
    page
      .locator('div.grid', { hasText: `שורה ${row}` })
      .first()
      .locator('[data-column-type="text"]');
  const type = async (row: string, value: string) => {
    await cell(row).click();
    await page.keyboard.press('ControlOrMeta+A');
    await page.keyboard.type(value);
    await page.keyboard.press('Enter');
    await expect(cell(row)).toHaveText(value);
  };
  await type('א', 'תל אביב');
  await type('ב', 'חיפה');

  // Typing filters; ↓ + Enter picks.
  await cell('ג').click();
  const list = page.getByRole('listbox', { name: 'ערכים קיימים בעמודה' });
  await expect(list.getByRole('option')).toHaveText(['חיפה', 'תל אביב']);
  await page.keyboard.type('תל');
  await expect(list.getByRole('option')).toHaveText(['תל אביב']);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(cell('ג')).toHaveText('תל אביב');

  // A click picks too; the most used value now comes first.
  await cell('ד').click();
  await expect(list.getByRole('option').first()).toHaveText('תל אביב');
  await list.getByRole('option', { name: 'חיפה' }).click();
  await expect(cell('ד')).toHaveText('חיפה');

  // Free text is still free.
  await type('א', 'ירושלים');
  await page.reload();
  await expect(cell('א')).toHaveText('ירושלים');
});
