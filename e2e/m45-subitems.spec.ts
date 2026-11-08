// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, rowMenu, signIn } from './helpers';

/** M4.5 subitems: "add below" in place, drag to reorder, the subitems' footer. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
/** Subitem names top to bottom. */
const order = async (page: Page, names: string[]) => {
  const tops = await Promise.all(names.map(async (n) => [n, (await row(page, n).boundingBox())!.y] as const));
  return tops.sort((a, b) => a[1] - b[1]).map(([n]) => n);
};

test('subitems: add below in place, drag to reorder, footer', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`סדר סאב ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Parent');
  await add.press('Enter');
  await row(page, 'Parent').hover();
  await row(page, 'Parent').getByTestId('subitems-toggle').click();
  const subAdd = page.getByLabel('+ הוספת תת-פריט');
  for (const name of ['A', 'B', 'C']) {
    await subAdd.fill(name);
    await subAdd.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }

  // The subitems have their own footer row.
  await expect(page.getByTestId('subitems-summary')).toBeVisible();

  // "Add below" on A puts the new subitem right after A, not at the end.
  await rowMenu(page, row(page, 'A'), 'הוספת פריט מתחת');
  await expect(row(page, 'פריט חדש')).toBeVisible();
  expect(await order(page, ['A', 'B', 'C', 'פריט חדש'])).toEqual(['A', 'פריט חדש', 'B', 'C']);

  // Drag C by its handle onto the top half of A: C goes first.
  await row(page, 'C').hover();
  const handle = row(page, 'C').getByTestId('subitem-drag');
  const target = (await row(page, 'A').boundingBox())!;
  await handle.dragTo(row(page, 'A'), { targetPosition: { x: target.width / 2, y: 4 } });
  await expect.poll(() => order(page, ['A', 'B', 'C', 'פריט חדש'])).toEqual(['C', 'A', 'פריט חדש', 'B']);

  // Kept after a reload.
  await page.reload();
  // Subitems start closed on every visit (product decision) — open them again.
  await row(page, 'Parent').getByTestId('subitems-toggle').click();
  await expect(row(page, 'C')).toBeVisible();
  expect(await order(page, ['A', 'B', 'C', 'פריט חדש'])).toEqual(['C', 'A', 'פריט חדש', 'B']);
});

test('filters find items through their subitems and show only the matching ones', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`סינון סאב ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['P1', 'P2']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }
  const addSubs = async (parent: string, names: string[]) => {
    await row(page, parent).hover();
    await row(page, parent).getByTestId('subitems-toggle').click();
    const field = page.getByLabel('+ הוספת תת-פריט');
    for (const n of names) {
      await field.fill(n);
      await field.press('Enter');
      await expect(row(page, n)).toBeVisible();
    }
    await row(page, parent).getByTestId('subitems-toggle').click(); // close again
    await expect(row(page, names[0]!)).toHaveCount(0);
  };
  await addSubs('P1', ['alpha task', 'other task']);
  await addSubs('P2', ['beta task']);

  // Search by a subitem's name (owner fix 2: the search always reads subitems): P1, opened, with only that subitem.
  await page.getByTestId('toolbar-search').fill('alpha');
  await expect(row(page, 'P1')).toBeVisible();
  await expect(row(page, 'P2')).toHaveCount(0);
  await expect(row(page, 'alpha task')).toBeVisible();
  await expect(row(page, 'other task')).toHaveCount(0);

  // The subitems' columns are offered in the advanced filter.
  await page.getByTestId('toolbar-filter').click();
  const panel = page.getByTestId('filter-panel');
  await panel.getByTestId('filter-rail-advanced').click();
  await panel.getByTestId('filter-add-rule').click();
  await panel.getByTestId('filter-rule').last().getByTestId('rule-column').click();
  await expect(page.getByRole('menuitemradio', { name: 'תת-פריט: סטטוס' })).toBeVisible();
  await page.keyboard.press('Escape');

  // Clearing the search shows everything, closed as before.
  await page.keyboard.press('Escape');
  await page.getByTestId('toolbar-search').fill('');
  await expect(row(page, 'P2')).toBeVisible();
  await expect(row(page, 'alpha task')).toHaveCount(0);
});
