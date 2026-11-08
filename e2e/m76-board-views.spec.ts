// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn } from './helpers';

/** M7.6 board views: N4 update-count pill on tiles, N7 lane ⋯ menu in Kanban, N8 the phone calendar. */
// The local day (the calendar and the date picker choose "today" in the browser's time zone, not UTC).
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const label = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`; // calendar day button (the account's date format, A3)

const newView = async (page: Page, type: string, name: string) => {
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: new RegExp(type) }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('view-tab').filter({ hasText: name })).toHaveAttribute('aria-selected', 'true');
};

const names = (tiles: Locator) => tiles.evaluateAll((els) => els.map((e) => e.getAttribute('data-item-name')));

test('update counts on tiles, lane menu and the phone calendar', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תצוגות M7.6 ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of ['סטטוס', 'תאריך']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['Alpha', 'Bravo']) {
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

  // N4 — Cards: no pill without updates; one update on Alpha shows "1"; a click opens the card on Updates.
  await newView(page, 'כרטיסים', 'גלריה');
  const tile = (name: string) => page.locator(`[data-testid="item-tile"][data-item-name="${name}"]`);
  await expect(tile('Alpha')).toBeVisible();
  await expect(page.getByTestId('tile-update-count')).toHaveCount(0);
  await tile('Alpha').click();
  await expect(page).toHaveURL(/\/i\//);
  const itemId = /\/i\/([^/?#]+)/.exec(page.url())![1]!;
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/\/i\//);
  const { headers } = await ownerContext(page);
  expect((await page.request.post(`/api/v1/items/${itemId}/updates`, { headers, data: { body: 'עדכון' } })).ok()).toBe(
    true,
  );
  await page.reload();
  await expect(tile('Alpha').getByTestId('tile-update-count')).toHaveText('1');
  await expect(tile('Bravo').getByTestId('tile-update-count')).toHaveCount(0);
  await tile('Alpha').getByTestId('tile-update-count').click();
  await expect(page).toHaveURL(new RegExp(`/i/${itemId}.*tab=updates`));
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/\/i\//);

  // N4 + N7 — Kanban: the pill on the card; the lane ⋯ moves a lane, focuses its "+ item", edits its labels.
  await newView(page, 'קנבן', 'בורד');
  const lane = (name: string) =>
    page.getByTestId('kanban-lane').filter({ has: page.locator(`header:has-text("${name}")`) });
  await expect(lane('הושלם').getByTestId('tile-update-count')).toHaveText('1');
  const laneNames = () =>
    page.getByTestId('kanban-lane').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')));
  await expect.poll(laneNames).toEqual(['בתהליך', 'הושלם', 'חסום', 'ריק']);
  const laneMenu = async (name: string, item: string) => {
    await lane(name).getByTestId('lane-menu').click();
    await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
  };
  await laneMenu('הושלם', 'הזזה ימינה');
  await expect.poll(laneNames).toEqual(['הושלם', 'בתהליך', 'חסום', 'ריק']);
  await laneMenu('חסום', 'הזזה שמאלה');
  await expect.poll(laneNames).toEqual(['הושלם', 'בתהליך', 'ריק', 'חסום']);
  await laneMenu('בתהליך', 'פריט חדש בעמודה');
  await expect(lane('בתהליך').getByTestId('lane-add-input')).toBeFocused();
  await page.keyboard.type('Charlie');
  await page.keyboard.press('Enter');
  await expect.poll(() => names(lane('בתהליך').getByTestId('item-tile'))).toEqual(['Charlie']);
  await laneMenu('בתהליך', 'עריכת תוויות');
  await expect(page.getByTestId('label-editor')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('label-editor')).toBeHidden();

  // N8 — Calendar on a phone: dots per day, today chosen with its items, a tap chooses another day.
  await newView(page, 'לוח שנה', 'יומן');
  await page.setViewportSize({ width: 390, height: 844 });
  const day = (d: string) => page.locator(`[data-testid="cal-day"][data-date="${d}"]`);
  await expect(day(today)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('calendar-day')).toHaveCount(0);
  await expect.poll(() => names(page.getByTestId('cal-day-items').getByTestId('cal-day-item'))).toEqual(['Bravo']);
  const other = await page
    .getByTestId('cal-day')
    .evaluateAll((els, t) => els.map((e) => e.getAttribute('data-date')).find((d) => d !== t), today);
  await day(other!).click();
  await expect(day(other!)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('cal-day-items').getByTestId('cal-day-item')).toHaveCount(0);
  await day(today).click();
  await page.getByTestId('cal-day-items').getByTestId('cal-day-item').click();
  await expect(page).toHaveURL(/\/i\//);
});
