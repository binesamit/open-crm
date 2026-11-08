// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * M8 ד9–ד11 (views2): the P1 columns edited in the table with our own pickers (hour, week, world clock, colour,
 * country, location), progress from status columns, a button that sets values and one that runs an automation,
 * and the Chart, Files and Map views. Setup goes through the API (the UI is what is under test).
 */
type Headers = Record<string, string>;
const json = async <T>(res: { json: () => Promise<unknown> }) => (await res.json()) as T;

const DONE = { id: 1, label: 'הושלם', color: 'forest', index: 1, is_done: true };
const LABELS = [{ id: 0, label: 'בעבודה', color: 'yellow', index: 0 }, DONE];

const makeBoard = async (page: Page, name: string) => {
  const { headers } = await ownerContext(page);
  const ws = (await json<{ data: { id: string }[] }>(await page.request.get('/api/v1/workspaces', { headers })))
    .data[0]!.id;
  const board = await json<{ id: string }>(
    await page.request.post('/api/v1/boards', { headers, data: { name, workspace_id: ws } }),
  );
  const col = (id: string, type: string, settings?: unknown) =>
    page.request.post(`/api/v1/boards/${board.id}/columns`, {
      headers,
      data: { id, title: id, type, ...(settings ? { settings } : {}) },
    });
  await col('st1', 'status', { labels: LABELS });
  await col('st2', 'status', { labels: LABELS });
  await col('note', 'text');
  await col('amount', 'numbers');
  for (const type of ['hour', 'week', 'world_clock', 'color_picker', 'country', 'location', 'file'])
    await col(type === 'color_picker' ? 'paint' : type === 'world_clock' ? 'clock' : type, type);
  // r15cols: a new progress column starts not set up — this one measures the two status columns.
  await col('prog', 'progress', {
    source: 'columns',
    columns: [
      { column_id: 'st1', weight: 1 },
      { column_id: 'st2', weight: 1 },
    ],
  });
  await col('approve', 'button', {
    label: 'אישור',
    color: '#2e6b57',
    action: { kind: 'set_values', values: [{ column_id: 'note', text: 'אושר' }] },
  });
  await col('fire', 'button', { label: 'הפעלה' });
  const item = (n: string, cells: Record<string, unknown> = {}) =>
    page.request
      .post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: n, cells } })
      .then((r) => json<{ id: string }>(r));
  const a = await item('תל אביב', {
    st2: { index: 1 },
    amount: 10,
    location: { address: 'דיזנגוף 50, תל אביב', lat: 32.078, lng: 34.774 },
  });
  const b = await item('חיפה', {
    st2: { index: 0 },
    amount: 5,
    location: { address: 'הנמל, חיפה', lat: 32.82, lng: 34.999 },
  });
  return { id: board.id, a, b, headers };
};

const openBoard = async (page: Page, boardId: string) => {
  await page.goto(`/a/demo/b/${boardId}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
};
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const cell = (page: Page, name: string, column: string) => row(page, name).locator(`[data-column="${column}"]`);
const popover = (page: Page) => page.getByTestId('popover');

const addView = async (page: Page, h: Headers, boardId: string, name: string, type: string, settings = {}) => {
  await page.request.post(`/api/v1/boards/${boardId}/views`, { headers: h, data: { name, type, settings } });
  await page.reload();
  await page.getByTestId('view-tab').filter({ hasText: name }).click();
};

test('P1 columns: our pickers, progress and buttons', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const board = await makeBoard(page, `P1 ${Date.now().toString(36)}`);
  await openBoard(page, board.id);

  // Hour: an hour, then a minute (our list — no native time input).
  await cell(page, 'תל אביב', 'hour').click();
  await popover(page).locator('[data-testid="hour-option"][data-hour="14"]').click();
  await popover(page).locator('[data-testid="minute-option"][data-minute="30"]').click();
  await expect(cell(page, 'תל אביב', 'hour')).toContainText(/14:30|2:30/);

  // Week: any day picks its week (our calendar).
  await cell(page, 'תל אביב', 'week').click();
  await popover(page)
    .getByRole('button', { name: /^\d{2}\/\d{2}\/\d{4}$/ })
    .nth(10)
    .click();
  await expect(cell(page, 'תל אביב', 'week')).toContainText(/^W\d+/);

  // World clock: search a city.
  await cell(page, 'תל אביב', 'clock').click();
  await page.getByTestId('world-clock-search').fill('London');
  await page.locator('[data-testid="world-clock-option"][data-zone="Europe/London"]').click();
  await expect(cell(page, 'תל אביב', 'clock')).toContainText('London');

  // Colour: a swatch, then a typed hex.
  await cell(page, 'תל אביב', 'paint').click();
  await page.getByTestId('color-hex').fill('#123abc');
  await page.getByTestId('color-hex').press('Enter');
  await expect(cell(page, 'תל אביב', 'paint')).toContainText('#123ABC');

  // Country: search in Hebrew, a flag in the cell.
  await cell(page, 'תל אביב', 'country').click();
  await page.getByTestId('country-search').fill('צרפת');
  await page.locator('[data-testid="country-option"][data-code="FR"]').click();
  await expect(cell(page, 'תל אביב', 'country').locator('[data-code="FR"]')).toBeVisible();

  // Location: a new address waits for the geocoding queue; the existing one has coordinates.
  await expect(cell(page, 'תל אביב', 'location').locator('[data-geocoded="yes"]')).toBeVisible();
  await cell(page, 'חיפה', 'location').click();
  await page.getByTestId('location-input').fill('Somewhere that does not exist 12345');
  await page.getByTestId('location-save').click();
  await expect(cell(page, 'חיפה', 'location').locator('[data-geocoded]')).toHaveAttribute(
    'data-geocoded',
    /pending|failed|yes/,
  );

  // Progress: one of two status columns done → 50%.
  await expect(cell(page, 'תל אביב', 'prog').getByTestId('progress-cell')).toHaveAttribute('data-percent', '50');
  await cell(page, 'תל אביב', 'st1').click();
  await popover(page).getByRole('button', { name: 'הושלם', exact: true }).click();
  await expect(cell(page, 'תל אביב', 'prog').getByTestId('progress-cell')).toHaveAttribute('data-percent', '100');

  // A button that sets values (one undo for the click).
  await cell(page, 'חיפה', 'approve').getByTestId('button-cell').click();
  await expect(cell(page, 'חיפה', 'note')).toHaveText('אושר');
  await expect(page.getByTestId('toast').first()).toBeVisible();

  // A button that runs an automation ("when the button is clicked").
  await page.request.post(`/api/v1/boards/${board.id}/automations`, {
    headers: board.headers,
    data: {
      title: 'כפתור הפעלה',
      recipe: {
        trigger: { type: 'button_clicked', column: 'fire' },
        actions: [{ type: 'set_column', column: 'note', value: 'הופעל' }],
      },
    },
  });
  // The click's request must reach the server before the reload loop: a reload aborts it in flight (status -1),
  // and then the automation never runs.
  const fired = page.waitForResponse((r) => /\/buttons\/fire$/.test(r.url()) && r.request().method() === 'POST');
  await cell(page, 'תל אביב', 'fire').getByTestId('button-cell').click();
  expect((await fired).ok()).toBe(true);
  // The automation runs on the server's queue: wait for its value there, then reload once (a reload loop with a 1s
  // look per round never let a slow dev board finish loading).
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/api/v1/items/${board.a.id}`, { headers: board.headers });
        return ((await r.json()) as { cells: Record<string, { text: string | null } | undefined> }).cells.note?.text;
      },
      { timeout: 20_000 },
    )
    .toBe('הופעל');
  await page.reload();
  await expect(cell(page, 'תל אביב', 'note')).toHaveText('הופעל');
});

