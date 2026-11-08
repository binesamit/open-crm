// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod fix (mobilehead): on a phone the top of a board up to the table took more than half the screen and
 * stayed put. Now one compact bar sits in the shell's top bar (board name + view switch, search, tools, ⋯, +);
 * the save bar scrolls away with the rows. Measured at 390×844. Product decision: no description
 * line (⋯ → "תיאור הבורד") and no condition chips row above the rows (the tools sheet lists them).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const rows = (page: Page) => page.getByTestId('item-row');
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'patch', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `ראש מובייל ${tag}`, workspace_id: ws.id });
  await api('patch', `/boards/${board.id}`, { description: 'תיאור הבורד שנגלל יחד עם השורות' });
  // Enough rows to scroll well past the first screen.
  for (let i = 1; i <= 30; i++)
    await api('post', `/boards/${board.id}/items`, { name: `Row ${String(i).padStart(2, '0')} ${tag}` });
  return { board, tag };
};

test.beforeEach(async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
});

test('phone board: one compact bar, the table near the top, a small sticky area', async ({ page }) => {
  const { board, tag } = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, `Row 30 ${tag}`)).toBeAttached();

  // The bar lives in the shell's top bar: the board's name, the current view, search, tools, ⋯ and "+".
  const bar = page.getByTestId('mobile-board-bar');
  await expect(bar).toHaveAttribute('data-placement', 'shell');
  await expect(bar.getByTestId('mobile-board-name')).toHaveText(`ראש מובייל ${tag}`);
  for (const id of ['mobile-view-switch', 'mobile-search-open', 'mobile-filter-open', 'board-more', 'board-new-item'])
    await expect(bar.getByTestId(id)).toBeVisible();
  await expect(page.getByTestId('mobile-title')).toBeHidden();
  const barBox = (await bar.boundingBox())!;
  expect(barBox.y + barBox.height).toBeLessThanOrEqual(64);
  // The desktop rows are gone on a phone.
  await expect(page.getByTestId('view-tabs')).toHaveCount(0);
  await expect(page.getByTestId('board-toolbar')).toHaveCount(0);

  // The table's header row within the top ~25% of the screen (r18board: the view chips row sits above it, and
  // scrolls away); the first row well inside the first 250px.
  const header = page.getByTestId('mobile-header-row').first();
  expect((await header.boundingBox())!.y).toBeLessThan(844 * 0.25);
  expect((await rows(page).first().boundingBox())!.y).toBeLessThan(250);

  // no description line on a phone — ⋯ → "תיאור הבורד" opens the whole text in a sheet.
  await expect(page.getByTestId('board-description')).toHaveCount(0);
  await expect(page.getByTestId('board-description-add')).toHaveCount(0);
  await bar.getByTestId('board-more').click();
  await page.getByTestId('board-description-open').click();
  const about = page.getByTestId('board-description-dialog');
  await expect(about.getByTestId('board-description-input')).toHaveValue('תיאור הבורד שנגלל יחד עם השורות');
  await page.keyboard.press('Escape');
  await expect(about).toHaveCount(0);

  const scroll = page.getByTestId('board-scroll');
  await scroll.evaluate((el) => el.scrollBy(0, 400));
  await page.waitForTimeout(150);
  const scrollTop = (await scroll.boundingBox())!.y;

  // What stays put: the top bar and the table's own header row — together at most 120px.
  const stuck = (await header.boundingBox())!;
  expect(Math.abs(stuck.y - scrollTop)).toBeLessThan(2);
  expect(stuck.y + stuck.height).toBeLessThanOrEqual(120);
  await expect(bar).toBeInViewport();
});

