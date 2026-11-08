// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M1.1 #15: a cell editor in the last column stays fully on screen (it used to be cut off at the edge). */
test.use({ viewport: { width: 1000, height: 640 } });

test('cell popovers stay inside the viewport', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`קצה ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of ['טקסט', 'מספרים', 'תאריך', 'טקסט ארוך', 'ציר זמן']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('פריט');
  await add.press('Enter');

  const cell = page.locator('[data-column-type="timeline"]').first();
  await cell.scrollIntoViewIfNeeded();
  await cell.click();
  const popover = page.getByTestId('popover');
  await expect(popover.getByRole('button', { name: 'החודש הבא' })).toBeVisible();
  const box = (await popover.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1000);
  expect(box.y + box.height).toBeLessThanOrEqual(640);
  // Every day is clickable, i.e. nothing is clipped.
  // (The day's label follows the account's date format — pick it by its ISO date.)
  await popover.locator('button[data-iso$="-15"]').first().click();
});
