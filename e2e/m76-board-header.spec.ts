// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * M7.6 — the board header and toolbar: one ⋯ menu (N20), members' avatars (N5), the split add button whose
 * arrow adds a group with a colour (N21), and a chip per active filter condition (N2).
 */
const newBoard = async (page: Page, prefix: string) => {
  const name = `${prefix} ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Alpha');
  await add.press('Enter');
  await expect(page.locator('[data-testid="item-row"][data-item-name="Alpha"]')).toBeVisible();
  return name;
};

test('⋯ menu, permissions, add a group from the split button', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, 'כותרת');

  // N20: the old header buttons live in one ⋯ menu; only automations and "add item" stay outside.
  await expect(page.getByTestId('board-activity-open')).toHaveCount(0);
  await expect(page.getByTestId('toolbar-export')).toHaveCount(0);
  const more = page.getByTestId('board-more');
  await more.click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /^יומן פעילות/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'הרשאות', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^ייצוא/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^התראות/ })).toBeVisible();
  await menu.getByRole('menuitem', { name: /^יומן פעילות/ }).click();
  await expect(page.getByTestId('board-activity')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-activity')).toBeHidden();

  // Export is a submenu (Excel / CSV).
  await more.click();
  await page.getByRole('menuitem', { name: /^ייצוא/ }).click();
  await expect(page.getByRole('menuitem', { name: 'ייצוא ל-CSV', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // Notifications: a submenu of radios; the ⋯ carries the state.
  await expect(more).toHaveAttribute('data-notif-mode', 'all');
  await more.click();
  await page.getByRole('menuitem', { name: /^התראות/ }).click();
  await expect(page.getByRole('menuitemradio', { name: 'לקבל התראות מהבורד' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // r23ui: no members' avatars in the header any more — permissions open from ⋯ → הרשאות.
  await expect(page.getByTestId('board-avatars')).toHaveCount(0);
  await more.click();
  await page.getByTestId('board-permissions').click();
  await expect(page.getByTestId('permissions-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('permissions-dialog')).toBeHidden();

  // N21: the add button's arrow adds a group — a name and a colour.
  await expect(page.getByTestId('board-section')).toHaveCount(1);
  await page.getByTestId('add-group-open').click();
  const panel = page.getByTestId('add-group-panel');
  await expect(panel).toBeVisible();
  await page.getByTestId('add-group-name').fill('שלב ב');
  const purple = panel.locator('[data-testid="add-group-color"][data-color="purple"]');
  await purple.click();
  await expect(purple).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('add-group-submit').click();
  await expect(panel).toBeHidden();
  await expect(page.getByTestId('board-section')).toHaveCount(2);
  await expect(page.getByTestId('board-section').filter({ hasText: 'שלב ב' })).toHaveCount(1);

  // The main part still adds an item.
  await page.getByTestId('board-new-item').click();
  await expect(page.getByTestId('item-row')).toHaveCount(2);
});

test('the filter button counts the conditions (no chips)', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, 'צ׳יפים');

  // A quick filter on the group (every board has groups) → the filter button says "סינון 1".
  await page.getByTestId('toolbar-filter').click();
  await page.getByTestId('quick-__group__').getByRole('button').first().click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('filter-chip')).toHaveCount(0);
  await expect(page.getByTestId('toolbar-filter-count')).toHaveText('1');

  // r15board: no Person button in the toolbar any more (the filter covers it).
  await expect(page.getByTestId('toolbar-person')).toHaveCount(0);
  await expect(page.getByTestId('save-bar')).toBeVisible();

  // Resetting the draft clears the count.
  await page.getByTestId('view-reset').click();
  await expect(page.getByTestId('toolbar-filter-count')).toHaveCount(0);
  await expect(page.getByTestId('toolbar-filter')).toHaveText('סינון');
});

test('phones: the title, then ⋯ and the add button in one row', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, 'מובייל');
  await page.setViewportSize({ width: 390, height: 844 });
  const more = page.getByTestId('board-more');
  const add = page.getByTestId('board-new-item');
  await expect(more).toBeVisible();
  await expect(add).toBeVisible();
  await expect(page.getByTestId('board-avatars')).toHaveCount(0);
  const [m, a] = [(await more.boundingBox())!, (await add.boundingBox())!];
  expect(Math.abs(m.y + m.height / 2 - (a.y + a.height / 2))).toBeLessThan(4);
  // Automations move into the menu on phones.
  await more.click();
  await expect(page.getByRole('menuitem', { name: 'אוטומציות', exact: true })).toBeVisible();
});
