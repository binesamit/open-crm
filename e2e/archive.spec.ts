// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, rowMenu, signIn } from './helpers';

/** M3 step 5a (07 §5.1): archive from the menus, the archive page, restore; an archived board's banner. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

test('archive an item from its menu and restore it from the archive page', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  const boardName = `ארכיון ${Date.now().toString(36)}`;
  await page.getByLabel('שם הבורד').fill(boardName);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(boardName);
  const boardUrl = page.url();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['Keep', 'Shelve']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }

  await rowMenu(page, row(page, 'Shelve'), 'העברה לארכיון');
  await expect(row(page, 'Shelve')).toHaveCount(0);
  await expect(page.getByTestId('toast').filter({ hasText: 'הועבר לארכיון' })).toBeVisible();

  await page.getByTestId('profile-menu').click();
  await page.getByTestId('menu-archive').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ארכיון');
  const entry = page.locator('[data-testid="archive-row"][data-name="Shelve"]').first();
  await expect(entry).toContainText(boardName);
  await entry.getByTestId('archive-restore').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'הוחזר מהארכיון' })).toBeVisible();

  await page.goto(boardUrl);
  await expect(row(page, 'Shelve')).toBeVisible();
});

test('an archived board leaves the sidebar and opens with a restore banner', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  const boardName = `מדף ${Date.now().toString(36)}`;
  await page.getByLabel('שם הבורד').fill(boardName);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(boardName);
  const boardUrl = page.url();

  const sidebarRow = page.getByTestId('board-row').filter({ hasText: boardName });
  await sidebarRow.hover();
  await sidebarRow.getByRole('button', { name: /^פעולות ל/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'העברה לארכיון' }).click();
  await expect(page.getByTestId('board-row').filter({ hasText: boardName })).toHaveCount(0);

  await page.goto(boardUrl);
  const banner = page.getByTestId('archived-banner');
  await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: 'שחזור' }).click();
  await expect(banner).toHaveCount(0);
  await expect(page.getByTestId('board-row').filter({ hasText: boardName })).toBeVisible();
});
