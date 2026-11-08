// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Owner fixes, round 1 (table): a hand over clickable cells, column separators, the item name in the regular
 * weight, a resizable name column (items and subitems), Ctrl+F = the board's search, and closing subitems that a
 * filter opened.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const nameHeader = (page: Page) => page.getByTestId('header-row').first().locator('[data-name-header]');

const newBoard = async (page: Page, items: string[]) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תיקונים ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of items) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }
};

const addColumn = async (page: Page, type: string) => {
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: type, exact: true }).click();
  await expect(page.getByTestId('header-row').first().locator('[data-header]', { hasText: type })).toBeVisible();
};

test('clickable cells show the hand, columns are separated, names in the regular weight', async ({ page }) => {
  await newBoard(page, ['A']);
  await addColumn(page, 'סטטוס');

  // Fix 1: the status cell (and its labels) open with a click — the pointer says so.
  const status = row(page, 'A').locator('[data-column-type="status"] button').first();
  await expect(status).toHaveCSS('cursor', 'pointer');
  await status.click();
  await expect(page.getByRole('button', { name: 'ניקוי' }).first()).toHaveCSS('cursor', 'pointer');
  await page.keyboard.press('Escape');

  // Fix 2: a line at the end of every column, in the header and in the rows.
  const cell = row(page, 'A').locator('[data-column-type="status"]');
  await expect(cell).toHaveCSS('border-inline-end-width', '1px');
  await expect(row(page, 'A').locator('[data-name-of]')).toHaveCSS('border-inline-end-width', '1px');
  await expect(page.getByTestId('header-row').first().locator('[data-header]').first()).toHaveCSS(
    'border-inline-end-width',
    '1px',
  );
  await expect(nameHeader(page)).toHaveCSS('border-inline-end-width', '1px');

  // Fix 3: the item's name is not bold.
  await expect(row(page, 'A').locator('[data-name-of] > span.truncate').first()).toHaveCSS('font-weight', '400');
});

test('the name column resizes like any other and keeps its width', async ({ page }) => {
  await newBoard(page, ['A short one', 'A rather long item name that would not fit in a narrow column at all']);
  const width = async () => Math.round((await nameHeader(page).boundingBox())!.width);
  const before = await width();

  // Drag: in RTL the edge is on the left, so dragging left widens it.
  const edge = (await nameHeader(page).getByTestId('name-resize').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 80, edge.y + edge.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(width).toBe(before + 80);
  // The rows follow the header.
  const cell = (await row(page, 'A short one').locator('[data-name-of]').boundingBox())!;
  expect(Math.abs(Math.round(cell.width) - (before + 80))).toBeLessThan(2);

  // Keyboard: ← widens by 10 in RTL.
  await nameHeader(page).getByTestId('name-resize').focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(width).toBe(before + 90);

  // Kept after a reload (personal width, like the other columns).
  await page.reload();
  await expect(row(page, 'A short one')).toBeVisible();
  await expect.poll(width).toBe(before + 90);

  // Double click: fits the longest name (wider than the default).
  await nameHeader(page).getByTestId('name-resize').dblclick();
  await expect.poll(width).toBeGreaterThan(before + 90);
  const name = row(page, 'A rather long item name that would not fit in a narrow column at all')
    .locator('[data-name-of] > span.truncate')
    .first();
  await expect.poll(() => name.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test('the subitems name column resizes too', async ({ page }) => {
  await newBoard(page, ['Parent']);
  await row(page, 'Parent').hover();
  await row(page, 'Parent').getByTestId('subitems-toggle').click();
  const field = page.getByLabel('+ הוספת תת-פריט');
  await field.fill('Child');
  await field.press('Enter');
  await expect(row(page, 'Child')).toBeVisible();

  const head = page.getByTestId('subhead').locator('[data-name-header]');
  const width = async () => Math.round((await head.boundingBox())!.width);
  const before = await width();
  const edge = (await head.getByTestId('name-resize').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 50, edge.y + edge.height / 2, { steps: 6 });
  // The sub-board's widths are saved shortly after the drag (debounced) — wait for it before reloading.
  const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && /\/columns\/name$/.test(r.url()));
  await page.mouse.up();
  await expect.poll(width).toBe(before + 50);
  await saved;
  await page.reload();
  // Subitems start closed on every visit (product decision) — open them again.
  await row(page, 'Parent').getByTestId('subitems-toggle').click();
  await expect(row(page, 'Child')).toBeVisible();
  await expect.poll(width).toBe(before + 50);
});

test('Ctrl+F is the board search, not the browser find', async ({ page }) => {
  await newBoard(page, ['alpha', 'beta']);
  const search = page.getByTestId('toolbar-search');
  // Idle: says what it searches and shows the shortcut.
  await expect(search).toHaveAttribute('placeholder', 'חיפוש בבורד…');
  await expect(page.getByTestId('search-kbd')).toBeVisible();

  // The page swallows the browser's find.
  await page.evaluate(() => {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyF') (window as unknown as { findPrevented: boolean }).findPrevented = e.defaultPrevented;
    });
  });
  await page.keyboard.press('Control+f');
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => (window as unknown as { findPrevented: boolean }).findPrevented)).toBe(true);
  // Lit up with the accent ring; the chip steps aside.
  await expect(search).toHaveAttribute('data-summoned', 'true');
  await expect(page.getByTestId('search-kbd')).toHaveCount(0);

  await page.keyboard.type('alp');
  await expect(row(page, 'beta')).toHaveCount(0);
  // Esc clears and leaves the field.
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(search).not.toBeFocused();
  await expect(row(page, 'beta')).toBeVisible();
  await expect(search).not.toHaveAttribute('data-summoned', 'true');
});

