// SPDX-License-Identifier: AGPL-3.0-only
import { type Browser, expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, rowMenu, signIn } from './helpers';
import { WEB_URL } from './stack';

/** M4 step 1 (01 §4): two browsers on one board — a change in one shows in the other within a second. */
const LIVE_MS = 1500; // < 1s target + the 150ms flush + the refetch

const second = async (browser: Browser, url: string) => {
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  const page = await context.newPage();
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto(url);
  return page;
};

const live = (page: Page) => expect(page.getByTestId('board-live')).toHaveAttribute('data-live', 'on');
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

test('items created and deleted in one browser appear in the other', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`חי ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByPlaceholder(/\+ הוספת/).first()).toBeVisible();
  const other = await second(browser, page.url());
  await live(page);
  await live(other);

  const name = `Live ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  await expect(row(page, name)).toBeVisible();
  await expect(row(other, name)).toBeVisible({ timeout: LIVE_MS });

  await rowMenu(other, row(other, name), /^מחיקה/);
  await other.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row(other, name)).toHaveCount(0);
  await expect(row(page, name)).toHaveCount(0, { timeout: LIVE_MS });
  await other.context().close();
});

test('a view saved elsewhere under my unsaved draft shows "updated by someone else"', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תצוגה חיה ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByPlaceholder(/\+ הוספת/).first()).toBeVisible();
  // A view of its own (the default table never saves changes).
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: /טבלה/ }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('משותפת');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('view-tab').filter({ hasText: 'משותפת' })).toHaveAttribute('aria-selected', 'true');
  const other = await second(browser, page.url());
  await other.getByTestId('view-tab').filter({ hasText: 'משותפת' }).click();
  await live(page);
  await live(other);

  // A sort is a view change (round 11: the search is the board's, not a view draft).
  await other.getByTestId('toolbar-sort').click();
  await other.getByTestId('sort-add').click();
  await other.keyboard.press('Escape');
  await expect(other.getByTestId('save-bar')).toBeVisible();

  await page.getByTestId('toolbar-sort').click();
  await page.getByTestId('sort-add').click();
  await page.getByTestId('sort-row').getByRole('button', { name: 'יורד' }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('view-save').click();
  await expect(page.getByTestId('save-bar')).toBeHidden();

  const banner = other.getByTestId('view-outdated');
  await expect(banner).toBeVisible({ timeout: LIVE_MS });
  await banner.getByTestId('view-outdated-use-new').click();
  await expect(banner).toBeHidden();
  await expect(other.getByTestId('save-bar')).toBeHidden();
  await expect(other.getByTestId('toolbar-sort')).toContainText('1');
  await other.context().close();
});
