// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';
import { auditContrast } from './contrast';

/**
 * Round 12 — six UI fixes (product decisions): the friendly error screen instead of a blank page; floating panels stay on the
 * screen; "מוסתרות" as an icon; editing a checked row edits all the checked rows (+ the hover highlight); a real
 * table on phones; colour themes that keep AA contrast.
 */
const uid = () => Date.now().toString(36);
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, items: string[], columns: string[] = []) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`סבב 12 ${uid()}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of columns) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
    await expect(page.getByTestId('header-row').first().locator('[data-header]', { hasText: type })).toBeVisible();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of items) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }
  return /\/b\/([^/?]+)/.exec(page.url())![1]!;
};

const inViewport = async (page: Page, el: Locator) => {
  const box = (await el.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x, 'left edge on screen').toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, 'right edge on screen').toBeLessThanOrEqual(vp.width + 0.5);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
};

test('1 — a crash shows our error screen in its area, never the router default', async ({ page }) => {
  const boardId = await newBoard(page, ['Crash']);
  // The item card's composer chunk "of an old deploy" is gone: the card shows the error, the board stays.
  await page.route('**/features/item/Composer.tsx*', (r) => r.abort());
  await row(page, 'Crash').getByTestId('item-open-area').click();
  const cardError = page.getByTestId('item-card-error');
  await expect(cardError).toBeVisible();
  await expect(cardError.getByTestId('error-screen')).toHaveAttribute('data-kind', 'chunk');
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByTestId('board-toolbar')).toBeVisible();
  // Details stay folded until asked for.
  await expect(cardError.getByTestId('error-details')).toHaveCount(0);
  await cardError.getByTestId('error-details-toggle').click();
  await expect(cardError.getByTestId('error-details')).toContainText(/import|fetch|module/i);
  await cardError.getByTestId('item-card-error-close').click();
  await expect(cardError).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/b/${boardId}(\\?|$)`));
  await page.unroute('**/features/item/Composer.tsx*');

  // A whole page whose code cannot load (reloaded once by itself, then the screen) — inside the app's shell.
  await page.route('**/features/docs/DocPage.tsx*', (r) => r.abort());
  await page.goto('/a/demo/d/01ZZZZZZZZZZZZZZZZZZZZZZZZ');
  const screen = page.getByTestId('error-screen');
  await expect(screen).toBeVisible({ timeout: 15_000 });
  await expect(screen).toHaveAttribute('data-area', 'route');
  await expect(page.getByTestId('error-retry')).toBeVisible();
  await expect(page.getByTestId('error-home')).toBeVisible();
  await expect(page.locator('aside').first()).toBeVisible(); // the sidebar still works
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await page.unroute('**/features/docs/DocPage.tsx*');
  await page.getByTestId('error-home').click();
  await expect(page).toHaveURL(/\/a\/demo/);
});

const mentionList = async (page: Page, boardId: string, itemId: string, dir?: 'ltr') => {
  await page.goto(`/a/demo/b/${boardId}/i/${itemId}`);
  // An English (LTR) interface: the caret sits at the left.
  if (dir) await page.evaluate((d) => document.documentElement.setAttribute('dir', d), dir);
  const editor = page.getByRole('textbox', { name: /כתבו עדכון|עדכון/ }).first();
  await editor.click();
  // The composer keeps a draft per item: start from an empty editor (an earlier round's "@" is still there).
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Delete');
  await page.keyboard.type('@');
  const list = page.getByTestId('mention-list');
  await expect(list).toBeVisible();
  return list;
};

