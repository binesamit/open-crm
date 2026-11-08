// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn, pickGroupColumn } from './helpers';

/**
 * M2 (13-FILTERS, 15-VIEWS): search, quick + advanced filter, sort, hide, group by — all as a draft that survives
 * a refresh — then "save as new view", switching views, saving to a view and resetting.
 */
const setup = async (page: Page) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תצוגות ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'סטטוס', exact: true }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(page.getByTestId('item-row').filter({ hasText: name })).toBeVisible();
  }
  for (const [name, label] of [
    ['Alpha', 'הושלם'],
    ['Bravo', 'חסום'],
  ]) {
    await page.getByTestId('item-row').filter({ hasText: name! }).locator('[data-column-type="status"]').click();
    await page.getByTestId('popover').getByRole('button', { name: label!, exact: true }).click();
    await expect(
      page.getByTestId('item-row').filter({ hasText: name! }).locator('[data-column-type="status"]'),
    ).toHaveText(label!);
  }
};

const names = (page: Page) =>
  page.getByTestId('item-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-item-name')));

test('search, filter, sort, hide and group as a draft; save as a view', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await setup(page);
  const saveBar = page.getByTestId('save-bar');
  await expect(saveBar).toBeHidden();

  // Search narrows as you type.
  await page.getByTestId('toolbar-search').fill('bra');
  await expect.poll(() => names(page)).toEqual(['Bravo']);
  // Round 11: the search is the board's (kept across views), not a change to the view.
  await expect(saveBar).toBeHidden();
  await page.getByTestId('toolbar-search').fill('');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  await expect(saveBar).toBeHidden();

  // Quick filter: status = הושלם.
  await page.getByTestId('toolbar-filter').click();
  const panel = page.getByTestId('filter-panel');
  await panel.locator('[data-testid^="filter-rail-status"]').click();
  await panel.locator('[data-testid^="quick-status"]').getByRole('button', { name: /הושלם/ }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha']);
  await expect(page.getByTestId('filter-count')).toHaveText('1 תואמים');
  await expect(panel.getByTestId('filter-active-chip')).toHaveCount(1);

  // Advanced: … OR name contains "char".
  await panel.getByTestId('filter-rail-advanced').click();
  await panel.getByTestId('filter-add-rule').click();
  const rule = panel.getByTestId('filter-rule').last();
  await rule.getByTestId('rule-column').click();
  await page.getByRole('menuitemradio', { name: 'שם', exact: true }).click();
  await rule.getByTestId('rule-operator').click();
  await page.getByRole('menuitemradio', { name: 'מכיל', exact: true }).click();
  await rule.getByTestId('rule-text').fill('char');
  await expect.poll(() => names(page)).toEqual([]); // AND: no item is both done and named "char…"
  await expect(page.getByTestId('no-results')).toBeVisible();
  await panel.getByTestId('filter-combinator').click();
  await page.getByRole('menuitemradio', { name: 'או', exact: true }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Charlie']);
  // Owner fix 5: no chips — the filter button counts the conditions.
  await expect(page.getByTestId('toolbar-filter-count')).toHaveText('2');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  // Sort by name, descending.
  await page.getByTestId('toolbar-sort').click();
  await page.getByTestId('sort-add').click();
  await page.getByTestId('sort-row').getByRole('button', { name: 'יורד' }).click();
  await expect.poll(() => names(page)).toEqual(['Charlie', 'Alpha']);
  await page.keyboard.press('Escape');

  // Hide the status column.
  await page.getByTestId('toolbar-hide').click();
  await page.getByTestId('hide-panel').getByRole('checkbox', { name: /סטטוס/ }).click();
  await expect(page.locator('[data-header^="status"]')).toHaveCount(0);
  await expect(page.getByTestId('toolbar-hide')).toContainText('1 מוסתרות');
  await page.keyboard.press('Escape');

  // The draft survives a refresh (sessionStorage + ?q=).
  await expect(page).toHaveURL(/[?&]q=/);
  await page.reload();
  await expect.poll(() => names(page)).toEqual(['Charlie', 'Alpha']);
  await expect(saveBar).toContainText('שינויים שלא נשמרו');

  // On the default table "save" = a new view (it never changes): it opens, clean; the default table is untouched.
  await expect(page.getByTestId('view-save-new')).toHaveCount(0);
  await expect(page.getByTestId('view-save')).toHaveText('שמירה כתצוגה חדשה');
  await page.getByTestId('view-save').click();
  await page.getByRole('dialog').getByRole('textbox').fill('שלי');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  const tabs = page.getByTestId('view-tab');
  await expect(tabs.filter({ hasText: 'שלי' })).toHaveAttribute('aria-selected', 'true');
  await expect(saveBar).toBeHidden();
  await expect.poll(() => names(page)).toEqual(['Charlie', 'Alpha']);

  await tabs.filter({ hasText: 'טבלה' }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  await expect(page.locator('[data-header^="status"]')).toHaveCount(1);
  await expect(saveBar).toBeHidden();

  // Group by status in the default table: one section per label, the blank last; reset drops it.
  await page.getByTestId('toolbar-group').click();
  await pickGroupColumn(page, 'סטטוס');
  await page.keyboard.press('Escape');
  const sections = page.getByTestId('board-section');
  await expect(sections).toHaveCount(3);
  await expect(sections.first()).toContainText('הושלם');
  await expect(sections.last()).toContainText('ללא ערך');
  await page.getByTestId('view-reset').click();
  await expect(sections).toHaveCount(1);

  // Saving to the custom view persists for the next visit.
  await tabs.filter({ hasText: 'שלי' }).click();
  await page.getByTestId('toolbar-filter').click();
  await page.getByTestId('filter-panel').locator('[data-testid^="filter-rail-status"]').click();
  await page
    .getByTestId('filter-panel')
    .locator('[data-testid^="quick-status"]')
    .getByRole('button', { name: /הושלם/ })
    .click();
  await page.keyboard.press('Escape');
  await expect.poll(() => names(page)).toEqual(['Alpha']);
  await page.getByTestId('view-save').click();
  await expect(saveBar).toBeHidden();
  await page.goto(page.url().replace(/[?&]q=[^&]*/, ''));
  await expect(tabs.filter({ hasText: 'שלי' })).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => names(page)).toEqual(['Alpha']);
  await expect(saveBar).toBeHidden();
});

test('group menu opens above the rows; columns reorder from the Hide panel', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`סדר ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of ['טקסט', 'מספרים']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['One', 'Two', 'Three']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(page.getByTestId('item-row').filter({ hasText: name })).toBeVisible();
  }

  // The ⋯ menu of a group is on top of the rows below it: its colours are clickable.
  await page
    .getByTestId('board-section')
    .getByRole('button', { name: /^פעולות לקבוצה/ })
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'צבע' }).click();
  const menu = page.getByTestId('popover');
  await menu.locator('[data-testid="group-color"][data-color="forest"]').click();
  // r15: the colour picker stays open after a pick (outside click / Esc close it).
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  // D-PAL: the group's colour is a bar beside its name and the name itself (green-dominant for forest).
  const greenish = (testId: string, prop: 'backgroundColor' | 'color') => async () => {
    const c = await page
      .getByTestId('board-section')
      .getByTestId(testId)
      .evaluate((el, p) => getComputedStyle(el)[p], prop);
    const [r, g, b] = (c.match(/[\d.]+/g) ?? []).map(Number).slice(-3);
    return g! > r! && g! > b!;
  };
  await expect.poll(greenish('group-bar', 'backgroundColor')).toBe(true);
  await expect.poll(greenish('group-color', 'color')).toBe(true);

  // Drag "מספרים" above "טקסט" in the Hide panel: the table follows.
  const headers = () =>
    page
      .getByTestId('header-row')
      .first()
      .locator('[data-header]')
      .evaluateAll((els) => els.map((e) => e.textContent?.replace('⋯', '').trim()));
  await expect.poll(headers).toEqual(['טקסט', 'מספרים']);
  await page.getByTestId('toolbar-hide').click();
  const rows = page.getByTestId('hide-row');
  const handle = rows.filter({ hasText: 'מספרים' }).getByLabel('גרירה לשינוי סדר העמודות');
  const a = (await handle.boundingBox())!;
  const b = (await rows.filter({ hasText: 'טקסט' }).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y - 6, { steps: 4 });
  await page.mouse.move(a.x + a.width / 2, b.y + 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(headers).toEqual(['מספרים', 'טקסט']);
  await page.keyboard.press('Escape');
  // on the default table (column order "shared", the default) a drag is the board's order at once
  // no draft, no save bar, and it stays after a reload.
  await expect(page.getByTestId('save-bar')).toBeHidden();
  await page.reload();
  await expect.poll(headers).toEqual(['מספרים', 'טקסט']);
  // Dragging a header back saves the same way.
  const header = (title: string) => page.getByTestId('header-row').first().locator('[data-header]', { hasText: title });
  const to = (await header('מספרים').boundingBox())!;
  const from = (await header('טקסט').boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect.poll(headers).toEqual(['טקסט', 'מספרים']);
  await expect(page.getByTestId('save-bar')).toBeHidden();
  await page.reload();
  await expect.poll(headers).toEqual(['טקסט', 'מספרים']);
});
