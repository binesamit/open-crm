// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Owner fixes, round 2 (board): the search finds subitems at every depth, the view sorts the subitems too, and
 * "+ add" sits right under the last row — above the summary — in groups and in subitem tables.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const subAdd = (page: Page) => page.getByLabel('+ הוספת תת-פריט');
const top = async (page: Page, name: string) => (await row(page, name).boundingBox())!.y;
/** Names top to bottom. */
const order = async (page: Page, names: string[]) => {
  const tops = await Promise.all(names.map(async (n) => [n, await top(page, n)] as const));
  return tops.sort((a, b) => a[1] - b[1]).map(([n]) => n);
};

const newBoard = async (page: Page, items: string[]) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תיקונים 2 ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of items) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }
};

/** Opens `parent`'s subitems and adds `names` to them (the first "add subitem" field = the innermost open one). */
const addSubs = async (page: Page, parent: string, names: string[]) => {
  await row(page, parent).hover();
  await row(page, parent).getByTestId('subitems-toggle').click();
  const field = subAdd(page).first();
  for (const n of names) {
    await field.fill(n);
    await field.press('Enter');
    await expect(row(page, n)).toBeVisible();
  }
};

test('the board search finds subitems and sub-subitems, and opens the path to them', async ({ page }) => {
  await newBoard(page, ['P1', 'P2']);
  await addSubs(page, 'P1', ['step one', 'other step']);
  await addSubs(page, 'step one', ['zulu deep']);
  // Close everything again.
  await row(page, 'step one').getByTestId('subitems-toggle').click();
  await row(page, 'P1').getByTestId('subitems-toggle').click();
  await expect(row(page, 'step one')).toHaveCount(0);

  // No "subitems too" switch needed: the search reads the subitems at every depth.
  await page.getByTestId('toolbar-search').fill('zulu');
  await expect(row(page, 'P1')).toBeVisible();
  await expect(row(page, 'P2')).toHaveCount(0);
  await expect(row(page, 'step one')).toBeVisible();
  await expect(row(page, 'zulu deep')).toBeVisible();
  await expect(row(page, 'other step')).toHaveCount(0);

  // A first-level subitem by name too.
  await page.getByTestId('toolbar-search').fill('other step');
  await expect(row(page, 'P1')).toBeVisible();
  await expect(row(page, 'other step')).toBeVisible();
  await expect(row(page, 'P2')).toHaveCount(0);

  // An item that matches by its own name stays closed (nothing below it matches).
  await page.getByTestId('toolbar-search').fill('P2');
  await expect(row(page, 'P2')).toBeVisible();
  await expect(row(page, 'P1')).toHaveCount(0);

  await page.getByTestId('toolbar-search').fill('');
  await expect(row(page, 'P1')).toBeVisible();
  await expect(row(page, 'P2')).toBeVisible();
});

test('the view sorts the subitems by a sub-board column; no sort keeps the manual order', async ({ page }) => {
  await newBoard(page, ['Parent']);
  await addSubs(page, 'Parent', ['Bravo', 'Alpha', 'Charlie']);
  expect(await order(page, ['Alpha', 'Bravo', 'Charlie'])).toEqual(['Bravo', 'Alpha', 'Charlie']);

  // The sort panel has its own section for the subitems.
  await page.getByTestId('toolbar-sort').click();
  await expect(page.getByTestId('subsort-section')).toBeVisible();
  await page.getByTestId('subsort-add').click();
  const level = page.getByTestId('subsort-row');
  await expect(level).toContainText('תת-פריט');
  await expect.poll(() => order(page, ['Alpha', 'Bravo', 'Charlie'])).toEqual(['Alpha', 'Bravo', 'Charlie']);
  // The items' own sort is untouched.
  await expect(page.getByTestId('sort-row')).toHaveCount(0);

  await level.getByRole('button', { name: 'יורד' }).click();
  await expect.poll(() => order(page, ['Alpha', 'Bravo', 'Charlie'])).toEqual(['Charlie', 'Bravo', 'Alpha']);
  await page.keyboard.press('Escape');

  // Sorted subitems don't drag (the order is the sort's).
  await row(page, 'Alpha').hover();
  await expect(row(page, 'Alpha').getByTestId('subitem-drag')).toHaveCount(0);

  // Saved with the view (on the default table: as a new view), still sorted after a reload.
  await page.getByTestId('view-save').click();
  await page.getByRole('dialog').getByRole('textbox').fill('סאב ממוינים');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('view-save')).toHaveCount(0);
  await page.reload();
  // Subitems start closed on every visit (product decision) — open them again.
  await row(page, 'Parent').getByTestId('subitems-toggle').click();
  await expect(row(page, 'Alpha')).toBeVisible();
  expect(await order(page, ['Alpha', 'Bravo', 'Charlie'])).toEqual(['Charlie', 'Bravo', 'Alpha']);

  // Removing the level brings back the manual order.
  await page.getByTestId('toolbar-sort').click();
  await page.getByTestId('subsort-row').getByRole('button', { name: 'הסרת מיון' }).click();
  await expect.poll(() => order(page, ['Alpha', 'Bravo', 'Charlie'])).toEqual(['Bravo', 'Alpha', 'Charlie']);
});

test('"+ add" sits under the last row and above the summary — in groups and subitems', async ({ page }) => {
  await newBoard(page, ['First', 'Last']);
  const addItem = page.getByPlaceholder(/\+ הוספת/).first();
  const summary = page.getByTestId('summary-row').first();
  await expect(summary).toBeVisible();
  const addBox = (await addItem.boundingBox())!;
  expect(addBox.y).toBeGreaterThan(await top(page, 'Last'));
  expect(addBox.y).toBeLessThan((await summary.boundingBox())!.y);

  await addSubs(page, 'Last', ['sub a', 'sub b']);
  const subSummary = page.getByTestId('subitems-summary');
  await expect(subSummary).toBeVisible();
  const subAddBox = (await subAdd(page).boundingBox())!;
  expect(subAddBox.y).toBeGreaterThan(await top(page, 'sub b'));
  expect(subAddBox.y).toBeLessThan((await subSummary.boundingBox())!.y);
});
