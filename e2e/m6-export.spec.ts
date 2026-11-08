// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M6 stage 8 — export the board (the view) and a selection to Excel / CSV. */
test('export the board to Excel and CSV, and a selection to Excel', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  const boardName = `ייצוא ${run}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(boardName);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['ראשון', 'שני']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(page.locator(`[data-testid="item-row"][data-item-name="${name}"]`)).toBeVisible();
  }

  // Toolbar → Excel: a real .xlsx (a zip), named after the board.
  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: /^ייצוא/ }).click();
  const [xlsx] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'ייצוא לאקסל', exact: true }).click(),
  ]);
  expect(xlsx.suggestedFilename()).toMatch(new RegExp(`^${boardName} \\d{4}-\\d{2}-\\d{2}\\.xlsx$`));
  expect(
    readFileSync((await xlsx.path())!)
      .subarray(0, 2)
      .toString(),
  ).toBe('PK');

  // Toolbar → CSV: both items, header first.
  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: /^ייצוא/ }).click();
  const [csv] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'ייצוא ל-CSV' }).click(),
  ]);
  const text = readFileSync((await csv.path())!, 'utf8');
  expect(text).toContain('ראשון');
  expect(text).toContain('שני');

  // A selection from the Batch bar.
  await page.locator('[data-testid="item-row"][data-item-name="שני"]').getByTestId('row-select').check();
  await expect(page.getByTestId('batch-count')).toHaveText('1');
  const [picked] = await Promise.all([page.waitForEvent('download'), page.getByTestId('batch-export').click()]);
  expect(picked.suggestedFilename()).toMatch(/\.xlsx$/);
});
