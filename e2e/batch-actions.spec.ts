// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M3 step 3 (07 §6): checkboxes, Shift+click range, group / Ctrl+A select, the batch bar, undo of a batch. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`מרובה ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'מספרים', exact: true }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['A', 'B', 'C', 'D']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }
};

const check = (page: Page, name: string, shift = false) =>
  row(page, name)
    .getByTestId('row-select')
    .click({ modifiers: shift ? ['Shift'] : [] });

test('range select, set a value on the batch, delete and undo', async ({ page }) => {
  await newBoard(page);
  const bar = page.getByTestId('batch-bar');
  await expect(bar).toHaveCount(0);

  await check(page, 'A');
  await check(page, 'C', true);
  await expect(page.getByTestId('batch-count')).toHaveText('3');
  await expect(row(page, 'D')).not.toHaveAttribute('data-selected');
  // c9: a pill — round ends, a round count badge and ✕, both clear of the curve (RTL: the count on the right).
  const round = (l: Locator) =>
    l.evaluate((el) => parseFloat(getComputedStyle(el).borderTopLeftRadius) >= el.getBoundingClientRect().height / 2);
  const close = bar.getByRole('button', { name: 'ביטול הבחירה' });
  expect(await round(bar)).toBe(true);
  expect(await round(bar.getByTestId('batch-count'))).toBe(true);
  expect(await round(close)).toBe(true);
  const [barBox, countBox, closeBox] = [
    (await bar.boundingBox())!,
    (await bar.getByTestId('batch-count').boundingBox())!,
    (await close.boundingBox())!,
  ];
  expect(barBox.x + barBox.width - (countBox.x + countBox.width)).toBeGreaterThanOrEqual(12);
  expect(closeBox.x - barBox.x).toBeGreaterThanOrEqual(12);

  // Edit → the numbers column → its own editor; the value lands on all three.
  await bar.getByRole('button', { name: 'עריכה' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'מספרים' }).click();
  const editor = page.getByTestId('batch-editor');
  await editor.locator('[data-column-type="numbers"] > *').first().click();
  await page.keyboard.type('7');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('toast').filter({ hasText: 'עודכן ב-3 פריטים' })).toBeVisible();
  for (const n of ['A', 'B', 'C']) await expect(row(page, n).locator('[data-column-type="numbers"]')).toHaveText('7');
  await expect(row(page, 'D').locator('[data-column-type="numbers"]')).toHaveText('');

  // Delete key → confirm → gone; the toast's undo brings all three back.
  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('Delete');
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  for (const n of ['A', 'B', 'C']) await expect(row(page, n)).toHaveCount(0);
  await expect(bar).toHaveCount(0);
  await page.getByTestId('toast').filter({ hasText: '3 פריטים הועברו לסל' }).getByTestId('toast-action').click();
  for (const n of ['A', 'B', 'C']) await expect(row(page, n)).toBeVisible();
});

test('group checkbox, Ctrl+A, Esc, move to another group', async ({ page }) => {
  await newBoard(page);
  await page.getByTestId('group-header').first().getByTestId('section-select').click();
  await expect(page.getByTestId('batch-count')).toHaveText('4');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('batch-bar')).toHaveCount(0);

  await page.locator('body').click({ position: { x: 5, y: 400 } });
  await page.keyboard.press('ControlOrMeta+A');
  await expect(page.getByTestId('batch-count')).toHaveText('4');
  await page.getByTestId('batch-bar').getByRole('button', { name: 'ביטול הבחירה' }).click();

  // N21: a new group comes from the split arrow next to "add item" (name + colour), not a button after the groups.
  await page.getByTestId('add-group-open').click();
  await page.getByTestId('add-group-name').fill('קבוצה חדשה');
  await page.getByTestId('add-group-submit').click();
  await expect(page.getByTestId('board-section')).toHaveCount(2);
  await check(page, 'B');
  await page.getByTestId('batch-bar').getByRole('button', { name: 'העברה לקבוצה' }).click();
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem').first().click(); // the new group is on top
  await expect(page.getByTestId('toast').filter({ hasText: 'הועברו ל"קבוצה חדשה"' })).toBeVisible();
  // The new group is on top: B is now the only row before the second section header.
  const before = await page.evaluate(() => {
    const all = [...document.querySelectorAll<HTMLElement>('[data-testid="board-section"],[data-testid="item-row"]')];
    const second = all.findIndex((e, i) => e.dataset.testid === 'board-section' && i > 0);
    return all.slice(1, second).map((e) => e.dataset.itemName);
  });
  expect(before).toEqual(['B']);
});