test('2 — the @mention list stays on the screen (narrow RTL and LTR, the screenshot case)', async ({ page }) => {
  const boardId = await newBoard(page, ['Mention']);
  const itemId = (await row(page, 'Mention').getAttribute('data-item-id'))!;
  for (const width of [390, 800, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    const list = await mentionList(page, boardId, itemId);
    await inViewport(page, list);
    // Inside the item card when it fits there.
    const card = (await page.locator('aside[role="dialog"]').boundingBox())!;
    const box = (await list.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(card.x - 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
    await page.keyboard.press('Escape');
  }
  // LTR (an English interface): the caret is at the inline-start (left) — still on screen.
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await inViewport(page, await mentionList(page, boardId, itemId, 'ltr'));
  }
});

test('2b — menus and popovers near the edges flip / shift inside', async ({ page }) => {
  await newBoard(page, ['Edge'], ['סטטוס']);
  await page.setViewportSize({ width: 390, height: 700 });
  // The row's ⋯ menu at the narrow screen's edge.
  const r = row(page, 'Edge');
  await r.hover();
  await r
    .getByRole('button', { name: /^פעולות ל/ })
    .first()
    .click();
  await inViewport(page, page.getByRole('menu'));
  await page.keyboard.press('Escape');
});

test('3 — "מוסתרות" is an icon (with the count), its name in the tooltip', async ({ page }) => {
  await newBoard(page, ['Hide'], ['מספרים']);
  const hide = page.getByTestId('toolbar-hide');
  await expect(hide).toHaveAttribute('aria-label', 'הסתרה');
  // The label is for screen readers only: the button is a square icon, like the other compact tools.
  await expect(hide.locator('.sr-only')).toHaveText('הסתרה');
  expect((await hide.boundingBox())!.width).toBeLessThanOrEqual(34);
  await hide.click();
  await page
    .getByTestId('hide-panel')
    .getByRole('checkbox', { name: /מספרים/ })
    .click();
  await page.keyboard.press('Escape');
  await expect(hide).toHaveAttribute('aria-label', '1 מוסתרות');
  await expect(hide.locator('.sr-only')).toHaveText('1 מוסתרות');
  // The count badge is the only visible text.
  await expect(hide.locator('span:not(.sr-only)').filter({ hasText: /\S/ })).toHaveText('1');
  expect((await hide.boundingBox())!.width).toBeLessThanOrEqual(56);
});

test('4 — editing a checked row sets the column on every checked row; hover lights the column', async ({ page }) => {
  await newBoard(page, ['A', 'B', 'C'], ['מספרים']);
  const num = (name: string) => row(page, name).locator('[data-column-type="numbers"]');
  await row(page, 'A').getByTestId('row-select').click();
  await row(page, 'C').getByTestId('row-select').click();
  await expect(page.getByTestId('batch-count')).toHaveText('2');

  // Hover a checked row's cell: the same column lights up in the other checked row, and says "2 items".
  await num('C').hover();
  await expect(num('C').getByTestId('bulk-hint')).toHaveText('יחול על 2 פריטים');
  const lit = (name: string) => num(name).evaluate((el) => getComputedStyle(el).boxShadow);
  await expect.poll(() => lit('A')).not.toBe('none');
  expect(await lit('B')).toBe('none'); // not checked
  // An unchecked row's cell does not.
  await num('B').hover();
  await expect(page.getByTestId('bulk-hint')).toHaveCount(0);
  // In and out before the page re-renders (as when the browser re-enters the cell once its editor closed under a
  // still pointer, and the pointer then moves away): the hint and the lit column do not stay behind.
  await page.mouse.move(1, 1);
  const lingers = await num('C').evaluate((el) => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }));
    return document.documentElement.hasAttribute('data-bulk-hover');
  });
  expect(lingers).toBe(false);
  await page.waitForTimeout(200); // let the page render the pass
  await expect(page.getByTestId('bulk-hint')).toHaveCount(0);

  await num('C').locator('> *').first().click();
  await page.keyboard.type('42');
  await page.keyboard.press('Enter');
  // Away from the cell: its "applies to 2 items" hint shows while it is hovered.
  await page.mouse.move(1, 1);
  await expect(page.getByTestId('toast').filter({ hasText: 'עודכן ב-2 פריטים' })).toBeVisible();
  await expect(num('A')).toHaveText('42');
  await expect(num('C')).toHaveText('42');
  await expect(num('B')).toHaveText('');
  // One undo for both.
  await page.getByTestId('toast').filter({ hasText: 'עודכן ב-2 פריטים' }).getByTestId('toast-action').click();
  await expect(num('A')).toHaveText('');
  await expect(num('C')).toHaveText('');
});

