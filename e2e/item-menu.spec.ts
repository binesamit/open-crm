// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, rowMenu, signIn } from './helpers';

/** M3 step 2 (14): one registry menu per entity — right click = ⋯ = Shift+F10; shortcuts (Shift+?, Ctrl+Z). */
const openLeads = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.locator('aside a', { hasText: 'לידים' }).first().click();
};

const addItem = async (page: Page, name: string) => {
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
  await expect(row).toBeVisible();
  return row;
};

/**
 * Right click and choose `item`, retried as one step: Playwright scrolls the target into view first, and a menu
 * closes on scroll (by design), so a scroll that lands late can close it before the choice.
 */
const rightClickChoose = (page: Page, target: Locator, item: string | RegExp) =>
  expect(async () => {
    await target.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: item }).click({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });

/** The section (group) a row is rendered under — the table is a flat list of sections and rows. */
const sectionOf = (page: Page, name: string) =>
  page.evaluate((n) => {
    const all = [...document.querySelectorAll<HTMLElement>('[data-testid="board-section"],[data-testid="item-row"]')];
    const i = all.findIndex((e) => e.dataset.itemName === n);
    return all
      .slice(0, i)
      .filter((e) => e.dataset.testid === 'board-section')
      .pop()?.dataset.section;
  }, name);

test('item menu: right click, rename, move to group, Shift+F10', async ({ page }) => {
  await openLeads(page);
  const name = `תפריט ${Date.now().toString(36)}`;
  const row = await addItem(page, name);

  // Right click on the row opens the same menu as ⋯.
  // Right click opens the same menu as ⋯ (checked on its items, then rename from it).
  await expect(async () => {
    await row.getByText(name, { exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem').first()).toHaveText(/^פתיחה\s*Enter$/);
  await expect(menu.getByRole('menuitem', { name: 'פתיחה בכרטיסייה חדשה' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^מחיקה/ })).toContainText('Delete');
  await menu.getByRole('menuitem', { name: /^שינוי שם/ }).click();
  const renamed = `${name} ב`;
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(renamed);
  await page.keyboard.press('Enter');
  const row2 = page.locator(`[data-testid="item-row"][data-item-name="${renamed}"]`);
  await expect(row2).toBeVisible();

  // Move to another group from the submenu.
  const target = page.getByTestId('board-section').nth(1);
  const targetKey = await target.getAttribute('data-section');
  await rowMenu(page, row2, 'העברה לקבוצה');
  // The submenu lists the other groups in board order after its "back" row; the item sits in the first group.
  await page.getByRole('menu').getByRole('menuitem').nth(1).click();
  await expect.poll(() => sectionOf(page, renamed)).toBe(targetKey);

  // Keyboard: focus the row's ⋯ and press Shift+F10.
  await row2.hover();
  await row2.getByRole('button', { name: /^פעולות לפריט/ }).focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
});

test('group menu: add a group below, then delete it', async ({ page }) => {
  await openLeads(page);
  const sections = page.getByTestId('board-section');
  await expect(page.getByTestId('item-row').first()).toBeVisible();
  const before = await sections.count();
  const first = sections.first();
  await first.hover();
  await first.getByRole('button', { name: /^פעולות לקבוצה/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'קבוצה חדשה מתחת' }).click();
  await expect(sections).toHaveCount(before + 1);

  const added = sections.nth(1);
  await expect(added).toContainText('קבוצה חדשה');
  await rightClickChoose(page, added.getByText('קבוצה חדשה'), 'מחיקת קבוצה');
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(sections).toHaveCount(before);
});

test('shortcuts: Shift+? lists them, Ctrl+Z undoes the last delete', async ({ page }) => {
  await openLeads(page);
  await page
    .locator('main, body')
    .first()
    .click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Shift+?');
  const list = page.getByTestId('shortcuts');
  await expect(list).toContainText('Ctrl+Z');
  await expect(list).toContainText('Shift+F10');
  await page.keyboard.press('Escape');
  await expect(list).toHaveCount(0);

  const name = `קיצור ${Date.now().toString(36)}`;
  const row = await addItem(page, name);
  await rowMenu(page, row, /^מחיקה/);
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row).toHaveCount(0);
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('ControlOrMeta+Z');
  await expect(page.locator(`[data-testid="item-row"][data-item-name="${name}"]`)).toBeVisible();
});