test('phone board: the view switch, search and the tools sheet', async ({ page }) => {
  const { board, tag } = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, `Row 01 ${tag}`)).toBeVisible();

  // A new Kanban view from the view sheet's "+" (named in the system prompt), then back to the table.
  const viewSwitch = page.getByTestId('mobile-view-switch');
  const tableView = (await viewSwitch.getAttribute('data-view-name'))!;
  await viewSwitch.click();
  const sheet = page.getByTestId('mobile-view-sheet');
  await expect(sheet.getByTestId('mobile-view-option')).toHaveCount(1);
  await sheet.getByTestId('mobile-view-add').click();
  await page.getByRole('menuitem', { name: /קנבן/ }).click();
  const prompt = page.getByRole('dialog').filter({ has: page.getByRole('textbox') });
  await prompt.getByRole('textbox').fill(`קנבן ${tag}`);
  await prompt.getByRole('button', { name: 'אישור' }).click();
  await expect(viewSwitch).toHaveAttribute('data-view-name', `קנבן ${tag}`);
  await expect(page.getByTestId('mobile-table')).toHaveCount(0);
  await viewSwitch.click();
  await expect(sheet.getByTestId('mobile-view-option')).toHaveCount(2);
  await sheet.locator(`[data-testid="mobile-view-option"][data-view-name="${tableView}"] button`).first().click();
  await expect(sheet).toHaveCount(0);
  await expect(viewSwitch).toHaveAttribute('data-view-name', tableView);
  await expect(page.getByTestId('mobile-table')).toBeVisible();

  // Search opens inline over the bar, filters as you type, and folds back with the search kept on.
  await page.getByTestId('mobile-search-open').click();
  const field = page.getByTestId('toolbar-search');
  await expect(field).toBeFocused();
  await expect(viewSwitch).toHaveCount(0);
  await field.fill(`Row 07 ${tag}`);
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId('mobile-search-close').click();
  await expect(page.getByTestId('mobile-search-open')).toHaveAttribute('data-active', 'true');
  await expect(rows(page)).toHaveCount(1);
  await page.getByTestId('mobile-search-open').click();
  await page.getByTestId('toolbar-search-clear').click();
  await expect(rows(page)).toHaveCount(30);
  await page.getByTestId('mobile-search-close').click();

  // The tools sheet: every tool as a row (r15board: no Person button, no collapse-all, coloring in the gear); a
  // filter condition counts on the bar's badge and is listed at the top of the sheet (not above the rows).
  await page.getByTestId('mobile-filter-open').click();
  const tools = page.getByTestId('mobile-filter-sheet');
  for (const id of ['toolbar-filter', 'toolbar-sort', 'toolbar-group', 'toolbar-hide', 'toolbar-view-settings'])
    await expect(tools.getByTestId(id)).toBeVisible();
  for (const id of ['toolbar-person', 'toolbar-collapse-all', 'toolbar-coloring'])
    await expect(tools.getByTestId(id)).toHaveCount(0);
  await tools.getByTestId('toolbar-filter').click();
  await page.getByTestId('quick-__group__').getByRole('button').first().click();
  await expect(page.getByTestId('mobile-filter-count')).toHaveText('1');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(tools).toHaveCount(0);
  await expect(page.getByTestId('mobile-filter-chip')).toHaveCount(0);
  await page.getByTestId('mobile-filter-open').click();
  const active = tools.getByTestId('mobile-filter-active');
  await expect(active.getByTestId('mobile-filter-chip')).toHaveCount(1);
  // The chip's ✕ removes the condition.
  await active.getByTestId('mobile-filter-chip-clear').click();
  await expect(tools.getByTestId('mobile-filter-active')).toHaveCount(0);
  await expect(page.getByTestId('mobile-filter-count')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(30);
  // "clear all" in the sheet removes every condition at once.
  await tools.getByTestId('toolbar-filter').click();
  await page.getByTestId('quick-__group__').getByRole('button').first().click();
  await page.keyboard.press('Escape');
  await expect(active.getByTestId('mobile-filter-chip').first()).toBeVisible();
  await active.getByTestId('mobile-filter-clear-all').click();
  await expect(tools.getByTestId('mobile-filter-active')).toHaveCount(0);
  await expect(page.getByTestId('mobile-filter-count')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(30);
  await page.keyboard.press('Escape');
  await expect(tools).toHaveCount(0);

  // The sort panel opens from the sheet as a bottom sheet over it.
  await page.getByTestId('mobile-filter-open').click();
  await tools.getByTestId('toolbar-sort').click();
  await expect(page.getByTestId('sort-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sort-panel')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(tools).toHaveCount(0);
});
