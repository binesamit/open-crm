// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M4.5 (07 §6, §12, 14 §2): right click on selected rows, selection on cards, the board's activity log. */
test('batch menu on selected rows, cards selection, undo from the board log', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`יומן ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['Ant', 'Bee', 'Cat']) {
    await add.fill(name);
    await add.press('Enter');
  }
  const row = (name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
  await expect(row('Cat')).toBeVisible();

  // Two rows checked; a right click on one of them offers the batch actions, for both.
  await row('Ant').hover();
  await row('Ant').getByTestId('row-select').click();
  await row('Bee').hover();
  await row('Bee').getByTestId('row-select').click();
  await expect(page.getByTestId('batch-count')).toHaveText('2');
  await row('Ant').getByText('Ant', { exact: true }).click({ button: 'right' });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'מחיקה' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'ארכיון' }).click();
  await expect(row('Ant')).toHaveCount(0);
  await expect(row('Bee')).toHaveCount(0);

  // The board log: one row for both items, and "undo" brings them back.
  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'יומן פעילות' }).click();
  const log = page.getByTestId('board-activity');
  const batch = log.getByTestId('activity-entry').filter({ hasText: '2 פריטים' }).first();
  await expect(batch).toBeVisible();
  await batch.getByTestId('activity-undo').click();
  await expect(row('Ant')).toBeVisible();
  await expect(row('Bee')).toBeVisible();
  await expect(batch).toHaveAttribute('data-undone', 'true');
  await page.keyboard.press('Escape');

  // Cards select too: a check box per card, and the same batch bar.
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: /כרטיסים/ }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('גלריה');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  const tile = (name: string) => page.locator(`[data-testid="item-tile"][data-item-name="${name}"]`);
  await tile('Cat').hover();
  await tile('Cat').getByTestId('tile-select').click();
  await tile('Ant').click({ modifiers: ['Control'] });
  await expect(page.getByTestId('batch-count')).toHaveText('2');
  await expect(tile('Cat')).toHaveAttribute('data-selected', 'true');
  await expect(page).not.toHaveURL(/\/i\//); // Ctrl+click selects, it does not open the item
});
