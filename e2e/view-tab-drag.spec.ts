// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Fix: (views + updates): (4) dragging a view tab keeps the strip still — same height, tabs on the same
 * line, horizontal-only — and the drop lands where the gap shows, kept after a reload. (5) "copy settings from a
 * view" of the same type, applied as an unsaved draft (D20) and saved with the save bar. (7) an update or a reply
 * with only attached files (no text) can be sent.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const tabs = (page: Page) => page.getByTestId('view-tab');
const tab = (page: Page, name: string) => page.locator(`[data-testid="view-tab"][data-view-name="${name}"]`);
const order = (page: Page) => tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-view-name')));
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page) => {
  const name = `ר7 ${uid()}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  return name;
};

const addView = async (page: Page, type: RegExp, name: string) => {
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: type }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(tab(page, name)).toBeVisible();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
};

const openSettings = async (page: Page) => {
  await page.getByTestId('toolbar-view-settings').click();
  await expect(page.getByTestId('view-settings')).toBeVisible();
};

test('dragging a view tab keeps the strip still; the drop lands where shown and survives a reload', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page);
  for (const n of ['A', 'B', 'C', 'D', 'E']) await addView(page, /טבלה/, n);
  await expect.poll(() => order(page)).toEqual(['טבלה', 'A', 'B', 'C', 'D', 'E']);

  const strip = page.getByTestId('view-tabs');
  const before = (await strip.boundingBox())!;
  const tabY = async () => (await tab(page, 'A').boundingBox())!.y;
  const y0 = await tabY();
  const from = (await tab(page, 'B').boundingBox())!;
  const to = (await tab(page, 'D').boundingBox())!;

  // Real mouse: press, start moving, wander down and up while crossing to D.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 12, from.y + from.height / 2, { steps: 4 });
  await expect(page.getByTestId('view-tab-overlay')).toBeVisible();
  const overlayY = (await page.getByTestId('view-tab-overlay').boundingBox())!.y;
  const midX = (from.x + to.x + to.width) / 2;
  await page.mouse.move(midX, from.y + from.height / 2 + 60, { steps: 10 });
  const during = (await strip.boundingBox())!;
  // The strip keeps its exact place and height, nothing scrolls vertically, the tabs stay on their line.
  expect(during.height).toBe(before.height);
  expect(during.y).toBe(before.y);
  expect(await tabY()).toBe(y0);
  expect(await strip.evaluate((el) => el.scrollHeight <= el.clientHeight && el.scrollTop === 0)).toBe(true);
  // The dragged tab follows horizontally only.
  expect((await page.getByTestId('view-tab-overlay').boundingBox())!.y).toBe(overlayY);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2 - 40, { steps: 10 });
  expect((await strip.boundingBox())!.height).toBe(before.height);
  await page.mouse.up();
  await page.waitForTimeout(150);
  await expect(page.getByTestId('view-tab-overlay')).toHaveCount(0);

  await expect.poll(() => order(page)).toEqual(['טבלה', 'A', 'C', 'D', 'B', 'E']);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(['טבלה', 'A', 'C', 'D', 'B', 'E']);
});

test('copy settings from a view of the same type: an unsaved draft, then saved', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page);

  // "Target" first (a new view starts from what is on screen), then "Source": rows of three lines, wrapped — saved.
  await addView(page, /טבלה/, 'יעד');
  await addView(page, /טבלה/, 'מקור');
  await openSettings(page);
  await page.getByTestId('view-row-height').click();
  await page.getByRole('menu').getByText('שלוש שורות').click();
  await page.getByTestId('view-wrap-text').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('view-save').click();
  await expect(page.getByTestId('save-bar')).toHaveCount(0);
  const sourceHeight = 'שלוש שורות';

  // "Target" is plain; copying from "מקור" makes a draft with its settings.
  await tab(page, 'יעד').click();
  await expect(tab(page, 'יעד')).toHaveAttribute('aria-selected', 'true');
  await openSettings(page);
  await expect(page.getByTestId('view-row-height')).not.toHaveText(sourceHeight);
  await page.getByTestId('view-copy-settings').click();
  // Only views of the same type (no Kanban "בורד" offered), never the view itself.
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'מקור' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'יעד' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'מקור' }).click();
  await expect(page.getByTestId('view-row-height')).toHaveText(sourceHeight);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('save-bar')).toBeVisible();
  await page.getByTestId('view-save').click();
  await expect(page.getByTestId('save-bar')).toHaveCount(0);

  await page.reload();
  await expect(tab(page, 'יעד')).toHaveAttribute('aria-selected', 'true');
  await openSettings(page);
  await expect(page.getByTestId('view-row-height')).toHaveText(sourceHeight);
  await page.keyboard.press('Escape');

  // A Kanban view has no other Kanban view to copy from.
  await addView(page, /קנבן/, 'בורד');
  await openSettings(page);
  await expect(page.getByTestId('view-copy-settings-none')).toBeVisible();
  await expect(page.getByTestId('view-copy-settings')).toHaveCount(0);
});

test('an update and a reply with only an attached file (no text) are sent', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('קבצים בלבד');
  await add.press('Enter');
  const r = row(page, 'קבצים בלבד');
  await expect(r).toBeVisible();
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: 'קבצים בלבד' });
  await expect(card).toBeVisible();

  // the idle, empty update box is one closed line; a click opens it (attach / send).
  await card.getByTestId('composer').click({ position: { x: 20, y: 20 } });
  const send = card.getByTestId('composer-send').first();
  await expect(send).toBeDisabled();
  await card
    .locator('input[type=file]:not([data-testid="avatar-input"])')
    .first()
    .setInputFiles({ name: 'only-file.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(card.getByTestId('composer-file-remove')).toHaveCount(1);
  await expect(send).toBeEnabled();
  await send.click();

  const update = card.locator('article', { has: page.locator('[data-name="only-file.txt"]') }).first();
  await expect(update.getByTestId('update-file')).toHaveCount(1);
  // No text: no (empty) body block above the file.
  await expect(update.locator('.update-body').first()).toBeHidden();
  // Sent and empty again: back to the closed line.
  await expect(card.getByTestId('composer')).toHaveAttribute('data-collapsed', 'true');

  // A reply with only a file.
  await update.getByRole('button', { name: 'תגובה', exact: true }).first().click();
  const replySend = card.getByTestId('composer-send').last();
  await expect(replySend).toBeDisabled();
  await card
    .locator('input[type=file]:not([data-testid="avatar-input"])')
    .last()
    .setInputFiles({ name: 'reply-file.txt', mimeType: 'text/plain', buffer: Buffer.from('re') });
  await expect(replySend).toBeEnabled();
  await replySend.click();
  await expect(card.locator('[data-testid="update-attachment"][data-name="reply-file.txt"]')).toBeVisible();
});
