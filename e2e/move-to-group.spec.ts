// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Locator, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn, pickGroupColumn } from './helpers';

/**
 * Fix: (board), the product owner's items:
 * 1 — grouped by a column, "move to group" lists every value of the column (all status labels), not only the
 *     sections shown.
 * 2 — relative date filters: quick "today" / "this week" chips and "N days ago" in the builder, kept relative.
 * 3 — a formula whose result is an https address is a link (safe, new tab).
 * 4 — a mirror refreshes live when its source item on another board changes.
 * 5 — search fields show an X that clears them.
 * 6 — map pins do not move on hover; a click opens a window with the item's card and "open item".
 * Setup goes through the API; the UI is what is under test.
 */
const json = async <T>(res: { json: () => Promise<unknown> }) => (await res.json()) as T;
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const nameCell = (page: Page, name: string) => row(page, name).first().locator('[data-cell="-1"]');
const cell = (page: Page, name: string, column: string) => row(page, name).locator(`[data-column="${column}"]`);

const LABELS = [
  { id: 0, label: 'בעבודה', color: 'yellow', index: 0 },
  { id: 1, label: 'הושלם', color: 'forest', index: 1, is_done: true },
  { id: 2, label: 'תקוע', color: 'crimson', index: 2 },
];

const isoDay = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const setup = async (page: Page, name: string) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = (await json<{ data: { id: string }[] }>(await page.request.get('/api/v1/workspaces', { headers })))
    .data[0]!.id;
  const board = async (n: string) =>
    (
      await json<{ id: string }>(
        await page.request.post('/api/v1/boards', { headers, data: { name: n, workspace_id: ws } }),
      )
    ).id;
  const col = (boardId: string, id: string, type: string, settings?: unknown) =>
    page.request.post(`/api/v1/boards/${boardId}/columns`, {
      headers,
      data: { id, title: id, type, ...(settings ? { settings } : {}) },
    });
  const item = (boardId: string, n: string, cells: Record<string, unknown> = {}) =>
    page.request
      .post(`/api/v1/boards/${boardId}/items`, { headers, data: { name: n, cells } })
      .then((r) => json<{ id: string }>(r));
  return { headers, board, col, item, name };
};

