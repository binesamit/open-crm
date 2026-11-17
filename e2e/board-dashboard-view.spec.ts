// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Round 15 (r15dash) — prod fixes:
 * 1. a board's Dashboard view: added from the "+" menu, widgets from the dashboards registry over this board,
 *    narrowed by the view's toolbar, kept with the view (save → reload);
 * 2. widgets read items, subitems or both (the sub-board's columns in the pickers);
 * 3. the Workload view takes its people / dates from the subitems too; a subitem shows under its parent's name.
 * Everything set in the UI; the data comes through the API (the UI under test is the views).
 */
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const newView = async (page: Page, type: string, name: string) => {
  await page.getByTestId('view-add').click();
  await page.getByTestId(`view-add-${type}`).click();
  await page.getByRole('dialog').getByRole('textbox').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('view-tab').filter({ hasText: name })).toHaveAttribute('aria-selected', 'true');
};

/** A board with an amount column, two items and three subitems (with the sub-board's own amount, person, date). */
const makeBoard = async (page: Page) => {
  const { headers, meId } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', {
      headers,
      data: { name: `דשבורד בורד ${Date.now().toString(36)}`, workspace_id: ws },
    })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/columns`, {
    headers,
    data: { id: 'amount', title: 'סכום', type: 'numbers' },
  });
  const item = async (name: string, amount: number) =>
    (
      (await (
        await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name, cells: { amount } } })
      ).json()) as { id: string }
    ).id;
  const first = await item('ראשון', 100);
  const second = await item('שני', 50);
  // The first subitem creates the sub-board (person, status, date); then an amount column like the board's.
  const s1 = (await (
    await page.request.post(`/api/v1/items/${first}/subitems`, { headers, data: { name: 'תת א' } })
  ).json()) as { id: string };
  const subId = (
    (await (await page.request.get(`/api/v1/boards/${board.id}`, { headers })).json()) as {
      subitems_board_id: string;
    }
  ).subitems_board_id;
  await page.request.post(`/api/v1/boards/${subId}/columns`, {
    headers,
    data: { id: 'samount', title: 'סכום', type: 'numbers' },
  });
  let today = iso(new Date());
  while ([5, 6].includes(new Date(`${today}T12:00:00`).getDay())) {
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() + 1);
    today = iso(d);
  }
  const me = { persons_and_teams: [{ id: meId, kind: 'person' }] };
  const cells = (amount: number) => ({ samount: amount, person: me, date: { date: today } });
  for (const [k, v] of Object.entries(cells(7)))
    await page.request.put(`/api/v1/items/${s1.id}/cells/${k}`, { headers, data: { value: v } });
  await page.request.post(`/api/v1/items/${first}/subitems`, { headers, data: { name: 'תת ב', cells: cells(3) } });
  await page.request.post(`/api/v1/items/${second}/subitems`, { headers, data: { name: 'תת ג', cells: cells(20) } });
  return { id: board.id, meId, today };
};

const numbers = (page: Page) => page.locator('[data-testid="widget"][data-type="numbers"]').first();

test('a board Dashboard view over items and subitems, narrowed by the view, kept with it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const board = await makeBoard(page);
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(page.locator('[data-testid="item-row"][data-item-name="ראשון"]')).toBeVisible();

  await newView(page, 'dashboard', 'סקירה');
  await expect(page.getByTestId('dashboard-board-view')).toBeVisible();
  await expect(page.getByTestId('dashboard-empty')).toBeVisible();

  // A numbers widget from the registry: counts the board's items.
  await page.getByTestId('dashboard-add-widget').click();
  await page.getByTestId('add-widget-numbers').click();
  await expect(numbers(page).getByTestId('widget-number')).toHaveAttribute('data-value', '2');

  // Its settings: subitems, summing the sub-board's amount (offered because the source reads subitems).
  await numbers(page).hover();
  await numbers(page)
    .getByRole('button', { name: /^פעולות ל/ })
    .click();
  await page.getByTestId('widget-menu-settings').click();
  await page.getByTestId('widget-source-subitems').click();
  await page.getByTestId('widget-measure-fn').click();
  await page.getByRole('menuitemradio', { name: 'סכום' }).click();
  await page.getByTestId('widget-measure-column').click();
  await page.getByRole('menuitemradio', { name: /^סכום ·/ }).click();
  await page.getByTestId('widget-settings-save').click();
  await expect(numbers(page).getByTestId('widget-number')).toHaveAttribute('data-value', '30');

  // The view's search narrows the widgets: only the subitems under "ראשון".
  await page.getByTestId('toolbar-search').fill('ראשון');
  await expect(numbers(page).getByTestId('widget-number')).toHaveAttribute('data-value', '10');
  await page.getByTestId('toolbar-search-clear').click();
  await expect(numbers(page).getByTestId('widget-number')).toHaveAttribute('data-value', '30');

  // The widgets are the view's settings: saved with it, back after a reload.
  await page.getByTestId('view-save').click();
  await expect(page.getByTestId('view-save')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('dashboard-board-view')).toBeVisible();
  await expect(numbers(page).getByTestId('widget-number')).toHaveAttribute('data-value', '30');

  // "Items and subitems" in a table widget: a subitem under its parent's name.
  await page.getByTestId('dashboard-add-widget').click();
  await page.getByTestId('add-widget-table').click();
  const table = page.locator('[data-testid="widget"][data-type="table"]').first();
  await table.hover();
  await table.getByRole('button', { name: /^פעולות ל/ }).click();
  await page.getByTestId('widget-menu-settings').click();
  await page.getByTestId('widget-source-both').click();
  await page.getByTestId('widget-settings-save').click();
  await expect(table.getByTestId('widget-table-row')).toHaveCount(5);
  await expect(
    table.locator('[data-testid="widget-table-row"][data-name="תת ג"]').getByTestId('widget-row-parent'),
  ).toContainText('שני');
});

test('workload from subitems: their people and dates, named under their parent', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const board = await makeBoard(page);
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(page.locator('[data-testid="item-row"][data-item-name="ראשון"]')).toBeVisible();

  await newView(page, 'workload', 'עומס תתים');
  // The items have no people / dates: nothing to show from them.
  await expect(page.getByTestId('workload-no-column')).toBeVisible();

  await page.getByTestId('toolbar-view-settings').click();
  await page.getByTestId('workload-source').click();
  await page.getByTestId('workload-source-subitems').click();
  await expect(page.getByTestId('workload-sub-columns')).toBeVisible();
  await page.keyboard.press('Escape');

  await expect(page.getByTestId('workload')).toHaveAttribute('data-source', 'subitems');
  const cell = page.locator(
    `[data-testid="workload-row"][data-person="${board.meId}"] [data-testid="workload-cell"][data-bucket="${board.today}"]`,
  );
  await expect(cell).toHaveAttribute('data-load', '3');
  // The tooltip names each subitem under its parent (our tooltip, `data-tip` — not the browser's `title`).
  await expect(cell).toHaveAttribute('data-tip', /ראשון › תת א/);
  await cell.click();
  const entries = page.getByTestId('workload-popover').getByTestId('workload-item');
  await expect(entries).toHaveCount(3);
  await expect(entries.filter({ hasText: 'תת ג' })).toHaveAttribute('data-parent-name', 'שני');
  await expect(entries.filter({ hasText: 'תת ג' }).getByTestId('workload-item-parent')).toContainText('שני');

  // The view's search narrows the subitems to those under the items it shows.
  await page.keyboard.press('Escape');
  await page.getByTestId('toolbar-search').fill('שני');
  await expect(cell).toHaveAttribute('data-load', '1');
});
