// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod (product owner: the linked items were unreadable slivers): a connect-boards cell shows whole chips while they
 * fit, then "+N"; "+N" opens the full list — open an item, remove a link, add one (the picker). A column setting cuts
 * each name to X characters. Setup through the API; the UI is under test.
 */
const json = async <T>(res: { json: () => Promise<unknown> }) => (await res.json()) as T;
const cell = (page: Page, name: string, column: string) =>
  page.locator(`[data-testid="item-row"][data-item-name="${name}"]`).locator(`[data-column="${column}"]`);

const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = (await json<{ data: { id: string }[] }>(await page.request.get('/api/v1/workspaces', { headers })))
    .data[0]!.id;
  const stamp = Date.now().toString(36);
  const board = async (n: string) =>
    (
      await json<{ id: string }>(
        await page.request.post('/api/v1/boards', { headers, data: { name: `${n} ${stamp}`, workspace_id: ws } }),
      )
    ).id;
  const people = await board('צ׳יפים אנשים');
  const projects = await board('צ׳יפים פרויקטים');
  await page.request.post(`/api/v1/boards/${projects}/columns`, {
    headers,
    data: { id: 'team', title: 'צוות', type: 'board_relation', settings: { board_ids: [people] } },
  });
  const item = (boardId: string, n: string, cells: Record<string, unknown> = {}) =>
    page.request
      .post(`/api/v1/boards/${boardId}/items`, { headers, data: { name: n, cells } })
      .then((r) => json<{ id: string }>(r));
  const names = ['אביגיל אברהמי', 'בנימין ברקוביץ', 'גבריאלה גולדשטיין', 'דניאל דוידוביץ', 'הדסה הירשפלד', 'ורד וולך'];
  const ids: string[] = [];
  for (const n of names) ids.push((await item(people, n)).id);
  const big = await item(projects, 'פרויקט גדול', { team: { item_ids: ids } });
  return { headers, people, projects, names, big: big.id };
};

test('a relation cell: whole chips, then "+N" with the full list to open, remove and add', async ({ page }) => {
  test.setTimeout(90_000);
  const { projects, names } = await setup(page);
  await page.goto(`/a/demo/b/${projects}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
  const c = cell(page, 'פרויקט גדול', 'team');

  // Some whole chips, the rest behind "+N" (six long names never fit a table cell).
  const chips = c.getByTestId('relation-chip');
  await expect(chips.first()).toHaveText(names[0]!);
  const shown = await chips.count();
  expect(shown).toBeGreaterThan(0);
  expect(shown).toBeLessThan(names.length);
  const more = c.getByTestId('relation-more');
  await expect(more).toHaveText(`+${names.length - shown}`);
  // Each chip is whole: not cut by the cell.
  for (let i = 0; i < shown; i++) {
    const box = await chips.nth(i).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(box).toBe(true);
  }

  // "+N" lists all six; remove one there.
  await page.screenshot({ path: 'test-results/relchips-table.png' });
  await more.click();
  const list = page.getByTestId('relation-list');
  await expect(list.getByTestId('relation-list-row')).toHaveCount(names.length);
  await list
    .getByTestId('relation-list-row')
    .filter({ hasText: names[5]! })
    .getByTestId('relation-list-remove')
    .click();
  await expect(list.getByTestId('relation-list-row')).toHaveCount(names.length - 1);
  await page.keyboard.press('Escape');

  // "Add" opens the picker.
  await c.getByTestId('relation-more').click();
  await page.getByTestId('relation-list').getByTestId('relation-list-add').click();
  await expect(page.getByPlaceholder('חיפוש פריטים')).toBeVisible();
  await page.keyboard.press('Escape');

  // Opening an item from the list opens its card.
  await c.getByTestId('relation-more').click();
  await page.getByTestId('relation-list').getByRole('button', { name: names[4]!, exact: true }).click();
  await expect(page).toHaveURL(/\/i\//);
});

test('the column setting cuts each name to X characters (the full name in its tip)', async ({ page }) => {
  test.setTimeout(90_000);
  const { headers, people, projects, names } = await setup(page);
  await page.request.patch(`/api/v1/boards/${projects}/columns/team`, {
    headers,
    data: { settings: { board_ids: [people], allow_multiple: true, chip_max_chars: 4 } },
  });
  await page.goto(`/a/demo/b/${projects}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
  const first = cell(page, 'פרויקט גדול', 'team').getByTestId('relation-chip').first();
  await expect(first).toHaveText(`${[...names[0]!].slice(0, 4).join('')}…`);
  await expect(first).toHaveAttribute('data-tip', names[0]!);
});

test('on a phone (390px) the item card shows "+N" and its list fits the screen', async ({ page }) => {
  test.setTimeout(90_000);
  const { projects, big, names } = await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/demo/b/${projects}/i/${big}`);
  // A phone opens the card on its updates: the fields tab shows the columns.
  await page.getByTestId('item-card').getByRole('button', { name: 'שדות', exact: true }).click();
  const more = page.getByTestId('item-card').getByTestId('relation-more').first();
  await expect(more).toBeVisible({ timeout: 20_000 });
  await more.click();
  const list = page.getByTestId('relation-list');
  await expect(list.getByTestId('relation-list-row')).toHaveCount(names.length);
  const panel = await page.getByTestId('popover').filter({ has: list }).boundingBox();
  expect(panel).not.toBeNull();
  expect(panel!.x).toBeGreaterThanOrEqual(0);
  expect(panel!.x + panel!.width).toBeLessThanOrEqual(390 + 0.5);
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(844 + 0.5);
  await page.screenshot({ path: 'test-results/relchips-phone.png' });
});

test('round 2: one linked item wider than the column ends in "…", its full name in the tip', async ({ page }) => {
  test.setTimeout(90_000);
  const { headers, people, projects } = await setup(page);
  const long = 'שם ארוך מאוד של פריט מקושר שלא נכנס ברוחב של העמודה בשום אופן';
  const one = await page.request
    .post(`/api/v1/boards/${people}/items`, { headers, data: { name: long } })
    .then((r) => json<{ id: string }>(r));
  await page.request.post(`/api/v1/boards/${projects}/items`, {
    headers,
    data: { name: 'פרויקט קטן', cells: { team: { item_ids: [one.id] } } },
  });
  await page.goto(`/a/demo/b/${projects}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
  const chip = cell(page, 'פרויקט קטן', 'team').getByTestId('relation-chip');
  await expect(chip).toHaveCount(1);
  await expect(cell(page, 'פרויקט קטן', 'team').getByTestId('relation-more')).toHaveCount(0);
  // Cut with an ellipsis inside the cell (not clipped by its edge), and the whole name in the tip.
  await expect(chip).toHaveCSS('text-overflow', 'ellipsis');
  expect(await chip.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  const [c, box] = await Promise.all([
    chip.boundingBox(),
    cell(page, 'פרויקט קטן', 'team').getByTestId('cell-value').boundingBox(),
  ]);
  expect(c!.x).toBeGreaterThanOrEqual(box!.x - 1);
  expect(c!.x + c!.width).toBeLessThanOrEqual(box!.x + box!.width + 1);
  await expect(chip).toHaveAttribute('data-tip', long);
});
