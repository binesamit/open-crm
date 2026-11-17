// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** fix1 (owner's bug list): long names wrap on Kanban/Cards tiles, the item card's title renames in place, and the
 *  collapsed rail reaches the workspace and its boards. */
const LONG = `שםארוךמאודמאודבליםרווחים${'א'.repeat(80)} ועוד מילים כדי לבדוק גלישה של שם פריט`;

const newView = async (page: Page, type: string, name: string) => {
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: new RegExp(type) }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('view-tab').filter({ hasText: name })).toHaveAttribute('aria-selected', 'true');
};

/** The tile's name never runs past the tile (no horizontal overflow) and takes more than one line. */
const expectWrapped = async (page: Page) => {
  const tile = page.locator(`[data-testid="item-tile"][data-item-name="${LONG}"]`);
  await expect(tile).toBeVisible();
  const box = (await tile.boundingBox())!;
  const name = (await tile.getByTestId('tile-name').boundingBox())!;
  expect(name.x).toBeGreaterThanOrEqual(box.x - 1);
  expect(name.x + name.width).toBeLessThanOrEqual(box.x + box.width + 1);
  expect(name.height).toBeGreaterThan(30); // several lines, not one truncated line
  expect(await tile.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
};

test('long names wrap, the card title renames in place, the rail opens the boards', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardName = `תיקונים ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(boardName);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'סטטוס', exact: true }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of [LONG, 'Short']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(page.getByTestId('item-row').filter({ hasText: name.slice(0, 20) })).toBeVisible();
  }

  // 1 — Kanban and Cards: the long name wraps inside its tile.
  await newView(page, 'קנבן', 'בורד');
  await expectWrapped(page);
  await newView(page, 'כרטיסים', 'גלריה');
  await expectWrapped(page);

  // 3 — the card's title: click → input; Esc cancels (the card stays open); Enter saves.
  await page.locator('[data-testid="item-tile"][data-item-name="Short"]').click();
  await expect(page).toHaveURL(/\/i\//);
  const card = page.getByRole('dialog');
  await expect(card.getByRole('heading', { level: 2 })).toHaveText('Short');
  await card.getByTestId('card-title-edit').click();
  const input = card.getByTestId('card-title-input');
  await input.fill('בוטל');
  await input.press('Escape');
  await expect(page).toHaveURL(/\/i\//);
  await expect(card.getByRole('heading', { level: 2 })).toHaveText('Short');
  await card.getByTestId('card-title-edit').click();
  await input.fill('שם חדש מהכרטיס');
  await input.press('Enter');
  await expect(card.getByRole('heading', { level: 2 })).toHaveText('שם חדש מהכרטיס');
  await page.reload();
  await expect(page.getByRole('dialog').getByRole('heading', { level: 2 })).toHaveText('שם חדש מהכרטיס');
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/\/i\//);
  await expect(page.locator('[data-testid="item-tile"][data-item-name="שם חדש מהכרטיס"]')).toBeVisible();

  // 4 — collapsed rail: the workspace button opens the tree; a board click navigates and closes it.
  await page.goto('/a/demo');
  if ((await page.getByTestId('sidebar-collapse').getAttribute('aria-expanded')) === 'true') {
    await page.getByTestId('sidebar-collapse').click();
  }
  await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute('aria-expanded', 'false');
  await page.getByTestId('rail-boards').click();
  const flyout = page.getByTestId('rail-boards-panel');
  await expect(flyout).toBeVisible();
  await expect(flyout.getByRole('button', { name: 'החלפת מרחב עבודה' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(flyout).toBeHidden();
  await page.getByTestId('rail-boards').click();
  await flyout.getByTestId('board-row').filter({ hasText: boardName }).getByRole('link').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(boardName);
  await expect(flyout).toBeHidden();
  // Leave the sidebar open for the other specs (the rail is remembered per device).
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute('aria-expanded', 'true');
});