const openBoard = async (page: Page, boardId: string) => {
  await page.goto(`/a/demo/b/${boardId}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
};

const openMoveMenu = async (page: Page, target: Locator) => {
  await expect(async () => {
    await page.keyboard.press('Escape');
    await target.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'העברה לקבוצה' }).click({ timeout: 1000 });
  }).toPass();
  return page.getByRole('menu');
};

test('1: "move to group" offers every value of the grouping column', async ({ page }) => {
  const s = await setup(page, 'r10');
  const boardId = await s.board(`סבב10 קבוצות ${Date.now().toString(36)}`);
  await s.col(boardId, 'st', 'status', { labels: LABELS });
  await s.item(boardId, 'Alpha', { st: { index: 0 } });
  await s.item(boardId, 'Beta', { st: { index: 0 } });
  await openBoard(page, boardId);
  await page.getByTestId('toolbar-group').click();
  await pickGroupColumn(page, 'st');
  await page.keyboard.press('Escape');
  // One section is shown (everything is "בעבודה")…
  await expect(page.getByTestId('board-section')).toHaveCount(1);
  // …but the menu offers the other labels and "no value".
  const menu = await openMoveMenu(page, nameCell(page, 'Alpha'));
  await expect(menu.getByTestId('move-section')).toHaveCount(3);
  await menu.getByRole('menuitem', { name: 'תקוע', exact: true }).click();
  await expect(page.getByTestId('board-section')).toHaveCount(2);
  await expect
    .poll(async () => {
      const items = (
        await json<{ data: { name: string; cells: Record<string, { value: unknown }> }[] }>(
          await page.request.get(`/api/v1/boards/${boardId}/items`, { headers: s.headers }),
        )
      ).data;
      return items.find((i) => i.name === 'Alpha')?.cells.st?.value;
    })
    .toMatchObject({ index: 2 });
});

test('2: relative date filters (quick "today", builder "N days ago")', async ({ page }) => {
  const s = await setup(page, 'r10');
  const boardId = await s.board(`סבב10 תאריכים ${Date.now().toString(36)}`);
  await s.col(boardId, 'due', 'date');
  await s.item(boardId, 'Today item', { due: { date: isoDay(0) } });
  await s.item(boardId, 'Old item', { due: { date: isoDay(-10) } });
  await openBoard(page, boardId);
  await page.getByTestId('toolbar-filter').click();
  await page.getByTestId('filter-rail-due').click();
  const quick = page.getByTestId('quick-due');
  await expect(quick).toBeVisible();
  await quick.getByRole('button', { name: /^היום/ }).click();
  await expect(row(page, 'Today item')).toBeVisible();
  await expect(row(page, 'Old item')).toHaveCount(0);
  await quick.getByRole('button', { name: /^היום/ }).click();
  await expect(row(page, 'Old item')).toBeVisible();

  // Builder: "due before 7 days ago" — stored as DAYS_AGO:7, so a saved view keeps moving with today.
  await page.getByTestId('filter-rail-advanced').click();
  await page.getByTestId('filter-add-rule').first().click();
  const rule = page.getByTestId('filter-rule').last();
  await rule.getByTestId('rule-column').click();
  await page.getByRole('menuitemradio', { name: 'due', exact: true }).click();
  await rule.getByTestId('rule-operator').click();
  await page.getByRole('menuitemradio', { name: 'לפני', exact: true }).click();
  await rule.getByTestId('rule-date').click();
  await page.getByTestId('date-days').fill('7');
  await page.getByTestId('date-days-ago').click();
  await expect(rule.getByTestId('rule-date')).toContainText('7');
  await expect(row(page, 'Old item')).toBeVisible();
  await expect(row(page, 'Today item')).toHaveCount(0);
});

test('3: a formula with an https result is a safe link', async ({ page }) => {
  const s = await setup(page, 'r10');
  const boardId = await s.board(`סבב10 נוסחה ${Date.now().toString(36)}`);
  await s.col(boardId, 'site', 'text');
  await s.col(boardId, 'url', 'formula', { formula: 'CONCATENATE("https://example.com/", {site})' });
  await s.col(boardId, 'bad', 'formula', { formula: 'CONCATENATE("javascript:", "alert(1)")' });
  await s.item(boardId, 'Linked', { site: 'abc' });
  await openBoard(page, boardId);
  const link = cell(page, 'Linked', 'url').getByTestId('formula-link');
  await expect(link).toHaveAttribute('href', 'https://example.com/abc');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(cell(page, 'Linked', 'bad').getByTestId('formula-link')).toHaveCount(0);
});

test('4: a mirror updates live when the source item on another board changes', async ({ page }) => {
  const s = await setup(page, 'r10');
  const clients = await s.board(`סבב10 לקוחות ${Date.now().toString(36)}`);
  const deals = await s.board(`סבב10 עסקאות ${Date.now().toString(36)}`);
  await s.col(clients, 'amount', 'numbers');
  await s.col(deals, 'client', 'board_relation', { board_ids: [clients] });
  await s.col(deals, 'client_amount', 'mirror', { relation_column_id: 'client', source_column_id: 'amount' });
  const client = await s.item(clients, 'Client A', { amount: 100 });
  await s.item(deals, 'Deal A', { client: { item_ids: [client.id] } });
  await openBoard(page, deals);
  await expect(page.getByTestId('board-live')).toHaveAttribute('data-live', 'on');
  await expect(cell(page, 'Deal A', 'client_amount')).toContainText('100');
  // Another "user" (the API) changes the source on the other board: no reload here.
  const res = await page.request.put(`/api/v1/items/${client.id}/cells/amount`, {
    headers: s.headers,
    data: { value: 250 },
  });
  expect(res.ok()).toBe(true);
  await expect(cell(page, 'Deal A', 'client_amount')).toContainText('250', { timeout: 10_000 });
});

test('5: search fields clear with an X', async ({ page }) => {
  const s = await setup(page, 'r10');
  const boardId = await s.board(`סבב10 חיפוש ${Date.now().toString(36)}`);
  await s.item(boardId, 'Findme');
  await s.item(boardId, 'Other');
  await openBoard(page, boardId);
  const search = page.getByTestId('toolbar-search');
  await search.click();
  await expect(page.getByTestId('toolbar-search-clear')).toHaveCount(0);
  await search.fill('Findme');
  await expect(row(page, 'Other')).toHaveCount(0);
  await page.getByTestId('toolbar-search-clear').click();
  await expect(search).toHaveValue('');
  await expect(row(page, 'Other')).toBeVisible();
  // The columns list of "hide" (a SearchField) has its own X.
  await page.getByTestId('toolbar-hide').click();
  await page.getByTestId('hide-search').fill('zzz');
  await page.getByTestId('hide-search-clear').click();
  await expect(page.getByTestId('hide-search')).toHaveValue('');
});

test('6: map pins stay put on hover; a click opens the item window', async ({ page }) => {
  const s = await setup(page, 'r10');
  const boardId = await s.board(`סבב10 מפה ${Date.now().toString(36)}`);
  await s.col(boardId, 'location', 'location');
  const a = await s.item(boardId, 'דיזנגוף', {
    location: { address: 'דיזנגוף 50, תל אביב', lat: 32.078, lng: 34.774 },
  });
  await s.item(boardId, 'חיפה', { location: { address: 'הנמל, חיפה', lat: 32.82, lng: 34.999 } });
  await page.request.post(`/api/v1/boards/${boardId}/views`, {
    headers: s.headers,
    data: { name: 'מפה', type: 'map', settings: { map: { location_column_id: 'location' } } },
  });
  await openBoard(page, boardId);
  await page.getByTestId('view-tab').filter({ hasText: 'מפה' }).click();
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  await page.locator('[data-testid="map-list-item"][data-item-name="דיזנגוף"]').click();
  // The list click opens the window at the pin too; close it to test the pin itself.
  await expect(page.getByTestId('map-popup-card')).toHaveAttribute('data-item-name', 'דיזנגוף');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('map-popup-card')).toHaveCount(0);
  const marker = page.locator(`[data-testid="map-marker"][data-item-id="${a.id}"]`);
  await expect(marker).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(800); // the fly-to has ended
  const before = await marker.boundingBox();
  await marker.hover();
  await page.waitForTimeout(300);
  const after = await marker.boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeLessThan(1);
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  await marker.click();
  const card = page.getByTestId('map-popup-card');
  await expect(card).toHaveAttribute('data-item-name', 'דיזנגוף');
  await card.getByTestId('map-popup-open').click();
  await page.waitForURL(new RegExp(`/i/${a.id}`));
});
