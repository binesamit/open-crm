// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { ownerContext, signIn } from './helpers';

/**
 * Windowed loading (perf review §7.1): a board of 30,000 items opens without loading them all — the table gets
 * the view's outline from the server (ids per group, counts, footers) and loads rows as they scroll into view.
 * Filter, sort and grouping run on the server; editing a cell works as on any board. The board is generated through
 * the API (`items/bulk-edit`, 10k rows per request) and deleted at the end.
 */
test.setTimeout(240_000);

const N = 30_000;
const PAGE = 10_000;
/** `?q=` of a view draft — base64url JSON, like shared `encodeQuery`. */
const q = (query: object) => Buffer.from(JSON.stringify(query)).toString('base64url');
const rows = (page: Page) => page.getByTestId('item-row');
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
/** The page is responsive: the next frame comes within `ms` (no long task holds the main thread). */
const nextFrame = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((done) => {
        const t0 = performance.now();
        requestAnimationFrame(() => done(performance.now() - t0));
      }),
  );

test('a 30k-item board opens windowed: edit, scroll to the end, filter, sort, group', async ({ page }) => {
  await signIn(page);
  const { headers } = await ownerContext(page);
  const wsId = (
    (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] }
  ).data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `חלונות ${Date.now()}`, workspace_id: wsId } })
  ).json()) as { id: string };
  try {
    for (const c of [
      { id: 'stage', title: 'שלב', type: 'status' },
      { id: 'amount', title: 'סכום', type: 'numbers' },
    ])
      expect((await page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data: c })).status()).toBe(201);
    for (let start = 0; start < N; start += PAGE) {
      const res = await page.request.post(`/api/v1/boards/${board.id}/items/bulk-edit`, {
        headers,
        timeout: 120_000,
        data: {
          labels: [],
          tags: [],
          rows: Array.from({ length: PAGE }, (_, k) => {
            const i = start + k;
            return { name: `שורה ${i}`, cells: { stage: { index: i % 3 }, amount: i } };
          }),
        },
      });
      expect(res.status(), await res.text()).toBe(200);
    }

    // Open: the board is windowed, only a window of rows is in the page, the group counts all 30k.
    const t0 = Date.now();
    await page.goto(`/a/demo/b/${board.id}`);
    await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
    const openMs = Date.now() - t0;
    await expect(page.getByTestId('board-scroll')).toHaveAttribute('data-windowed', 'true');
    expect(await rows(page).count()).toBeLessThan(200);
    await expect(page.getByTestId('board-section').first()).toContainText(String(N));

    // Edit a cell of a loaded row: saved and shown at once.
    const first = row(page, 'שורה 0');
    await expect(first).toBeVisible();
    await first.locator('[data-column-type="numbers"]').click();
    await page.keyboard.type('1000000');
    await page.keyboard.press('Enter');
    await expect(first.locator('[data-column-type="numbers"]')).toContainText(/1[,.]?000[,.]?000/);
    expect(await nextFrame(page)).toBeLessThan(200);

    // Scroll to the very end: the last rows load as they come into view, the page keeps drawing frames, and the
    // group's footer is the server's sum over all 30k rows (0 + … + 29,999, plus the edit).
    const scroller = page.getByTestId('board-scroll');
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight));
    expect(await nextFrame(page)).toBeLessThan(200);
    await expect(row(page, `שורה ${N - 1}`)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('summary-row').first().locator('[data-summary="amount"]')).toContainText(
      /450[,.]?985[,.]?000/,
      { timeout: 10_000 },
    );
    // The middle loads too (rows the first screens never asked for).
    await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight / 2));
    await expect(page.getByTestId('row-loading')).toHaveCount(0, { timeout: 15_000 });

    // Filter (the toolbar search, run by the server): one match out of 30k.
    const t1 = Date.now();
    await page.getByTestId('toolbar-search').fill('שורה 12345');
    await expect(rows(page)).toHaveCount(1, { timeout: 15_000 });
    await expect(row(page, 'שורה 12345')).toBeVisible();
    const filterMs = Date.now() - t1;
    // The board search stays for this tab's session (round 11) — clear it before opening the sort link.
    await page.getByTestId('toolbar-search-clear').click();
    await expect(page.getByTestId('toolbar-search')).toHaveValue('');
    await expect.poll(() => rows(page).count(), { timeout: 15_000 }).toBeGreaterThan(1);

    // Sort by amount, descending (a view draft through ?q=): the edited row first, then the biggest.
    await page.goto(`/a/demo/b/${board.id}?q=${q({ sort: [{ column_id: 'amount', direction: 'desc' }] })}`);
    await expect(rows(page).first()).toHaveAttribute('data-item-name', 'שורה 0', { timeout: 30_000 });
    await expect(rows(page).nth(1)).toHaveAttribute('data-item-name', `שורה ${N - 1}`);

    // Group by the status column: three buckets of 10k each, counted by the server.
    await page.goto(`/a/demo/b/${board.id}?q=${q({ group_by: { column_id: 'stage' } })}`);
    const sections = page.getByTestId('board-section');
    await expect(sections.first()).toContainText(String(N / 3), { timeout: 30_000 });
    // Collapsed, all three fit on screen (each a folded box with its count).
    await page.keyboard.press('Control+g');
    await expect(sections).toHaveCount(3);
    for (let i = 0; i < 3; i++) await expect(sections.nth(i)).toContainText(String(N / 3));
    expect(await nextFrame(page)).toBeLessThan(200);

    console.warn(`30k windowed board: open ${openMs} ms · search ${filterMs} ms`);
    expect(openMs).toBeLessThan(10_000);
    expect(filterMs).toBeLessThan(5_000);
  } finally {
    await page.request.delete(`/api/v1/boards/${board.id}`, { headers });
  }
});
