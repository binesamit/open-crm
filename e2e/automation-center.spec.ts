// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, rowMenu, signIn } from './helpers';

/**
 * M7.6 "screens": the automation center's "יצירת אוטומציה" and per-row ⋯ (N12, also on the account page), the
 * archive's "פתיחה" (N14), the permissions dialog's restricted-columns list (N15), relative times (N17).
 */
const newBoard = async (page: Page, name: string) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
};

const addItem = async (page: Page, name: string) => {
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
  await expect(row).toBeVisible();
  return row;
};

const autoRowMenu = async (page: Page, row: ReturnType<Page['locator']>, item: string) => {
  await row.getByTestId('auto-row-menu').click();
  await page.getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click();
};

test('automation center: create button, ⋯ per row (duplicate, on/off, delete), account page ⋯', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  const boardName = `אוטו76 ${run}`;
  await newBoard(page, boardName);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'סטטוס', exact: true }).click();

  await page.getByTestId('board-automations').click();
  const dialog = page.getByTestId('automations-dialog');
  await expect(dialog).toBeVisible();
  // "יצירת אוטומציה" opens the templates.
  await dialog.getByTestId('auto-create').click();
  await page.locator('[data-testid="automation-template"][data-id="created_set_status"]').click();
  const builder = page.getByTestId('automation-builder');
  await builder.locator('[data-slot="actions.0.column"]').click();
  await page.getByTestId('slot-option').filter({ hasText: 'סטטוס' }).first().click();
  await builder.locator('[data-slot="actions.0.label"]').click();
  await page.getByTestId('slot-option').filter({ hasText: /\S/ }).first().click();
  await page.getByTestId('auto-title').fill(`סטטוס ${run}`);
  await page.getByTestId('auto-save').click();

  const row = page.locator(`[data-testid="automation-row"][data-title="סטטוס ${run}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText('עוד לא רצה');

  // ⋯ → duplicate: a copy, switched off.
  await autoRowMenu(page, row, 'שכפול');
  const copy = page.locator(`[data-testid="automation-row"][data-title="סטטוס ${run} (עותק)"]`);
  await expect(copy).toBeVisible();
  await expect(copy.getByTestId('automation-toggle')).toHaveAttribute('aria-checked', 'false');
  // ⋯ → on.
  await autoRowMenu(page, copy, 'הפעלה');
  await expect(copy.getByTestId('automation-toggle')).toHaveAttribute('aria-checked', 'true');
  // ⋯ → history opens the runs.
  await autoRowMenu(page, copy, 'היסטוריה');
  await expect(page.getByTestId('automation-runs')).toBeVisible();
  await page.getByTestId('automation-runs').press('Escape');
  await page.getByRole('button', { name: 'סגירת החלון' }).last().click();

  // The account page: the same ⋯ — "פתיחת הבורד" leads to the board.
  await page.getByTestId('nav-automations').click();
  const allRow = page.locator(`[data-testid="autoall-row"][data-title="סטטוס ${run}"]`);
  await expect(allRow).toBeVisible();
  await allRow.getByTestId('auto-row-menu').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'שכפול', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'פתיחת הבורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(boardName);

  // ⋯ → delete (both, keeps the local account clean).
  await page.getByTestId('board-automations').click();
  for (const r of [copy, row]) {
    await autoRowMenu(page, r, 'מחיקה');
    await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
    await expect(r).toHaveCount(0);
  }
});

test('archive: "פתיחה" opens an archived item card and an archived board', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  const boardName = `ארכיון76 ${run}`;
  await newBoard(page, boardName);
  const itemName = `מדף ${run}`;
  await rowMenu(page, await addItem(page, itemName), 'העברה לארכיון');
  await expect(page.locator(`[data-testid="item-row"][data-item-name="${itemName}"]`)).toHaveCount(0);

  await page.getByTestId('profile-menu').click();
  await page.getByTestId('menu-archive').click();
  const entry = page.locator(`[data-testid="archive-row"][data-name="${itemName}"]`).first();
  await expect(entry).toBeVisible();
  // Relative time (N17): just archived.
  await expect(entry).toContainText(/עכשיו|לפני/);
  await entry.getByTestId('archive-open').click();
  await expect(page).toHaveURL(/\/i\//);
  await expect(page.getByRole('dialog', { name: itemName })).toBeVisible();

  // The board itself: archived from the sidebar, opened from the archive → the restore banner.
  await page.goto(page.url().replace(/\/i\/.*$/, ''));
  const sidebarRow = page.getByTestId('board-row').filter({ hasText: boardName });
  await sidebarRow.hover();
  await sidebarRow.getByRole('button', { name: /^פעולות ל/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'העברה לארכיון' }).click();
  await expect(page.getByTestId('board-row').filter({ hasText: boardName })).toHaveCount(0);
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('menu-archive').click();
  await page
    .locator(`[data-testid="archive-row"][data-name="${boardName}"]`)
    .first()
    .getByTestId('archive-open')
    .click();
  await expect(page.getByTestId('archived-banner')).toBeVisible();
  await page.getByTestId('archived-banner').getByRole('button', { name: 'שחזור' }).click();
  await expect(page.getByTestId('archived-banner')).toHaveCount(0);
});

test('permissions: only restricted columns are listed; add, change the kind, remove', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  await newBoard(page, `הגבלות ${run}`);
  // A column to restrict (a new board has only the name column).
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByTestId('add-column-search').fill('טקסט');
  await page.getByTestId('add-column-search').press('Enter');
  await expect(page.getByTestId('header-row').getByText('טקסט', { exact: true })).toBeVisible();

  await page.getByTestId('board-more').click();
  await page.getByTestId('board-permissions').click();
  const dialog = page.getByTestId('permissions-dialog');
  await expect(dialog.getByTestId('perm-columns-empty')).toBeVisible();
  await expect(dialog.locator('[data-testid="perm-column"]')).toHaveCount(0);

  // + הגבלה → the column → the kind.
  await dialog.getByTestId('perm-add-restriction').click();
  const first = page.getByRole('menu').getByRole('menuitem').first();
  const title = (await first.locator('span').first().textContent())!.trim();
  await first.click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'צפייה מוגבלת' }).click();
  const column = dialog.locator(`[data-testid="perm-column"][data-title="${title}"]`);
  await expect(column).toHaveAttribute('data-kind', 'view');
  await expect(column.getByTestId('perm-column-allowed')).toHaveText(/רק בעלים/);
  await expect(dialog.locator('[data-testid="perm-column"]')).toHaveCount(1);

  // The kind chip changes it.
  await column.getByTestId('perm-column-kind').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'עריכה מוגבלת' }).click();
  await expect(column).toHaveAttribute('data-kind', 'edit');

  // ✕ removes it: the list is empty again.
  await column.getByTestId('perm-column-remove').click();
  await expect(dialog.locator('[data-testid="perm-column"]')).toHaveCount(0);
  await expect(dialog.getByTestId('perm-columns-empty')).toBeVisible();
});

test('trash: relative times — deleted just now, purged in N days', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.locator('aside a', { hasText: 'לידים' }).first().click();
  const name = `יחסי ${Date.now().toString(36)}`;
  const row = await addItem(page, name);
  await rowMenu(page, row, /^מחיקה/);
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row).toHaveCount(0);

  await page.getByTestId('profile-menu').click();
  await page.getByTestId('menu-trash').click();
  await page.getByLabel('חיפוש בסל').fill(name);
  const entry = page.locator(`[data-testid="trash-row"][data-name="${name}"]`);
  await expect(entry).toContainText(/עכשיו|לפני/);
  await expect(entry).toContainText(/בעוד \d+ ימים/);
  // title, or data-tip once hovered (fix6)
  await expect
    .poll(() =>
      entry
        .locator('time')
        .first()
        .evaluate((el) => el.getAttribute('title') ?? el.getAttribute('data-tip')),
    )
    .toMatch(/\d/);
  // Keep the local account clean.
  await entry.getByTestId('trash-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה לצמיתות' }).click();
  await expect(entry).toHaveCount(0);
});
