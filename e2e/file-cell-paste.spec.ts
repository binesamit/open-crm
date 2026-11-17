// SPDX-License-Identifier: AGPL-3.0-only
import type { Locator, Page } from '@playwright/test';
import { expect, type OwnerApi, type Scratch, test } from './fixtures';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * r19small — two prod fixes:
 * "in the files column allow copy–paste — e.g. an image": Ctrl/⌘+V of a clipboard file (a screenshot) on
 *   a files cell uploads it — the active cell in the table, its open panel, and the item card's field.
 * "in the filter on the phone, choosing a column closes the panel and the keyboard": the column picker
 *   inside the phone's tools sheet survives the on-screen keyboard (a shorter viewport); the sheet stays open.
 */
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const SCREENSHOT = /^צילום מסך \d{4}-\d{2}-\d{2} \d{2}-\d{2}( \(\d+\))?\.png$/;

/** A board of its own (this worker's workspace, deleted after the test) with one column and one item. */
const setup = async (scratch: Scratch, ownerApi: OwnerApi, type: 'file' | 'text') => {
  const board = await scratch.board('r19small');
  const tag = board.name.split(' ').pop()!;
  await ownerApi.call('post', `/boards/${board.id}/columns`, { title: `עמודה ${tag}`, type });
  const item = await ownerApi.call<{ id: string }>('post', `/boards/${board.id}/items`, { name: `פריט ${tag}` });
  return { board, item, tag };
};

/**
 * The upload a paste starts: its attach call (POST /items/:id/cells/:col/files). Wait on it, then on the cell no
 * longer busy — a paste while the cell is still busy with the previous one is dropped (FileCell `onPick`).
 */
const attachDone = (page: Page, itemId: string) =>
  page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname.startsWith(`/api/v1/items/${itemId}/cells/`) &&
      r.url().endsWith('/files'),
  );
const settled = async (cell: Locator) => expect(cell).not.toHaveAttribute('data-busy');

/** A paste of a clipboard image (as a screenshot comes: "image.png") on `target`. */
const pasteImage = (target: Locator) =>
  target.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_1PX);

test.beforeEach(async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
});

test('files cell: a pasted image uploads — the active cell, its open panel, the item card', async ({
  page,
  scratch,
  ownerApi,
}) => {
  const { board, item, tag } = await setup(scratch, ownerApi, 'file');
  await page.goto(`/a/demo/b/${board.id}`);
  const r = row(page, `פריט ${tag}`);
  const cell = r.getByTestId('file-cell');
  await expect(cell).toBeVisible();

  // 1. The active cell (clicked, its panel closed with Esc — the focus is back on the cell): Ctrl+V.
  await cell.click();
  await expect(page.getByTestId('popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('popover')).toHaveCount(0);
  // The grid hands the paste to the cell only while the focus is back on it (its wrapper) — not on <body>.
  await expect
    .poll(() =>
      cell.evaluate((el) => {
        const a = document.activeElement;
        return !!a && a !== document.body && (a.contains(el) || el.contains(a));
      }),
    )
    .toBe(true);
  let upload = attachDone(page, item.id);
  await page.evaluate(
    ([b64]) => {
      const bytes = Uint8Array.from(atob(b64!), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
      (document.activeElement ?? document.body).dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    },
    [PNG_1PX],
  );
  expect((await upload).ok()).toBe(true);
  // Pasted images show as previews in the cell.
  await expect(cell.getByTestId('file-cell-preview')).toHaveCount(1);
  await settled(cell);

  // The pasted screenshot got a dated name (the cell's edge opens its list; a preview opens the viewer).
  await cell.click({ position: { x: 4, y: 4 } });
  const panel = page.getByTestId('popover');
  await expect(panel.getByTestId('file-cell-open')).toHaveCount(1);
  await expect(panel.getByTestId('file-cell-open').first()).toHaveText(SCREENSHOT);

  // 2. With the cell's panel open: a paste there adds another.
  upload = attachDone(page, item.id);
  await pasteImage(panel);
  expect((await upload).ok()).toBe(true);
  await expect(panel.getByTestId('file-cell-open')).toHaveCount(2);
  await settled(cell);
  await page.keyboard.press('Escape');
  await expect(cell.getByTestId('file-cell-preview')).toHaveCount(2);

  // 3. The item card's fields tab: the focused field takes the paste.
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}?tab=fields`);
  const field = page.locator('[data-testid="card-field"] [data-column-type="file"] [data-testid="file-cell"]');
  await expect(field).toBeVisible();
  await expect(field.getByTestId('file-cell-preview')).toHaveCount(2);
  await field.focus();
  await expect(field).toBeFocused();
  upload = attachDone(page, item.id);
  await pasteImage(field);
  expect((await upload).ok()).toBe(true);
  await expect(field.getByTestId('file-cell-preview')).toHaveCount(3);
});

test('phone filter: picking a column keeps the tools sheet open, through the keyboard', async ({
  page,
  scratch,
  ownerApi,
}) => {
  const { board, tag } = await setup(scratch, ownerApi, 'text');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, `פריט ${tag}`)).toBeVisible();

  await page.getByTestId('mobile-filter-open').click();
  const tools = page.getByTestId('mobile-filter-sheet');
  await tools.getByTestId('toolbar-filter').click();
  const panel = page.getByTestId('filter-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('filter-rail-advanced').click();
  await panel.getByTestId('filter-add-rule').click();
  const rule = panel.getByTestId('filter-rule').last();
  await rule.getByTestId('rule-column').click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();

  // The on-screen keyboard slides in: the viewport gets shorter (its width stays), the page scrolls a little.
  await page.setViewportSize({ width: 390, height: 500 });
  await page.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(300);
  await expect(menu).toBeVisible();
  await expect(tools).toBeVisible();

  await page.getByRole('menuitemradio', { name: `עמודה ${tag}`, exact: true }).click();
  await expect(rule.getByTestId('rule-column')).toHaveText(`עמודה ${tag}`);
  await expect(tools).toBeVisible();
  await expect(panel).toBeVisible();

  // The value is typed with the keyboard still up; nothing closes.
  await rule.getByTestId('rule-operator').click();
  await page.getByRole('menuitemradio', { name: 'מכיל', exact: true }).click();
  await rule.getByTestId('rule-text').fill('abc');
  await expect(rule.getByTestId('rule-text')).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rule.getByTestId('rule-text')).toHaveValue('abc');
  await expect(tools).toBeVisible();
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('mobile-filter-count')).toHaveText('1');
});