test('Chart, Files and Map views', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const board = await makeBoard(page, `P1 views ${Date.now().toString(36)}`);
  const h = board.headers;
  // A file in a file column (presign → storage → complete → attach).
  const pre = await json<{ file_id: string; upload_url: string; headers: Record<string, string> }>(
    await page.request.post('/api/v1/files/presign', {
      headers: h,
      data: { name: 'חוזה.txt', size: 5, mime: 'text/plain' },
    }),
  );
  await page.request.put(pre.upload_url, { headers: pre.headers, data: Buffer.from('hello') });
  await page.request.post(`/api/v1/files/${pre.file_id}/complete`, { headers: h });
  await page.request.post(`/api/v1/items/${board.a.id}/cells/file/files`, {
    headers: h,
    data: { file_ids: [pre.file_id] },
  });
  await openBoard(page, board.id);

  // Chart: sum of amount per status label (the label's colour, a table view of the numbers).
  await addView(page, h, board.id, 'גרף סכומים', 'chart', {
    chart: { chart_type: 'bar', x: { kind: 'column', column_id: 'st2' }, measure: { fn: 'sum', column_id: 'amount' } },
  });
  await expect(page.getByTestId('chart-view')).toBeVisible();
  await expect(page.getByTestId('widget-chart')).toBeVisible();
  await expect(page.locator('[data-testid="chart-row"][data-label="הושלם"] [data-testid="chart-value"]')).toHaveText(
    '10',
  );
  await expect(page.locator('[data-testid="chart-row"][data-label="בעבודה"] [data-testid="chart-value"]')).toHaveText(
    '5',
  );

  // Files: the file shows; a kind filter hides it; the tile opens the viewer.
  await addView(page, h, board.id, 'קבצי הבורד', 'files');
  const tile = page.locator('[data-testid="file-tile"][data-name="חוזה.txt"]');
  await expect(tile).toBeVisible();
  await page.getByTestId('files-filter-kind').click();
  await page.getByRole('menu').getByText('תמונות', { exact: true }).click();
  await expect(page.getByTestId('files-empty')).toBeVisible();
  await page.getByTestId('files-filter-kind').click();
  await page.getByRole('menu').getByText('כל הסוגים', { exact: true }).click();
  await tile.getByRole('button').first().click();
  await expect(page.getByTestId('file-viewer')).toBeVisible();
  await page.keyboard.press('Escape');

  // Map: markers by the location column (coloured by status); a marker shows the item, which opens its card.
  await addView(page, h, board.id, 'מפת סניפים', 'map', { map: { location_column_id: 'location', color_by: 'st2' } });
  await expect(page.getByTestId('map-view')).toBeVisible();
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-ready', 'true', { timeout: 20_000 });
  await expect(page.getByTestId('map-list-item')).toHaveCount(2);
  const marker = page.locator(`[data-testid="map-marker"][data-item-id="${board.a.id}"]`);
  // Close markers may cluster at a far zoom: picking the item in the list zooms to it.
  await page.locator('[data-testid="map-list-item"][data-item-name="תל אביב"]').click();
  await expect(marker).toBeVisible({ timeout: 10_000 });
  await marker.click();
  await expect(page.getByTestId('map-selected').getByTestId('item-tile')).toHaveAttribute('data-item-name', 'תל אביב');
  await page.getByTestId('map-selected').getByTestId('item-tile').click();
  await page.waitForURL(new RegExp(`/i/${board.a.id}`));
});
