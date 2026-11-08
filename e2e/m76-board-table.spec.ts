// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M7.6 board table: a header row per group (round 7; was N6's single header), a group-name summary (N3), update counts (N4), add-column search (N9). */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, items: string[]) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`טבלה ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of items) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }
};

const addColumn = async (page: Page, type: string) => {
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: type, exact: true }).click();
  await expect(page.getByTestId('header-row').first().locator('[data-header]', { hasText: type })).toBeVisible();
};

const setNumber = async (page: Page, name: string, value: string) => {
  await row(page, name).locator('[data-column-type="numbers"] > *').first().click();
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
  await expect(row(page, name).locator('[data-column-type="numbers"]')).toHaveText(value);
};

test('every group has its own header row, under its name and above its rows (round 7)', async ({ page }) => {
  await newBoard(page, ['A']);
  await addColumn(page, 'מספרים');
  await page.getByTestId('add-group-open').click();
  await page.getByTestId('add-group-name').fill('שנייה');
  await page.getByTestId('add-group-submit').click();
  await expect(page.getByTestId('board-section')).toHaveCount(2);

  // One header row per group (Fix: reverses N6's single board header).
  await expect(page.getByTestId('group-header')).toHaveCount(2);
  const header = page.getByTestId('group-header').first();
  const headerBox = (await header.boundingBox())!;
  const firstSection = (await page.getByTestId('board-section').first().boundingBox())!;
  expect(headerBox.y).toBeGreaterThan(firstSection.y);
  expect(headerBox.y).toBeLessThan((await row(page, 'A').boundingBox())!.y);
  // Its columns line up with the rows' cells.
  const th = (await header.locator('[data-header]').first().boundingBox())!;
  const td = (await row(page, 'A').locator('[data-column-type="numbers"]').boundingBox())!;
  expect(Math.abs(th.x - td.x)).toBeLessThan(2);
  expect(Math.abs(th.width - td.width)).toBeLessThan(2);
});

test('a chosen field summarised next to each group name, set in view settings', async ({ page }) => {
  await newBoard(page, ['A', 'B']);
  await addColumn(page, 'מספרים');
  await setNumber(page, 'A', '5');
  await setNumber(page, 'B', '7');
  // The footer's sum is a data value: regular weight, never bold (audit 2026-10-10 ux #3; product decision).
  const footerValue = page.getByTestId('summary-row').first().locator('span.tabular-nums', { hasText: /^12$/ });
  await expect(footerValue).toHaveCSS('font-weight', '400');
  // Off by default.
  await expect(page.getByTestId('group-summary')).toHaveCount(0);

  await page.getByTestId('toolbar-view-settings').click();
  await page.getByTestId('view-group-summary').click();
  await page.getByRole('menuitemradio', { name: 'מספרים' }).click();
  const summary = page.getByTestId('board-section').first().getByTestId('group-summary');
  await expect(summary).toHaveText('12'); // the footer's calculation: the sum

  await page.getByTestId('view-group-summary-fn').click();
  await page.getByRole('menuitemradio', { name: 'ממוצע' }).click();
  await expect(summary).toHaveText('6');
  // A view setting like any other: a draft until saved.
  await expect(page.getByTestId('save-bar')).toBeVisible();

  await page.getByTestId('view-group-summary').click();
  await page.getByRole('menuitemradio', { name: 'ללא' }).click();
  await expect(page.getByTestId('group-summary')).toHaveCount(0);
});

test('add-column search filters the types; Enter adds the first match', async ({ page }) => {
  await newBoard(page, ['A']);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  const search = page.getByTestId('add-column-search');
  await expect(search).toBeFocused();
  const types = page.getByTestId('add-column-type');
  const all = await types.count();
  await search.fill('zzz');
  await expect(types).toHaveCount(0);
  await expect(page.getByText('אין תוצאות')).toBeVisible();
  await search.fill('מספר');
  expect(await types.count()).toBeLessThan(all);
  await expect(types.first()).toHaveText('מספרים');
  await search.press('Enter');
  await expect(search).toBeHidden();
  await expect(page.getByTestId('header-row').first().locator('[data-header]', { hasText: 'מספרים' })).toBeVisible();
});

test('update count next to the item name opens the Updates tab', async ({ page }) => {
  await newBoard(page, ['A', 'B']);
  await expect(page.getByTestId('row-update-count')).toHaveCount(0);

  await row(page, 'A').hover();
  await row(page, 'A').getByRole('link', { name: 'פתיחה' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(/כתבו עדכון/).click();
  await page.keyboard.type('עדכון ראשון');
  await dialog.getByRole('button', { name: 'עדכון', exact: true }).click();
  await expect(dialog.locator('article').first()).toContainText('עדכון ראשון');
  await dialog.getByRole('button', { name: 'סגירה' }).click();
  await expect(dialog).toBeHidden();

  const pill = row(page, 'A').getByTestId('row-update-count');
  await expect(pill).toHaveText('1');
  await expect(row(page, 'B').getByTestId('row-update-count')).toHaveCount(0);
  await pill.click();
  await expect(page).toHaveURL(/tab=updates/);
  await expect(page.getByRole('dialog').locator('article').first()).toContainText('עדכון ראשון');
});
