// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Phone fixes: in the item card the status picker is a bottom sheet inside the
 * screen with its own scroll; the files column and the update box offer "from the gallery" (an image / video
 * picker); rows have check boxes like the desktop, and the batch bar follows.
 */
type Json = Record<string, unknown>;
const PHONE = { width: 390, height: 844 };

const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async (method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as Json;
  const ws = ((await api('get', '/workspaces')).data as { id: string }[])[0]!;
  const tag = Math.random().toString(36).slice(2, 7);
  const board = await api('post', '/boards', { name: `טלפון ${tag}`, workspace_id: ws.id });
  const labels = Array.from({ length: 12 }, (_, i) => ({
    id: i,
    index: i,
    label: `שלב ${i + 1} ${tag}`,
    color: 'blue',
  }));
  await api('post', `/boards/${board.id as string}/columns`, { title: 'סטטוס', type: 'status', settings: { labels } });
  await api('post', `/boards/${board.id as string}/columns`, { title: 'קבצים', type: 'file' });
  for (const name of ['Alpha', 'Bravo', 'Charlie']) await api('post', `/boards/${board.id as string}/items`, { name });
  await page.setViewportSize(PHONE);
  await page.goto(`/a/demo/b/${board.id as string}`);
  await expect(page.getByTestId('mobile-item-name').filter({ hasText: 'Alpha' })).toBeVisible();
  return { board, tag };
};

test('phone: the status picker in the item card is a bottom sheet inside the screen, with its own scroll', async ({
  page,
}) => {
  const { tag } = await setup(page);
  await page.getByTestId('mobile-item-name').filter({ hasText: 'Alpha' }).click();
  const card = page.getByRole('dialog', { name: 'Alpha' });
  await expect(card).toBeVisible();
  await card.locator('[data-testid="card-tab"][data-tab-id="fields"]').click();
  await card.getByTestId('card-field').filter({ hasText: 'סטטוס' }).locator('[data-column-type="status"]').click();
  const sheet = page.getByTestId('popover').last();
  await expect(sheet).toBeVisible();
  const box = (await sheet.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width + 1);
  expect(box.y + box.height).toBeGreaterThan(PHONE.height - 4); // against the bottom edge
  expect(box.height).toBeLessThanOrEqual(PHONE.height * 0.86);
  // Twelve labels: the last one is reached by scrolling inside the sheet, and stays inside the screen.
  const last = sheet.getByRole('button', { name: `שלב 12 ${tag}`, exact: true });
  await last.scrollIntoViewIfNeeded();
  await expect(last).toBeInViewport();
  const lb = (await last.boundingBox())!;
  expect(lb.x + lb.width).toBeLessThanOrEqual(PHONE.width + 1);
});

test('phone: "from the gallery" in the files column and in the update box', async ({ page }) => {
  const { tag } = await setup(page);
  // The update box (the item card).
  await page.getByTestId('mobile-item-name').filter({ hasText: 'Bravo' }).click();
  const card = page.getByRole('dialog', { name: 'Bravo' });
  await card.getByTestId('composer').click({ position: { x: 20, y: 20 } });
  await expect(card.getByTestId('composer-gallery')).toBeVisible();
  await expect(card.getByTestId('composer-gallery-input')).toHaveAttribute('accept', 'image/*,video/*');
  await card
    .getByTestId('composer-gallery-input')
    .setInputFiles({ name: `photo-${tag}.png`, mimeType: 'image/png', buffer: Buffer.from('89504e470d0a1a0a', 'hex') });
  await expect(card.getByTestId('composer-file')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // The files column (the card's fields).
  await card.locator('[data-testid="card-tab"][data-tab-id="fields"]').click();
  await card.getByTestId('card-field').filter({ hasText: 'קבצים' }).locator('[data-column-type="file"]').click();
  await expect(page.getByTestId('file-cell-gallery')).toBeVisible();
  await expect(page.getByTestId('file-cell-gallery-input')).toHaveAttribute('accept', 'image/*,video/*');
});

test('phone: check boxes select rows like the desktop; the batch bar follows', async ({ page }) => {
  await setup(page);
  const boxes = page.getByTestId('row-select');
  await expect(boxes).toHaveCount(3);
  // A finger-sized target.
  const hit = (await boxes.first().locator('xpath=..').boundingBox())!;
  expect(hit.width).toBeGreaterThanOrEqual(28);
  await boxes.nth(0).click();
  await boxes.nth(2).click();
  await expect(page.getByTestId('batch-bar')).toBeVisible();
  await expect(page.getByTestId('batch-count')).toContainText('2');
  await boxes.nth(0).click();
  await expect(page.getByTestId('batch-count')).toContainText('1');
  // Ticking does not open the item card.
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

/**
 * Prod (sent back): on a phone, subitems and sub-subitems are checked too — in their own selection, with
 * their own batch bar, as on the desktop — and a header's box checks everything under it (a group's items, or one
 * item's subitems).
 */
test('phone: subitems and sub-subitems have check boxes; the header boxes check everything under them', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async (method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as Json;
  const ws = ((await api('get', '/workspaces')).data as { id: string }[])[0]!;
  const tag = Math.random().toString(36).slice(2, 7);
  const board = await api('post', '/boards', { name: `תתים ${tag}`, workspace_id: ws.id });
  const alpha = await api('post', `/boards/${board.id as string}/items`, { name: 'Alpha' });
  await api('post', `/boards/${board.id as string}/items`, { name: 'Bravo' });
  const a1 = await api('post', `/items/${alpha.id as string}/subitems`, { name: 'A1' });
  await api('post', `/items/${alpha.id as string}/subitems`, { name: 'A2' });
  await api('post', `/items/${a1.id as string}/subitems`, { name: 'Deep' });
  await page.setViewportSize(PHONE);
  await page.goto(`/a/demo/b/${board.id as string}`);
  await expect(page.getByTestId('mobile-item-name').filter({ hasText: 'Alpha' })).toBeVisible();

  // The group header's box: every item of the group.
  await page.getByTestId('mobile-select-group').click();
  await expect(page.getByTestId('batch-count').first()).toContainText('2');
  await page.getByTestId('mobile-select-group').click();
  await expect(page.getByTestId('batch-bar')).toHaveCount(0);

  // Open Alpha's subitems, then A1's (a sub-subitem).
  const alphaRow = page.locator('[data-testid="item-row"][data-item-name="Alpha"]');
  await alphaRow.getByTestId('subitems-toggle').click();
  const subRow = (name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
  await expect(subRow('A1')).toBeVisible();
  await subRow('A1').getByTestId('subitems-toggle').click();
  await expect(subRow('Deep')).toBeVisible();

  // A subitem and a sub-subitem are checked in the subitems' selection (its own batch bar).
  await subRow('A2').getByTestId('row-select').click();
  await subRow('Deep').getByTestId('row-select').click();
  await expect(subRow('A2').getByTestId('row-select')).toBeChecked();
  await expect(subRow('Deep').getByTestId('row-select')).toBeChecked();
  await expect(page.getByTestId('batch-count').first()).toContainText('2');
  // The items stay unchecked.
  await expect(alphaRow.getByTestId('row-select')).not.toBeChecked();

  // A subitems header's box checks every subitem of its parent (Alpha's: A1, A2).
  const heads = page.getByTestId('mobile-select-subitems');
  await heads.first().click();
  await expect(subRow('A1').getByTestId('row-select')).toBeChecked();
  await expect(subRow('A2').getByTestId('row-select')).toBeChecked();
});
