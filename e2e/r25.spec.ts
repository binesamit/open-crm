// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * r25 — three prod fixes:
 * phones: the tap that closes a menu / a cell's sheet does nothing else (no item card opens under it)
 *          the next tap does its own thing.
 * phone table: the sticky name column is wide at the start of the sideways scroll and narrows as the
 *          columns scroll under it, widening again on the way back.
 * the relation ⚠ marks update live when a linked item changes elsewhere — no reload.
 */
const json = async <T>(res: { json: () => Promise<unknown> }) => (await res.json()) as T;
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const cell = (page: Page, name: string, column: string) => row(page, name).locator(`[data-column="${column}"]`);

const LABELS = [
  { id: 1, label: 'פעיל', color: 'forest', index: 0 },
  { id: 2, label: 'לא פעיל', color: 'gray', index: 1 },
];
const ACTIVE = {
  kind: 'group',
  operator: 'and',
  negate: false,
  rules: [{ kind: 'rule', column_id: 'state', operator: 'any_of', values: ['פעיל'], negate: false }],
};

/** Two boards: clients (a status) and deals linking to them through a relation column filtered on "active". */
const setup = async (page: Page, extraColumns = 0) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = (await json<{ data: { id: string }[] }>(await page.request.get('/api/v1/workspaces', { headers })))
    .data[0]!.id;
  const stamp = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const board = async (n: string) =>
    (
      await json<{ id: string }>(
        await page.request.post('/api/v1/boards', { headers, data: { name: `${n} ${stamp}`, workspace_id: ws } }),
      )
    ).id;
  const clients = await board('r25 לקוחות');
  const deals = await board('r25 עסקאות');
  await page.request.post(`/api/v1/boards/${clients}/columns`, {
    headers,
    data: { id: 'state', title: 'מצב', type: 'status', settings: { labels: LABELS } },
  });
  const rel = await page.request.post(`/api/v1/boards/${deals}/columns`, {
    headers,
    data: {
      id: 'client',
      title: 'לקוח',
      type: 'board_relation',
      settings: { board_ids: [clients], choice_filter: { [clients]: { mode: 'filter', filter: ACTIVE } } },
    },
  });
  expect(rel.ok()).toBe(true);
  for (let i = 0; i < extraColumns; i++)
    await page.request.post(`/api/v1/boards/${deals}/columns`, {
      headers,
      data: { title: `עמודה ${i + 1}`, type: 'text' },
    });
  const item = (boardId: string, n: string, cells: Record<string, unknown> = {}) =>
    page.request
      .post(`/api/v1/boards/${boardId}/items`, { headers, data: { name: n, cells } })
      .then((r) => json<{ id: string }>(r));
  const levi = await item(clients, 'לוי ושות', { state: { index: 1 } });
  await item(deals, 'עסקה ראשונה', { client: { item_ids: [levi.id] } });
  await item(deals, 'עסקה שנייה');
  const setState = (id: string, index: number) =>
    page.request.put(`/api/v1/items/${id}/cells/state`, { headers, data: { value: { index } } });
  return { clients, deals, levi, setState };
};

