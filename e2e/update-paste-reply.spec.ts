// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** Fixes after the first data import (2026-10-03). */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('paste a screenshot into an update; reply to a reply', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.locator('aside a', { hasText: 'כרטיסי תמיכה' }).first().click();
  const name = `תמונה ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: name }).first();
  await row.hover();
  await row.getByRole('link', { name: 'פתיחה' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();

  // Ctrl+V of an image: it is attached (with a preview) and shown in the posted update.
  const box = page.getByLabel(/כתבו עדכון/);
  await box.click();
  await box.pressSequentially('צילום מסך');
  await box.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'screenshot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_1PX);
  await expect(page.getByTestId('composer-image')).toBeVisible();
  await page.getByRole('button', { name: 'עדכון', exact: true }).click();
  const card = page.locator('article').first();
  await expect(card.getByTestId('update-image').locator('img')).toBeVisible();

  // A reply, then a reply to that reply (one level deeper).
  await card.locator('[data-depth="0"]').getByRole('button', { name: 'תגובה', exact: true }).click();
  await page.getByLabel('כתבו תגובה…').fill('תגובה ראשונה');
  await page.getByLabel('כתבו תגובה…').press('Control+Enter');
  const first = card.locator('[data-depth="1"]', { hasText: 'תגובה ראשונה' });
  await expect(first).toBeVisible();
  await first.getByRole('button', { name: 'תגובה', exact: true }).click();
  await page.getByLabel('כתבו תגובה…').fill('תגובה לתגובה');
  await page.getByLabel('כתבו תגובה…').press('Control+Enter');
  await expect(card.locator('[data-depth="2"]', { hasText: 'תגובה לתגובה' })).toBeVisible();
});

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const newBoard = async (page: Page, name: string, columns: string[]) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  for (const type of columns) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Item');
  await add.press('Enter');
  await expect(row(page, 'Item')).toBeVisible();
};
const columnSettings = async (page: Page, title: string) => {
  await page.getByRole('button', { name: new RegExp(`^פעולות לעמודה ${title}`) }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'הגדרות עמודה' }).click();
};
const pick = async (page: Page, testId: string, option: string) => {
  await page.getByTestId(testId).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: option, exact: true }).click();
};

test('numbers: currency, decimals, thousands', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `מספרים ${Date.now().toString(36)}`, ['מספרים']);
  const cell = row(page, 'Item').locator('[data-column-type="numbers"]');
  await cell.click();
  await page.keyboard.type('1234.5');
  await page.keyboard.press('Enter');
  // a new numbers column shows a thousands separator by default.
  await expect(cell).toHaveText('1,234.5');

  await columnSettings(page, 'מספרים');
  await page.getByTestId('numbers-format').getByRole('radio', { name: 'מטבע', exact: true }).click();
  await pick(page, 'numbers-currency', '$');
  await pick(page, 'numbers-decimals', '2');
  const thousands = page.getByRole('switch', { name: 'מפריד אלפים (1,000)' });
  await expect(thousands).toBeChecked();
  await expect(page.getByTestId('numbers-preview')).toHaveText('$1,234.50');
  // Off and back on: the preview follows the switch.
  await thousands.click();
  await expect(page.getByTestId('numbers-preview')).toHaveText('$1234.50');
  await thousands.click();
  await expect(page.getByTestId('numbers-preview')).toHaveText('$1,234.50');
  await page.getByTestId('column-settings-save').click();
  await expect(cell).toHaveText('$1,234.50');

  await columnSettings(page, 'מספרים');
  await page.getByTestId('numbers-format').getByRole('radio', { name: 'אחוזים', exact: true }).click();
  await page.getByTestId('column-settings-save').click();
  await expect(cell).toHaveText('1,234.50%');
});

test('formula: the function list with examples inserts at the caret', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `נוסחה ${Date.now().toString(36)}`, ['נוסחה']);
  await columnSettings(page, 'נוסחה');
  const fns = page.getByTestId('formula-functions');
  await expect(fns.getByTestId('formula-function')).toHaveCount(51); // + ADD_WORKDAYS
  await fns.getByRole('button', { name: 'טקסט', exact: true }).click();
  await expect(fns.locator('[data-name="LEN"]')).toContainText('LEN("Bines") → 5');
  await fns.getByRole('button', { name: 'הכל', exact: true }).click();
  await fns.getByRole('textbox').fill('round');
  await fns.locator('[data-name="ROUND"]').click();
  await expect(page.getByTestId('formula-input')).toHaveValue('ROUND()');
  await expect(page.getByTestId('formula-input')).toBeFocused();
  await page.keyboard.type('10/3,1');
  await expect(page.getByTestId('formula-input')).toHaveValue('ROUND(10/3,1)');
  await page.getByRole('button', { name: 'שמירה' }).click();
  await expect(row(page, 'Item').locator('[data-column-type="formula"]')).toHaveText('3.3');
});

test('drag items within a group and into another group, at a chosen place', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `גרירה ${Date.now().toString(36)}`, []);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const n of ['B', 'C']) {
    await add.fill(n);
    await add.press('Enter');
    await expect(row(page, n)).toBeVisible();
  }
  // A second group with one item.
  // N21: a new group comes from the split arrow next to "add item" (name + colour), not a button after the groups.
  await page.getByTestId('add-group-open').click();
  await page.getByTestId('add-group-name').fill('קבוצה חדשה');
  await page.getByTestId('add-group-submit').click();
  const addInSecond = page.getByPlaceholder(/\+ הוספת/).last();
  await addInSecond.fill('X');
  await addInSecond.press('Enter');
  await expect(row(page, 'X')).toBeVisible();
  const order = async (names: string[]) => {
    const ys = await Promise.all(names.map(async (n) => [n, (await row(page, n).boundingBox())!.y] as const));
    return ys.sort((a, b) => a[1] - b[1]).map(([n]) => n);
  };

  // Within the group: C above Item.
  const drop = async (name: string, target: string, where: 'top' | 'bottom') => {
    const box = (await row(page, target).boundingBox())!;
    await row(page, name).hover();
    await row(page, name)
      .getByTestId('item-drag')
      .dragTo(row(page, target), { targetPosition: { x: box.width / 2, y: where === 'top' ? 4 : box.height - 4 } });
  };
  await drop('C', 'Item', 'top');
  await expect.poll(() => order(['Item', 'B', 'C'])).toEqual(['C', 'Item', 'B']);

  // Into the other group, after X.
  await drop('Item', 'X', 'bottom');
  await expect.poll(() => order(['C', 'B', 'X', 'Item'])).toEqual(['C', 'B', 'X', 'Item']);
  // Kept after a reload.
  await page.reload();
  await expect(row(page, 'X')).toBeVisible();
  expect(await order(['C', 'B', 'X', 'Item'])).toEqual(['C', 'B', 'X', 'Item']);
});

test('conditional coloring: a whole item and a cell, saved with the view', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `צביעה ${Date.now().toString(36)}`, ['מספרים']);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('דחוף לקוח');
  await add.press('Enter');
  await expect(row(page, 'דחוף לקוח')).toBeVisible();
  const amount = row(page, 'Item').locator('[data-column-type="numbers"]');
  await amount.click();
  await page.keyboard.type('500');
  await page.keyboard.press('Enter');
  await expect(amount).toHaveText('500');

  // r15board: coloring is a page of the view settings (the gear).
  await page.getByTestId('toolbar-view-settings').click();
  await page.getByTestId('toolbar-coloring').click();
  const panel = page.getByTestId('coloring-panel');
  // 1) name contains "דחוף" → the whole item, red.
  await panel.getByTestId('coloring-add').click();
  const first = panel.getByTestId('coloring-rule').first();
  await first.getByTestId('rule-column').click();
  await page.getByRole('menuitemradio', { name: 'שם', exact: true }).click();
  await first.getByTestId('rule-operator').click();
  await page.getByRole('menuitemradio', { name: 'מכיל', exact: true }).click();
  await first.getByTestId('rule-text').fill('דחוף');
  await first.locator('[role="radio"][data-color="crimson"]').click();
  // 2) numbers > 100 → that cell, green.
  await panel.getByTestId('coloring-add').click();
  const second = panel.getByTestId('coloring-rule').last();
  await second.getByTestId('rule-column').click();
  await page.getByRole('menuitemradio', { name: 'מספרים', exact: true }).click();
  await second.getByTestId('rule-operator').click();
  await page.getByRole('menuitemradio', { name: 'גדול מ-', exact: true }).click();
  await second.locator('input[inputmode="decimal"]').fill('100');
  await second.getByTestId('coloring-target').click();
  await page.getByRole('menuitemradio', { name: 'את התא ב-מספרים' }).click();
  await second.locator('[role="radio"][data-color="forest"]').click();
  await page.keyboard.press('Escape');

  await expect(row(page, 'דחוף לקוח')).toHaveAttribute('data-color', 'crimson');
  await expect(row(page, 'Item')).not.toHaveAttribute('data-color');
  await expect(amount).toHaveAttribute('data-color', 'forest');

  // Saved (on the default table: as a new view) — still there after a reload, with nothing unsaved.
  await page.getByTestId('view-save').click();
  await page.getByRole('dialog').getByRole('textbox').fill('צבעים');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('view-tab').filter({ hasText: 'צבעים' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('save-bar')).toBeHidden();
  await page.reload();
  await expect(row(page, 'דחוף לקוח')).toHaveAttribute('data-color', 'crimson');
  await expect(row(page, 'Item').locator('[data-column-type="numbers"]')).toHaveAttribute('data-color', 'forest');
});
