// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M4.5 (07 §10): Tab reaches every column, Enter opens each column's editor, Esc closes it, Tab goes on. */
const TYPES = [
  'טקסט',
  'טקסט ארוך',
  'מספרים',
  'סטטוס',
  'רשימה נפתחת',
  'תאריך',
  'ציר זמן',
  'אנשים',
  'אימייל',
  'טלפון',
  'קישור',
  'דירוג',
  'תיבת סימון',
];

test('Tab and Enter work in every column type', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`כל העמודות ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of TYPES) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת פריט/).first();
  await add.fill('Row');
  await add.press('Enter');
  const row = page.locator('[data-testid="item-row"][data-item-name="Row"]');
  await expect(row).toBeVisible();
  await row.locator('[data-cell="-1"]').click({ position: { x: 4, y: 4 } });

  const count = await row.locator('[data-cell]').count();
  for (let i = 0; i < count - 1; i++) {
    await page.keyboard.press('Tab');
    const cell = row.locator(`[data-cell="${i}"]`);
    const type = await cell.getAttribute('data-column-type');
    await expect(cell, `Tab reaches column ${i} (${type})`).toBeFocused();
    if (type === 'checkbox' || type === 'rating') continue; // toggled in place, no editor
    await page.keyboard.press('Enter');
    const popover = page.getByTestId('popover');
    await expect(
      popover.or(cell.locator('input, textarea')).first(),
      `Enter opens the editor of ${type}`,
    ).toBeVisible();
    if (await popover.count()) {
      // A popover editor has the keyboard, and Tab moves within it.
      const inside = () =>
        page.evaluate(() => !!document.querySelector('[data-testid="popover"]')?.contains(document.activeElement));
      await expect.poll(inside, { message: `focus inside the editor of ${type}` }).toBe(true);
      await page.keyboard.press('Tab');
      await expect.poll(inside, { message: `Tab stays inside the editor of ${type}` }).toBe(true);
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
      await expect(cell, `focus back on ${type} after Esc`).toBeFocused();
    } else {
      // An inline editor: Tab saves and goes to the next cell; Shift+Tab comes back.
      await expect(cell.locator('input, textarea').first()).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(row.locator(`[data-cell="${i + 1}"]`), `Tab leaves the inline editor of ${type}`).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(cell).toBeFocused();
    }
  }
});
