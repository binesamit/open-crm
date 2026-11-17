// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M2 (11-UI §4): Kanban, Calendar and Cards views over the same items and query as the table. */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const label = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`; // calendar day button (the account's date format, A3)

const newView = async (page: Page, type: string, name: string) => {
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: new RegExp(type) }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('view-tab').filter({ hasText: name })).toHaveAttribute('aria-selected', 'true');
};

/** Item names of tiles (a tile's text also holds its fields). */
const names = (tiles: Locator) => tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-item-name')));

/** Drags `from` onto `to`; `at` = where on the target (0 = its top edge, 1 = its bottom). */
const drag = async (page: Page, from: Locator, to: Locator, at = 0.5) => {
  await from.scrollIntoViewIfNeeded();
  const a = (await from.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 4 });
  const b = (await to.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height * at, 60), { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(250);
};

test('kanban, calendar and cards views', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`סוגי תצוגה ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of ['סטטוס', 'תאריך']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['Alpha', 'Bravo', 'Charlie']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(page.getByTestId('item-row').filter({ hasText: name })).toBeVisible();
  }
  const row = (name: string) => page.getByTestId('item-row').filter({ hasText: name });
  await row('Alpha').locator('[data-column-type="status"]').click();
  await page.getByTestId('popover').getByRole('button', { name: 'הושלם', exact: true }).click();
  await expect(row('Alpha').locator('[data-column-type="status"]')).toHaveText('הושלם');
  const today = iso(new Date());
  await row('Bravo').locator('[data-column-type="date"]').click();
  await page.getByRole('button', { name: label(today), exact: true }).click();
  await expect(row('Bravo').locator('[data-column-type="date"]')).not.toBeEmpty();

  // Kanban: a lane per label + blank; drag a card to set its status; add a card in a lane.
  await newView(page, 'קנבן', 'בורד');
  const lane = (name: string) =>
    page.getByTestId('kanban-lane').filter({ has: page.locator(`header:has-text("${name}")`) });
  await expect(page.getByTestId('kanban-lane')).toHaveCount(4);
  await expect.poll(() => names(lane('הושלם').getByTestId('item-tile'))).toEqual(['Alpha']);
  await expect(lane('ריק').getByTestId('item-tile')).toHaveCount(2);
  await drag(page, lane('ריק').getByTestId('item-tile').filter({ hasText: 'Charlie' }), lane('חסום'));
  await expect.poll(() => names(lane('חסום').getByTestId('item-tile'))).toEqual(['Charlie']);
  await lane('בתהליך').getByPlaceholder('+ פריט חדש').fill('Delta');
  await lane('בתהליך').getByPlaceholder('+ פריט חדש').press('Enter');
  await expect.poll(() => names(lane('בתהליך').getByTestId('item-tile'))).toEqual(['Delta']);
  await lane('בתהליך').getByPlaceholder('+ פריט חדש').fill('Echo');
  await lane('בתהליך').getByPlaceholder('+ פריט חדש').press('Enter');
  await expect.poll(() => names(lane('בתהליך').getByTestId('item-tile'))).toEqual(['Delta', 'Echo']);

  // Order inside a lane: Echo above Delta — and it stays after a reload.
  const tile = (laneName: string, name: string) => lane(laneName).getByTestId('item-tile').filter({ hasText: name });
  await drag(page, tile('בתהליך', 'Echo'), tile('בתהליך', 'Delta'), 0.1);
  await expect.poll(() => names(lane('בתהליך').getByTestId('item-tile'))).toEqual(['Echo', 'Delta']);
  // To another lane, at a chosen place: Alpha between Echo and Delta.
  await drag(page, tile('הושלם', 'Alpha'), tile('בתהליך', 'Delta'), 0.1);
  await expect.poll(() => names(lane('בתהליך').getByTestId('item-tile'))).toEqual(['Echo', 'Alpha', 'Delta']);
  await expect(lane('הושלם').getByTestId('item-tile')).toHaveCount(0);
  await page.reload();
  await expect.poll(() => names(lane('בתהליך').getByTestId('item-tile'))).toEqual(['Echo', 'Alpha', 'Delta']);

  // Lanes drag by their header; the order is a view setting (saved with the view).
  const laneNames = () =>
    page.getByTestId('kanban-lane').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')));
  await expect.poll(laneNames).toEqual(['בתהליך', 'הושלם', 'חסום', 'ריק']);
  await drag(page, lane('ריק').locator('header'), lane('בתהליך').locator('header'));
  await expect.poll(laneNames).toEqual(['ריק', 'בתהליך', 'הושלם', 'חסום']);
  await page.getByTestId('view-save').click();
  await expect(page.getByTestId('save-bar')).toBeHidden();
  await page.reload();
  await expect.poll(laneNames).toEqual(['ריק', 'בתהליך', 'הושלם', 'חסום']);

  // The table agrees.
  await page.getByTestId('view-tab').filter({ hasText: 'טבלה' }).click();
  await expect(row('Charlie').locator('[data-column-type="status"]')).toHaveText('חסום');
  await expect(row('Delta').locator('[data-column-type="status"]')).toHaveText('בתהליך');
  await expect(row('Alpha').locator('[data-column-type="status"]')).toHaveText('בתהליך');

  // Calendar: Bravo sits on today.
  await newView(page, 'לוח שנה', 'יומן');
  await expect.poll(() => names(page.locator(`[data-testid="calendar-item"][data-day="${today}"]`))).toEqual(['Bravo']);
  // A click on an item opens its card.
  await page.locator(`[data-testid="calendar-item"][data-day="${today}"]`).click();
  await expect(page).toHaveURL(/\/i\//);
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/\/i\//);

  // Cards: every item, filtered like everything else.
  await newView(page, 'כרטיסים', 'גלריה');
  await expect(page.getByTestId('cards').getByTestId('item-tile')).toHaveCount(5);
  await page.getByTestId('toolbar-search').fill('ha');
  await expect
    .poll(() => names(page.getByTestId('cards').getByTestId('item-tile')))
    .toEqual(expect.arrayContaining(['Alpha', 'Charlie']));
  await expect(page.getByTestId('cards').getByTestId('item-tile')).toHaveCount(2);
});