test('subitems opened by a filter can be closed (and opened again)', async ({ page }) => {
  await newBoard(page, ['P1', 'P2']);
  await row(page, 'P1').hover();
  await row(page, 'P1').getByTestId('subitems-toggle').click();
  const field = page.getByLabel('+ הוספת תת-פריט');
  for (const n of ['alpha task', 'other task']) {
    await field.fill(n);
    await field.press('Enter');
    await expect(row(page, n)).toBeVisible();
  }
  await row(page, 'alpha task').hover();
  await row(page, 'alpha task').getByTestId('subitems-toggle').click();
  // The nested level's own "add" comes first (inside P1's subitems, above P1's).
  const nestedField = page.getByLabel('+ הוספת תת-פריט').first();
  await nestedField.fill('alpha deep');
  await nestedField.press('Enter');
  await expect(row(page, 'alpha deep')).toBeVisible();
  await row(page, 'alpha task').getByTestId('subitems-toggle').click();
  await row(page, 'P1').getByTestId('subitems-toggle').click();
  await expect(row(page, 'alpha task')).toHaveCount(0);

  // Search through the subitems: P1 opens by itself, down to the matching level.
  await page.getByTestId('toolbar-search').fill('alpha');
  await page.getByTestId('toolbar-filter').click();
  await page.getByTestId('filter-rail-advanced').click();
  await page.getByTestId('filter-panel').getByTestId('filter-match-children').click();
  await page.keyboard.press('Escape');
  await expect(row(page, 'alpha task')).toBeVisible();
  await expect(row(page, 'alpha deep')).toBeVisible();

  // The nested level closes and opens while filtered.
  const nested = row(page, 'alpha task').getByTestId('subitems-toggle');
  await nested.click();
  await expect(row(page, 'alpha deep')).toHaveCount(0);
  await expect(nested).toHaveAttribute('aria-expanded', 'false');
  await nested.click();
  await expect(row(page, 'alpha deep')).toBeVisible();

  // The parent closes while filtered — the user's choice wins.
  const toggle = row(page, 'P1').getByTestId('subitems-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'alpha task')).toHaveCount(0);
  await toggle.click();
  await expect(row(page, 'alpha task')).toBeVisible();
  await toggle.click();
  await expect(row(page, 'alpha task')).toHaveCount(0);

  // A new search opens its matches again.
  await page.getByTestId('toolbar-search').fill('alpha t');
  await expect(row(page, 'alpha task')).toBeVisible();
});
