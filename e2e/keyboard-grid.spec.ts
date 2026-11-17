// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M4.5 table & keyboard (07 §10): active cell, arrows (RTL), Tab, Enter edits, Delete clears, Esc leaves. */
test('keyboard grid: move, edit and clear cells', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`מקלדת ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of ['מספרים', 'טקסט']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת פריט/).first();
  for (const name of ['Alpha', 'Beta']) {
    await add.fill(name);
    await add.press('Enter');
  }
  const row = (name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
  await expect(row('Beta')).toBeVisible();
  const num = (name: string) => row(name).locator('[data-column-type="numbers"]');
  const text = (name: string) => row(name).locator('[data-column-type="text"]');
  await page.locator('body').click({ position: { x: 5, y: 5 } }); // nothing focused

  // Click the name cell of Alpha: it becomes the active cell (a click on the name itself would rename).
  await row('Alpha')
    .locator('[data-cell="-1"]')
    .click({ position: { x: 4, y: 4 } });
  await expect(row('Alpha').locator('[data-cell="-1"]')).toBeFocused();

  // RTL: the next column is to the left.
  await page.keyboard.press('ArrowLeft');
  await expect(num('Alpha')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('42');
  await page.keyboard.press('Enter');
  await expect(num('Alpha')).toContainText('42');

  // Down to Beta, Tab to the text column, edit it.
  await page.keyboard.press('ArrowDown');
  await expect(num('Beta')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(text('Beta')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('שלום');
  await page.keyboard.press('Enter');
  await expect(text('Beta')).toContainText('שלום');

  // Back up and right (= previous column), then clear Alpha's number.
  await page.keyboard.press('ArrowUp');
  await expect(text('Alpha')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(num('Alpha')).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(num('Alpha')).not.toContainText('42');

  // Shift+Tab from the first column goes to the name; Enter there renames.
  await page.keyboard.press('Shift+Tab');
  await expect(row('Alpha').locator('[data-cell="-1"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Alef');
  await page.keyboard.press('Enter');
  await expect(row('Alef')).toBeVisible();

  // Copy a number down (Ctrl+C / Ctrl+V), then select both with Shift+↑ and clear them.
  await page.keyboard.press('Tab');
  await expect(num('Alef')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.type('7');
  await page.keyboard.press('Enter');
  await expect(num('Alef')).toContainText('7');
  await page.keyboard.press('Control+C');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Control+V');
  await expect(num('Beta')).toContainText('7');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(num('Alef')).toHaveClass(/bg-primary-soft/);
  await page.keyboard.press('Delete');
  await expect(num('Alef')).not.toContainText('7');
  await expect(num('Beta')).not.toContainText('7');

  // Paste two columns from Excel (plain TSV): a number and a text; a bad number is skipped with a toast.
  await page.keyboard.press('Escape'); // drops the range, keeps the cell
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '12\tמאקסל\nלא מספר\tשורה 2\n');
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await expect(num('Alef')).toContainText('12');
  await expect(text('Alef')).toContainText('מאקסל');
  await expect(text('Beta')).toContainText('שורה 2');
  // Another toast (e.g. "first steps done") may show at the same time: look for this one.
  await expect(page.getByTestId('toast').filter({ hasText: '1 תאים לא הודבקו' })).toBeVisible();

  // Cell menu (right click): copy Alef's number, paste it into Beta's, clear Beta's text.
  await num('Alef').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'העתקה' }).click();
  await num('Beta').click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'הדבקה' }).click();
  await expect(num('Beta')).toContainText('12');
  await text('Beta').click({ button: 'right' });
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'פתיחת הפריט' })).toBeVisible();
  await page.getByRole('menu').getByRole('menuitem', { name: 'ניקוי התא' }).click();
  await expect(text('Beta')).not.toContainText('שורה 2');

  // Ctrl+Z undoes the last edit, Ctrl+Shift+Z redoes it; a multi-cell paste is one action.
  await num('Beta').click();
  await page.keyboard.press('Escape'); // closes the editor the click opened
  await expect(num('Beta')).toBeFocused();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+A'); // the editor opens with the current value
  await page.keyboard.type('99');
  await page.keyboard.press('Enter');
  await expect(num('Beta')).toHaveText('99');
  await page.keyboard.press('Control+Z');
  await expect(num('Beta')).toContainText('12');
  // The live refresh can show the value before the undo request returns: wait for its toast.
  await expect(page.getByTestId('toast').filter({ hasText: 'הפעולה בוטלה' })).toBeVisible();
  await page.keyboard.press('Control+Shift+Z');
  await expect(num('Beta')).toContainText('99');
  await expect(page.getByTestId('toast').filter({ hasText: 'בוצע שוב' })).toBeVisible();
  await page.keyboard.press('ArrowUp');
  await expect(num('Alef')).toBeFocused();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData('text/plain', '31\n32\n');
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
  });
  await expect(num('Alef')).toContainText('31');
  await expect(num('Beta')).toContainText('32');
  await page.keyboard.press('Control+Z');
  await expect(num('Alef')).toContainText('12');
  await expect(num('Beta')).toContainText('99');

  // Esc leaves the grid: arrows no longer move.
  await row('Alef')
    .locator('[data-cell="-1"]')
    .click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Escape');
  await page.keyboard.press('ArrowLeft');
  await expect(num('Alef')).not.toBeFocused();
});
