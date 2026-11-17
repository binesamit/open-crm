// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * M1.1 #1–2: edit status and dropdown labels from the cell — rename, colour, add, drag, delete, create by typing.
 * leaving the editor without Save (a click outside, Esc) saves; only Cancel drops the edits.
 */
const newBoardWith = async (page: Page, types: string[]) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תוויות ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of types) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const name = `פריט ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  return page.locator('div.grid', { hasText: name }).first();
};

const drag = async (page: Page, from: Locator, to: Locator) => {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y - 10, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + 2, { steps: 10 });
  await page.mouse.up();
  // dnd-kit swallows clicks for 50ms after a drop; a person never clicks that fast, a test does.
  await page.waitForTimeout(100);
};

test('edit status labels from the cell', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const row = await newBoardWith(page, ['סטטוס']);
  const cell = row.locator('[data-column-type="status"]');

  await cell.click();
  await page.getByRole('button', { name: 'עריכת תוויות' }).click();
  const editor = page.getByTestId('label-editor');
  const rows = editor.getByTestId('label-row');
  const before = await rows.count();

  // Rename the first label and give it another colour.
  await rows.nth(0).getByLabel('שם התווית').fill('בבדיקה');
  await rows.nth(0).getByRole('button', { name: 'צבע' }).click();
  await rows.nth(0).locator('[role="option"][data-color="blue"]').click();
  // r15: the colour palette stays open after a pick; Esc folds it (the label editor stays open).
  await page.keyboard.press('Escape');
  await expect(rows.nth(0).locator('[role="option"][data-color="blue"]')).toHaveCount(0);
  await expect(editor).toBeVisible();

  // Add a label and drag it to the top.
  await editor.getByRole('button', { name: /תווית חדשה/ }).click();
  await expect(rows).toHaveCount(before + 1);
  await rows.last().getByLabel('שם התווית').fill('דחוף');
  await drag(page, rows.last().getByRole('button', { name: 'גרירה לשינוי הסדר' }), rows.first());
  await expect(rows.first().getByLabel('שם התווית')).toHaveValue('דחוף');
  await editor.getByRole('button', { name: 'שמירה' }).click();
  await expect(editor).toBeHidden();

  // The picker shows the new order; pick the new label.
  const picker = page.getByTestId('popover').filter({ has: page.getByRole('button', { name: 'עריכת תוויות' }) });
  await expect(picker.locator('button.label-tag').first()).toHaveText('דחוף');
  // D-PAL: a label is a solid chip in its colour, its colour a palette key.
  await expect(picker.getByRole('button', { name: 'בבדיקה' })).toHaveAttribute('data-color', 'blue');
  await picker.getByRole('button', { name: 'דחוף' }).click();
  await expect(cell).toHaveText('דחוף');

  // Delete the label the cell uses: it disappears from the picker, the cell keeps its text.
  await cell.click();
  await page.getByRole('button', { name: 'עריכת תוויות' }).click();
  await rows.first().getByRole('button', { name: 'מחיקת תווית' }).click();
  await editor.getByRole('button', { name: 'שמירה' }).click();
  await expect(picker.getByRole('button', { name: 'דחוף' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  await page.reload();
  await expect(page.locator('[data-column-type="status"]').first()).toHaveText('דחוף');
});

test('dropdown: create by typing, rename in the editor', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const row = await newBoardWith(page, ['רשימה נפתחת']);
  const cell = row.locator('[data-column-type="dropdown"]');
  const chips = cell.getByTestId('cell-value');

  await cell.click();
  const search = page.getByPlaceholder('חיפוש או יצירת תווית');
  await search.fill('VIP');
  await search.press('Enter');
  await expect(chips).toContainText('VIP');
  await search.fill('לקוח חוזר');
  await page.getByRole('button', { name: 'יצירת "לקוח חוזר"' }).click();
  await expect(chips).toContainText('לקוח חוזר');

  // Typing an existing label + Enter toggles it off.
  await search.fill('VIP');
  await search.press('Enter');
  await expect(chips).not.toContainText('VIP');
  await search.fill('VIP');
  await search.press('Enter');

  await page.getByRole('button', { name: 'עריכת תוויות' }).click();
  const rows = page.getByTestId('label-editor').getByTestId('label-row');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).getByLabel('שם התווית').fill('VIP זהב');
  await page.getByTestId('label-editor').getByRole('button', { name: 'שמירה' }).click();
  await expect(chips).toContainText('VIP זהב');
  await page.keyboard.press('Escape');

  await page.reload();
  const saved = page.locator('[data-column-type="dropdown"]').first().getByTestId('cell-value');
  await expect(saved).toContainText('VIP זהב');
  await expect(saved).toContainText('לקוח חוזר');
});

test('leaving the label editor without Save keeps the edits; Cancel drops them', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const row = await newBoardWith(page, ['סטטוס', 'רשימה נפתחת']);
  const editor = page.getByTestId('label-editor');
  const rows = editor.getByTestId('label-row');
  const outside = () => page.mouse.click(5, 300);

  // Status: rename the first label, then click outside the editor.
  const status = row.locator('[data-column-type="status"]');
  await status.click();
  await page.getByRole('button', { name: 'עריכת תוויות' }).click();
  await rows.nth(0).getByLabel('שם התווית').fill('נשמר ביציאה');
  await outside();
  await expect(editor).toBeHidden();
  await status.click();
  const picker = page.getByTestId('popover').filter({ has: page.getByRole('button', { name: 'עריכת תוויות' }) });
  await expect(picker.getByRole('button', { name: 'נשמר ביציאה' })).toBeVisible();

  // Cancel drops the edit.
  await page.getByRole('button', { name: 'עריכת תוויות' }).click();
  await rows.nth(0).getByLabel('שם התווית').fill('בוטל');
  await page.getByTestId('label-editor-cancel').click();
  await expect(editor).toBeHidden();
  await expect(picker.getByRole('button', { name: 'בוטל' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Dropdown: a new label typed in the editor, then Esc.
  const dropdown = row.locator('[data-column-type="dropdown"]');
  await dropdown.click();
  await page.getByRole('button', { name: 'עריכת תוויות' }).click();
  await editor.getByRole('button', { name: /תווית חדשה/ }).click();
  await rows.last().getByLabel('שם התווית').fill('אחרי Esc');
  await page.keyboard.press('Escape');
  await expect(editor).toBeHidden();

  await page.reload();
  await page.locator('[data-column-type="dropdown"]').first().click();
  await expect(page.getByRole('checkbox', { name: 'אחרי Esc' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('[data-column-type="status"]').first().click();
  await expect(page.getByRole('button', { name: 'נשמר ביציאה' })).toBeVisible();
});
