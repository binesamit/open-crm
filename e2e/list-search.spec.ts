// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Fix: #3 — every long list is searchable: the add-column type list, the column menu's "add column
 * right/left" types, the filter's column picker, and the automation builder's pickers (a Menu and a slot list).
 * Typing narrows the list; Enter picks the first match; Esc clears the search before it closes.
 */
const headers = (page: Page) => page.getByTestId('header-row').first().locator('[data-header]');
const header = (page: Page, title: string) => headers(page).filter({ hasText: title });

const addColumn = async (page: Page, search: string, title: string) => {
  await expect(async () => {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await expect(page.getByTestId('add-column-search')).toBeVisible({ timeout: 1000 });
  }).toPass();
  const all = await page.getByTestId('add-column-type').count();
  await page.getByTestId('add-column-search').fill(search);
  await expect.poll(() => page.getByTestId('add-column-type').count()).toBeLessThan(all);
  await page.getByTestId('add-column-search').press('Enter');
  await expect(header(page, title)).toHaveCount(1);
};

test('long lists have a search: add column, column menu, filter, automations', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`רשימות ${run}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();

  // The "+" type list (its own search): a few letters, Enter adds the match.
  await addColumn(page, 'סטט', 'סטטוס');
  await addColumn(page, 'טקס', 'טקסט');
  await addColumn(page, 'מספ', 'מספרים');
  await addColumn(page, 'טלפ', 'טלפון');
  await addColumn(page, 'אימ', 'אימייל');
  await addColumn(page, 'קיש', 'קישור');
  await addColumn(page, 'דיר', 'דירוג');
  await addColumn(page, 'אנש', 'אנשים');

  // Column menu: the action menu keeps its look (no search); its "add right" types list is searchable.
  await header(page, 'טקסט').hover();
  await header(page, 'טקסט').getByRole('button', { name: 'פעולות לעמודה טקסט' }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByTestId('menu-search')).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'הוספת עמודה מימין' }).click();
  const search = menu.getByTestId('menu-search');
  await expect(search).toBeFocused();
  const allTypes = await menu.getByRole('menuitem').count();
  await page.keyboard.type('תאר');
  await expect.poll(() => menu.getByRole('menuitem').count()).toBeLessThan(allTypes);
  await expect(menu.getByRole('menuitem', { name: 'תאריך', exact: true })).toBeVisible();
  // Nothing matches: the empty state; Esc clears the search and the menu stays open.
  await search.fill('zzzz');
  await expect(menu.getByTestId('list-no-results')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(search).toHaveValue('');
  await expect(menu).toBeVisible();
  await page.keyboard.type('תאר');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(header(page, 'תאריך')).toHaveCount(1);

  // Filter → condition → column picker.
  await page.getByTestId('toolbar-filter').click();
  await page.getByTestId('filter-rail-advanced').click();
  await page.getByTestId('filter-add-rule').click();
  await page.getByTestId('rule-column').last().click();
  const picker = page.getByRole('menu');
  await expect(picker.getByTestId('menu-search')).toBeFocused();
  const allFields = await picker.getByRole('menuitemradio').count();
  await page.keyboard.type('מספ');
  await expect.poll(() => picker.getByRole('menuitemradio').count()).toBeLessThan(allFields);
  await expect(picker.getByRole('menuitemradio').first()).toHaveText(/מספרים/);
  // ↓ moves into the matches, Enter picks.
  await page.keyboard.press('ArrowDown');
  await expect(picker.getByRole('menuitemradio').first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('rule-column').last()).toHaveText('מספרים');
  await page.keyboard.press('Escape');

  // Automations: the trigger-type menu and the column slot list.
  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  await page.locator('[data-testid="automation-template"][data-id="created_set_status"]').click();
  const builder = page.getByTestId('automation-builder');
  await expect(builder).toBeVisible();

  await page.getByTestId('auto-trigger-type').click();
  const triggers = page.getByRole('menu');
  await expect(triggers.getByTestId('menu-search')).toBeFocused();
  await page.keyboard.type('ארכיון');
  await expect(triggers.getByRole('menuitemradio')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('auto-trigger-type')).toHaveText(/כשפריט עובר לארכיון/);

  await page.getByTestId('auto-add-action').click();
  await page.keyboard.type('ערך בעמ');
  await page.keyboard.press('Enter');
  await builder.locator('[data-slot="actions.1.column"]').click();
  const slotSearch = page.getByTestId('slot-search');
  await expect(slotSearch).toBeFocused();
  const allColumns = await page.getByTestId('slot-option').count();
  await slotSearch.fill('טלפ');
  await expect.poll(() => page.getByTestId('slot-option').count()).toBeLessThan(allColumns);
  await slotSearch.press('Enter');
  await expect(builder.locator('[data-slot="actions.1.column"]')).toHaveText('טלפון');
});
