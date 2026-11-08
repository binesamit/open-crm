// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Owner fixes, round 3 (table): sort from a column's header (items and subitems), "collapse all" that stays
 * collapsed, the name cell (empty part opens the item, the name renames), label fills edge to edge, and the
 * filter button that counts its conditions instead of chips.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const names = (page: Page) =>
  page.getByTestId('item-row').evaluateAll((els) => els.map((el) => el.getAttribute('data-item-name')));

const newBoard = async (page: Page, items: string[]) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תיקונים 3 ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of items) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }
};

const addSubitem = async (page: Page, parent: string, name: string) => {
  const toggle = row(page, parent).getByTestId('subitems-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await row(page, parent).hover();
    await toggle.click();
  }
  const field = page.getByLabel('+ הוספת תת-פריט');
  await field.fill(name);
  await field.press('Enter');
  await expect(row(page, name)).toBeVisible();
};

test('hovering a header sorts the column: asc → desc → off, the title stays put', async ({ page }) => {
  await newBoard(page, ['Bravo', 'Alpha', 'Charlie']);
  const header = page.getByTestId('header-row').first().locator('[data-name-header]');
  const title = header.locator('span.truncate');
  const sort = header.getByTestId('column-sort');
  const before = (await title.boundingBox())!;

  await header.hover();
  await expect(sort).toBeVisible();
  await expect(sort).toHaveAttribute('data-sort', 'none');
  // The button lies over the header: the title does not move.
  expect((await title.boundingBox())!.x).toBe(before.x);

  await sort.click();
  await expect(sort).toHaveAttribute('data-sort', 'asc');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  // A draft of the view, like the sort panel.
  await expect(page.getByTestId('save-bar')).toBeVisible();
  await expect(page.getByTestId('toolbar-sort')).toContainText('1');

  // The arrow stays while sorted, also without hover.
  await page.mouse.move(5, 5);
  await expect(sort).toHaveCSS('opacity', '1');

  await header.hover();
  await sort.click();
  await expect(sort).toHaveAttribute('data-sort', 'desc');
  await expect.poll(() => names(page)).toEqual(['Charlie', 'Bravo', 'Alpha']);

  await sort.click();
  await expect(sort).toHaveAttribute('data-sort', 'none');
  await expect(page.getByTestId('save-bar')).toBeHidden();
  expect((await title.boundingBox())!.x).toBe(before.x);
});

test('the subitems header sorts the subitems (subitems_sort)', async ({ page }) => {
  await newBoard(page, ['Parent']);
  await addSubitem(page, 'Parent', 'Zulu');
  await addSubitem(page, 'Parent', 'Echo');
  const subName = (i: number) => page.locator('[data-depth="1"] [data-testid="item-row"]').nth(i);
  await expect(subName(0)).toHaveAttribute('data-item-name', 'Zulu');

  const header = page.getByTestId('subhead').locator('[data-name-header]');
  await header.hover();
  await header.getByTestId('column-sort').click();
  await expect(header.getByTestId('column-sort')).toHaveAttribute('data-sort', 'asc');
  await expect(subName(0)).toHaveAttribute('data-item-name', 'Echo');
  await expect(page.getByTestId('save-bar')).toBeVisible();
  // The main board's sort is untouched.
  await expect(
    page.getByTestId('header-row').first().locator('[data-name-header]').getByTestId('column-sort'),
  ).toHaveAttribute('data-sort', 'none');
});