test('5 — a phone shows a real table: sticky names, sideways columns, bottom-sheet editors', async ({ page }) => {
  await newBoard(page, ['Phone one', 'Phone two'], ['סטטוס', 'מספרים', 'תאריך', 'טקסט']);
  await page.setViewportSize({ width: 390, height: 844 });
  const table = page.getByTestId('mobile-table');
  await expect(table).toHaveAttribute('data-layout', 'table');
  await expect(table.getByTestId('mobile-header-row').first()).toBeVisible();
  const name = row(page, 'Phone one').getByTestId('mobile-item-name');
  const before = (await name.boundingBox())!;
  expect(before.height).toBeLessThanOrEqual(44); // compact rows
  // Columns scroll sideways; the name stays put on its side (r25: the column narrows as the columns scroll under it,
  // so only its start edge — the right one in Hebrew — is fixed).
  const rtl = await page.evaluate(() => document.documentElement.dir === 'rtl');
  const start = (b: { x: number; width: number }) => (rtl ? b.x + b.width : b.x);
  await page.getByTestId('board-scroll').evaluate((el, r) => {
    el.scrollLeft = r ? -300 : 300;
  }, rtl);
  await page.waitForTimeout(300);
  const after = (await name.boundingBox())!;
  expect(Math.abs(start(after) - start(before))).toBeLessThan(2);

  // A tap on a status cell opens its editor as a bottom sheet.
  await row(page, 'Phone one').locator('[data-column-type="status"]').click();
  const sheet = page.getByTestId('popover');
  await expect(sheet).toHaveAttribute('data-sheet', 'true');
  // Measured once its opening animation (it grows from 97%) has finished.
  await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
  const box = (await sheet.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(389);
  expect(Math.abs(box.y + box.height - 844)).toBeLessThan(2);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // A tap on the name opens the item.
  await name.click();
  await expect(page).toHaveURL(/\/i\//);
  await page.getByRole('button', { name: 'סגירה' }).first().click();

  // The view can switch back to cards (on a phone the view settings sit in the bar's tools sheet).
  await page.getByTestId('mobile-filter-open').click();
  await page.getByTestId('mobile-filter-sheet').getByTestId('toolbar-view-settings').click();
  await page.getByTestId('view-mobile-layout').click();
  await page.getByRole('menuitemradio', { name: 'כרטיסים' }).click();
  await expect(page.getByTestId('mobile-table')).toHaveAttribute('data-layout', 'cards');
});

test('6 — colour themes: chosen in the profile, each AA in light and dark', async ({ page }) => {
  test.setTimeout(240_000);
  const boardId = await newBoard(page, ['Theme'], ['סטטוס', 'מספרים']);
  try {
    await page.goto('/a/demo/profile?tab=appearance');
    const picker = page.getByTestId('palette-picker');
    await expect(picker.getByRole('radio')).toHaveCount(5);
    await page.getByTestId('palette-ocean').click();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'ocean');
    await expect(page.getByTestId('palette-ocean')).toHaveAttribute('aria-checked', 'true');
    // Keyboard: the arrows move through the themes.
    await page
      .getByTestId('palette-ocean')
      .press((await page.evaluate(() => document.documentElement.dir)) === 'rtl' ? 'ArrowLeft' : 'ArrowRight');
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'plum');
    // The avatar menu's "מראה" has them too (same store).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-palette', 'plum');

    for (const palette of ['f4', 'ocean', 'plum', 'graphite', 'terracotta']) {
      for (const theme of ['light', 'dark'] as const) {
        await page.evaluate(
          ([p, th]) => {
            if (p === 'f4') localStorage.removeItem('bines:palette');
            else localStorage.setItem('bines:palette', p!);
            localStorage.setItem('bines:theme', th!);
          },
          [palette, theme],
        );
        await page.goto(`/a/demo/b/${boardId}`);
        await expect(row(page, 'Theme')).toBeVisible();
        await page.waitForTimeout(500);
        const bad = (await auditContrast(page, 'body')).filter((v) => !v.path.includes('[board-section]'));
        expect(bad, `${palette} ${theme}: ${JSON.stringify(bad.slice(0, 5), null, 1)}`).toEqual([]);
      }
    }
  } finally {
    await page.evaluate(() => {
      localStorage.removeItem('bines:palette');
      localStorage.removeItem('bines:theme');
    });
  }
});
