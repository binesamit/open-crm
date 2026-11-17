// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn, pickGroupColumn } from './helpers';

/** M4.5 views (15 §7): row height, wrapping text, search highlights, copy a view, "+ item" in a grouping. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, name: string) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
};

test('row height and wrapped text', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `שורות ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'טקסט', exact: true }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Long');
  await add.press('Enter');
  const cell = row(page, 'Long').locator('[data-column-type="text"]');
  await cell.click();
  await page.keyboard.type('מילה '.repeat(30));
  await page.keyboard.press('Enter');
  await expect(cell).toContainText('מילה');
  const height = async () => (await row(page, 'Long').boundingBox())!.height;
  expect(await height()).toBeLessThan(40);

  await page.getByTestId('toolbar-view-settings').click();
  await page.getByTestId('view-row-height').click();
  await page.getByRole('menuitemradio', { name: 'שלוש שורות' }).click();
  await expect.poll(height).toBeGreaterThan(70);

  // Wrapping: the text runs onto the lines instead of one cut line.
  const text = cell.locator('.truncate').first();
  const textHeight = async () => (await text.boundingBox())!.height;
  expect(await textHeight()).toBeLessThan(25);
  await page.getByTestId('view-wrap-text').click();
  await expect(page.getByTestId('board-table')).toHaveAttribute('data-wrap', 'true');
  await expect.poll(textHeight).toBeGreaterThan(30);
});

test('board search marks its matches in names and cells', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `הדגשה ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'טקסט', exact: true }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['Apple pie', 'Banana']) {
    await add.fill(name);
    await add.press('Enter');
  }
  const cell = row(page, 'Banana').locator('[data-column-type="text"]');
  await cell.click();
  await page.keyboard.type('apple juice');
  await page.keyboard.press('Enter');
  await expect(cell).toContainText('apple juice');

  const marks = () => page.evaluate(() => CSS.highlights.get('bines-search')?.size ?? 0);
  await page.getByTestId('toolbar-search').fill('apple');
  await expect.poll(marks).toBe(2); // "Apple" in a name, "apple" in a cell
  await page.getByTestId('toolbar-search').fill('');
  await expect.poll(marks).toBe(0);
});

test('copy a view to another board', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const suffix = Date.now().toString(36);
  await newBoard(page, `יעד ${suffix}`);
  await newBoard(page, `מקור ${suffix}`);
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: /טבלה/ }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(`מבט ${suffix}`);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  const tab = page.getByTestId('view-tab').filter({ hasText: `מבט ${suffix}` });
  await expect(tab).toHaveAttribute('aria-selected', 'true');

  await tab.click({ button: 'right' });
  await page.getByRole('menu').getByRole('menuitem', { name: 'העתקה לבורד אחר…' }).click();
  await page.getByTestId('board-picker-board').click();
  await page
    .getByRole('menu')
    .getByRole('menuitemradio', { name: `יעד ${suffix}` })
    .click();
  await page.getByTestId('board-picker-confirm').click();
  // Another toast (e.g. "first steps done") may show at the same time: look for this one.
  await expect(page.getByTestId('toast').filter({ hasText: `הועתקה ל"יעד ${suffix}"` })).toBeVisible();

  await page
    .getByRole('link', { name: `יעד ${suffix}` })
    .first()
    .click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`יעד ${suffix}`);
  await expect(page.getByTestId('view-tab').filter({ hasText: `מבט ${suffix}` })).toBeVisible();
});

test('"+ item" in a grouping by column creates the item in that section', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `קיבוץ ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'סטטוס', exact: true }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Alpha');
  await add.press('Enter');
  await row(page, 'Alpha').locator('[data-column-type="status"]').click();
  await page.getByTestId('popover').getByRole('button', { name: 'הושלם', exact: true }).click();
  await expect(row(page, 'Alpha').locator('[data-column-type="status"]')).toContainText('הושלם');

  await page.getByTestId('toolbar-group').click();
  await pickGroupColumn(page, 'סטטוס');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-section').first()).toContainText('הושלם');

  // The first section's "+ item" field: the new item gets "הושלם" and stays in that section.
  const firstAdd = page.getByPlaceholder(/\+ הוספת/).first();
  await firstAdd.fill('Beta');
  await firstAdd.press('Enter');
  await expect(row(page, 'Beta').locator('[data-column-type="status"]')).toContainText('הושלם');
  // Both are "הושלם": still one section, no "no value" one.
  await expect(page.getByTestId('board-section')).toHaveCount(1);
});