const openBoard = async (page: Page, boardId: string) => {
  await page.goto(`/a/demo/b/${boardId}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
};

test('the relation ⚠ appears live when the linked item stops matching elsewhere (no reload)', async ({ page }) => {
  const s = await setup(page);
  await openBoard(page, s.deals);
  const linked = cell(page, 'עסקה ראשונה', 'client');
  await expect(linked).toContainText('לוי ושות');
  await expect(linked.getByTestId('relation-chip-unmatched')).toHaveCount(0);
  await expect(page.getByTestId('board-live')).toHaveAttribute('data-live', 'on');
  await page.waitForTimeout(1000); // the linked board's stream opens next to the board's own

  // Another client (the API — not this tab) makes the linked client inactive: the mark shows up by itself.
  expect((await s.setState(s.levi.id, 2)).ok()).toBe(true);
  await expect(linked.getByTestId('relation-chip-unmatched')).toContainText('לוי ושות', { timeout: 10_000 });

  // And goes away again when it matches again.
  expect((await s.setState(s.levi.id, 1)).ok()).toBe(true);
  await expect(linked.getByTestId('relation-chip-unmatched')).toHaveCount(0, { timeout: 10_000 });
});

test.describe('phones', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a tap outside an open cell sheet only closes it; the next tap opens what it lands on', async ({ page }) => {
    const s = await setup(page);
    await openBoard(page, s.deals);
    await expect(row(page, 'עסקה שנייה')).toBeVisible();
    const startUrl = page.url();

    // Open the relation column's sheet on the first row — on the cell's empty end: its chip (in the middle of a narrow
    // phone cell) opens the linked item.
    const openSheet = () => cell(page, 'עסקה ראשונה', 'client').tap({ position: { x: 6, y: 12 } });
    await openSheet();
    await expect(page.getByTestId('popover')).toBeVisible();

    // Tap the other row's name (under the dimmed page): the sheet closes, no item card opens.
    const name = row(page, 'עסקה שנייה').getByTestId('mobile-item-name');
    const box = (await name.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect(page.getByTestId('popover')).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(page.getByTestId('item-card')).toHaveCount(0);
    expect(page.url()).toBe(startUrl);

    // Same for a tap on another cell: it only closes the sheet …
    await openSheet();
    await expect(page.getByTestId('popover')).toBeVisible();
    const other = (await cell(page, 'עסקה שנייה', 'client').boundingBox())!;
    await page.touchscreen.tap(other.x + other.width / 2, other.y + other.height / 2);
    await expect(page.getByTestId('popover')).toHaveCount(0);
    await page.waitForTimeout(500);
    await expect(page.getByTestId('popover')).toHaveCount(0);
    // … and the second tap opens it, on purpose.
    await cell(page, 'עסקה שנייה', 'client').tap();
    await expect(page.getByTestId('popover')).toBeVisible();
    await page.keyboard.press('Escape');

    // With nothing open, a tap on the name opens the item card as always.
    await page.waitForTimeout(500);
    await name.tap();
    await expect(page.getByTestId('item-card')).toBeVisible();
  });

  test('the phone table: the name column is wide at the start and narrows as the columns scroll under it', async ({
    page,
  }) => {
    const s = await setup(page, 6);
    await openBoard(page, s.deals);
    const nameCell = row(page, 'עסקה שנייה').getByRole('rowheader');
    await expect(nameCell).toBeVisible();
    const start = (await nameCell.boundingBox())!.width;
    expect(start).toBeGreaterThan(390 * 0.55);
    const text = row(page, 'עסקה שנייה').getByTestId('mobile-item-name-text');
    expect(await text.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe('2');

    const scrollTo = (offset: number) =>
      page.getByTestId('mobile-table').evaluate((el, by) => {
        let scroller: HTMLElement | null = el.parentElement;
        while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowX)) scroller = scroller.parentElement;
        if (!scroller) return false;
        scroller.scrollLeft = getComputedStyle(scroller).direction === 'rtl' ? -by : by;
        return true;
      }, offset);
    const rowHeight = (await row(page, 'עסקה שנייה').boundingBox())!.height;

    // Scrolled away from the start: narrower (down to the minimum), one truncated line, same row height.
    expect(await scrollTo(400)).toBe(true);
    await expect.poll(async () => (await nameCell.boundingBox())!.width).toBeLessThan(start - 50);
    const narrow = (await nameCell.boundingBox())!.width;
    expect(narrow).toBeGreaterThanOrEqual(109);
    expect(await text.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe('1');
    expect(Math.abs((await row(page, 'עסקה שנייה').boundingBox())!.height - rowHeight)).toBeLessThan(1);

    // Partway back: in between; at the start: full width again.
    await scrollTo(60);
    await expect.poll(async () => (await nameCell.boundingBox())!.width).toBeGreaterThan(narrow + 20);
    await scrollTo(0);
    await expect.poll(async () => Math.round((await nameCell.boundingBox())!.width)).toBe(Math.round(start));
  });
});