test('collapse all collapses everything and stays so; opening one opens only that one', async ({ page }) => {
  await newBoard(page, ['A1']);
  await addSubitem(page, 'A1', 'Sub');
  // A second group.
  const first = page.getByTestId('board-section').first();
  await first.hover();
  await first.getByRole('button', { name: /פעולות לקבוצה/ }).click();
  await page.getByRole('menuitem', { name: 'קבוצה חדשה מתחת' }).click();
  await expect(page.getByTestId('board-section')).toHaveCount(2);

  // r15board: "collapse all" lives in the group menu (and Ctrl+G), no longer in the toolbar.
  await expect(page.getByTestId('toolbar-collapse-all')).toHaveCount(0);
  await first.hover();
  await first.getByRole('button', { name: /פעולות לקבוצה/ }).click();
  await page.getByRole('menuitem', { name: 'כיווץ כל הקבוצות' }).click();
  await expect(page.getByTestId('item-row')).toHaveCount(0);

  // Ctrl+G again never opens everything.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+g');
  await expect(page.getByTestId('item-row')).toHaveCount(0);

  // Open the first group: its item shows, with its subitems closed (collapse all closed them too).
  const toggleFirst = page.getByTestId('board-section').first().getByRole('button', { name: 'פתיחת הקבוצה' });
  // The save of this change (one group left collapsed), not an earlier one still on its way.
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === 'PUT' &&
      /\/prefs$/.test(r.url()) &&
      (JSON.parse(r.request().postData() ?? '{}') as { collapsed_groups?: string[] }).collapsed_groups?.length === 1,
  );
  await toggleFirst.click();
  await expect(row(page, 'A1')).toBeVisible();
  await expect(row(page, 'Sub')).toHaveCount(0);
  await expect(page.getByTestId('board-section').nth(1).getByRole('button', { name: 'פתיחת הקבוצה' })).toBeVisible();

  // Kept after a reload: only the group that was opened is open.
  await saved;
  await page.reload();
  await expect(row(page, 'A1')).toBeVisible();
  await expect(row(page, 'Sub')).toHaveCount(0);
  await expect(page.getByTestId('board-section').nth(1).getByRole('button', { name: 'פתיחת הקבוצה' })).toBeVisible();
});

test('name cell: the empty part opens the item, the name renames it', async ({ page }) => {
  await newBoard(page, ['Item']);
  const name = row(page, 'Item').locator('[data-name-of] > span.truncate').first();
  await name.click();
  const input = row(page, 'Item').locator('[data-name-of] input:not([type="checkbox"])');
  await expect(input).toBeFocused();
  await input.fill('Renamed');
  await input.press('Enter');
  await expect(row(page, 'Renamed')).toBeVisible();
  await expect(page).not.toHaveURL(/\/i\//);

  // The check box still selects, without opening the item.
  await row(page, 'Renamed').getByTestId('row-select').click();
  await expect(row(page, 'Renamed')).toHaveAttribute('data-selected', 'true');
  await expect(page).not.toHaveURL(/\/i\//);
  await row(page, 'Renamed').getByTestId('row-select').click();

  // Subitems: the same (checked before the card covers the table).
  await addSubitem(page, 'Renamed', 'Child');
  await row(page, 'Child').locator('[data-name-of] > span.truncate').first().click();
  await expect(row(page, 'Child').locator('[data-name-of] input:not([type="checkbox"])')).toBeFocused();
  await page.keyboard.press('Escape');

  await row(page, 'Renamed').getByTestId('item-open-area').click();
  await expect(page).toHaveURL(/\/i\//);
  await page.goBack();
  await expect(page).not.toHaveURL(/\/i\//);
  await row(page, 'Child').getByTestId('item-open-area').click();
  await expect(page).toHaveURL(/\/i\//);
});

test('label fills reach the cell edges; rows share one line colour', async ({ page }) => {
  await newBoard(page, ['A', 'B']);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'סטטוס', exact: true }).click();
  const cell = row(page, 'A').locator('[data-column-type="status"]');
  const fill = cell.locator('button').first();
  await expect(fill).toHaveCSS('box-shadow', 'none');
  const c = (await cell.boundingBox())!;
  const f = (await fill.boundingBox())!;
  expect(Math.abs(f.y - c.y)).toBeLessThan(1);
  expect(Math.abs(f.height - c.height)).toBeLessThan(1);
  // The row's bottom line is the same colour as the column lines.
  const rowLine = await row(page, 'A').evaluate((el) => getComputedStyle(el).borderBottomColor);
  const colLine = await cell.evaluate((el) => getComputedStyle(el).borderInlineEndColor);
  expect(rowLine).toBe(colLine);
});

test('the filter button counts the conditions, no chips', async ({ page }) => {
  await newBoard(page, ['A']);
  await page.getByTestId('toolbar-filter').click();
  await page.getByTestId('quick-__group__').getByRole('button').first().click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('filter-chip')).toHaveCount(0);
  await expect(page.getByTestId('toolbar-filter-count')).toHaveText('1');
  await expect(page.getByTestId('toolbar-filter')).toHaveText(/סינון\s*1/);
});
