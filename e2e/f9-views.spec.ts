// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * f9 views (product owner: "on the phone the views bar at the top should be a dropdown menu"): on a phone the
 * board's views are ONE dropdown button (the current view's icon + name + chevron); it opens the app's menu with
 * every view, the current view's actions, "+ new view" and "all views". Desktop keeps the segmented tabs.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

type Json = { id: string; [k: string]: unknown };

const setup = async (page: Page, name: string) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async <T = Json>(method: 'get' | 'post' | 'patch' | 'delete', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api('post', '/boards', { name: `${name} ${tag}`, workspace_id: ws.id });
  await api('post', `/boards/${board.id}/items`, { name: `Row ${tag}` });
  await api('post', `/boards/${board.id}/views`, { name: `קנבן ${tag}`, type: 'kanban' });
  await api('post', `/boards/${board.id}/views`, { name: `לוח שנה ${tag}`, type: 'calendar' });
  return { api, board, tag };
};

test('phone: the views are one dropdown, the tabs are hidden, switching works', async ({ page }) => {
  const { board, tag } = await setup(page, 'f9 תצוגות');
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto(`/a/demo/b/${board.id}`);

  const dropdown = page.getByTestId('mobile-view-dropdown');
  await expect(dropdown).toBeVisible();
  await expect(page.getByTestId('view-tabs')).toHaveCount(0);
  await expect(page.getByTestId('mobile-view-tabs')).toHaveCount(0);
  // It fits the screen; nothing scrolls the page sideways.
  const box = (await dropdown.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(361);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(361);

  // The menu lists every view (the current one marked) and the tab bar's actions.
  await dropdown.click();
  const menu = page.getByTestId('mobile-view-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByTestId('mobile-view-item')).toHaveCount(3);
  await expect(menu.locator('[data-testid="mobile-view-item"][aria-current="true"]')).toHaveCount(1);
  await expect(menu.getByTestId('mobile-view-actions')).toBeVisible();
  await expect(menu.getByTestId('mobile-view-add-menu')).toBeVisible();
  await expect(menu.getByTestId('mobile-view-manage')).toBeVisible();
  // RTL: the menu stays on screen.
  const m = (await menu.boundingBox())!;
  expect(m.x).toBeGreaterThanOrEqual(0);
  expect(m.x + m.width).toBeLessThanOrEqual(361);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Switching: the dropdown shows the chosen view, in the Kanban and Calendar views too.
  for (const name of [`קנבן ${tag}`, `לוח שנה ${tag}`]) {
    await dropdown.click();
    await menu.getByTestId('mobile-view-item').filter({ hasText: name }).click();
    await expect(menu).toHaveCount(0);
    await expect(dropdown).toHaveAttribute('data-view-name', name);
    await expect(page.getByTestId('mobile-view-switch')).toHaveAttribute('data-view-name', name);
  }

  // "+ new view" offers the view types; "all views" opens the views sheet.
  await dropdown.click();
  await menu.getByTestId('mobile-view-add-menu').click();
  await expect(menu.getByTestId('mobile-view-add-table')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await dropdown.click();
  await menu.getByTestId('mobile-view-manage').click();
  await expect(page.getByTestId('mobile-view-sheet')).toBeVisible();
  await expect(page.getByTestId('mobile-view-option')).toHaveCount(3);
});

test('phone: many views get the menu search', async ({ page }) => {
  const { api, board, tag } = await setup(page, 'f9 חיפוש תצוגות');
  for (let i = 1; i <= 6; i++)
    await api('post', `/boards/${board.id}/views`, { name: `טבלה ${i} ${tag}`, type: 'table' });
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('mobile-view-dropdown').click();
  const menu = page.getByTestId('mobile-view-menu');
  const search = menu.getByTestId('menu-search');
  await search.click();
  await search.fill(`טבלה 4 ${tag}`);
  await expect(menu.getByTestId('mobile-view-item')).toHaveCount(1);
  await menu.getByTestId('mobile-view-item').click();
  await expect(page.getByTestId('mobile-view-dropdown')).toHaveAttribute('data-view-name', `טבלה 4 ${tag}`);
});

test('desktop keeps the segmented view tabs', async ({ page }) => {
  const { board } = await setup(page, 'f9 דסקטופ');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(page.getByTestId('view-tabs')).toBeVisible();
  await expect(page.getByTestId('view-tab')).toHaveCount(3);
  await expect(page.getByTestId('mobile-view-dropdown')).toHaveCount(0);
});
