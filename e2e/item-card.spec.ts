// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * M7.6 — the item card (N19 + N10/N11/N17/N18/N4/N16): breadcrumb and ⋯ menu in the header, the update count on
 * its tab, relative times, the short editor toolbar with "more", the timer in the time tab, the "fields" tab and the
 * board's tab settings (rename, hide, add a fields tab with chosen fields, reorder).
 */
const newBoard = async (page: Page) => {
  const name = `כרטיס ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  for (const type of ['טקסט', 'מעקב זמן']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Alpha');
  await add.press('Enter');
  return name;
};

const openCard = async (page: Page, itemName: string) => {
  const row = page.locator('div.grid', { hasText: itemName }).first();
  await row.hover();
  await row.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: itemName });
  await expect(card).toBeVisible();
  return card;
};

test('item card: header, updates, editor, timer, fields and tab settings', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardName = await newBoard(page);
  const card = await openCard(page, 'Alpha');

  // N10: "board / group" under the name; the board link opens the board; ⋯ = the item menu without "open".
  await expect(card.getByTestId('card-breadcrumb')).toContainText(boardName);
  await card.getByTestId('card-more').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: /שינוי שם/ })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /^פתיחה(?! בכרטיסייה)/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // N18: six tools + "more"; the rest of the formats are in the menu. the idle, empty update box is
  // one closed line — the toolbar shows once it is opened.
  await card.getByLabel(/כתבו עדכון/).click();
  const toolbar = card.getByRole('toolbar', { name: 'עיצוב טקסט' });
  await expect(toolbar.getByRole('button')).toHaveCount(7);
  for (const name of ['מודגש', 'נטוי', 'רשימת תבליטים', 'קישור', 'תיוג', 'אימוג׳י']) {
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible();
  }
  await page.keyboard.type('שורה ');
  await toolbar.getByTestId('rich-more').click();
  for (const name of [
    'קו תחתון',
    'קו חוצה',
    'הדגשת רקע',
    'רשימה ממוספרת',
    'רשימת משימות',
    'ציטוט',
    'קוד',
    'קו מפריד',
  ]) {
    await expect(page.getByRole('menu').getByRole('menuitem', { name })).toBeVisible();
  }
  await page.getByRole('menu').getByRole('menuitem', { name: 'קו תחתון' }).click();
  // Typed the moment the menu closes, the first letter can land out of place: wait for the editor's focus.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(card.getByLabel(/כתבו עדכון/).first()).toBeFocused();
  await page.keyboard.type('חשובה');

  // N4 + N17: post → the tab counts 1 and the time is relative, with the exact time on hover.
  await card.getByRole('button', { name: 'עדכון', exact: true }).click();
  const update = card.locator('article').first();
  await expect(update.locator('.update-body u')).toHaveText('חשובה');
  await expect(card.getByTestId('card-updates-count')).toHaveText('1');
  const stamp = update.locator('time').first();
  await expect(stamp).toHaveText('עכשיו');
  // The exact time is the system tooltip (data-tip) of the button around the relative time — a click on it opens
  // the update alone (s37reply2), so the tooltip sits on the button, not on <time>.
  const timeButton = update.getByTestId('update-time').first();
  await expect
    .poll(() => timeButton.evaluate((el) => el.getAttribute('title') ?? el.getAttribute('data-tip')))
    .toMatch(/\d/);

  // N11: the time tab has a timer button for the board's time column.
  await card.locator('[data-testid="card-tab"][data-tab-id="time"]').click();
  const timer = card.getByTestId('card-timer');
  await expect(timer).toHaveText(/הפעלת טיימר/);
  await timer.click();
  await expect(timer).toHaveAttribute('data-running', 'true');
  await expect(timer).toHaveText(/עצירת טיימר/);
  await expect(card.getByTestId('time-entry')).toHaveCount(1);
  await timer.click();
  await expect(timer).toHaveAttribute('data-running', 'false');

  // N19א: the "fields" tab edits the item's columns with the table's editors.
  await card.locator('[data-testid="card-tab"][data-tab-id="fields"]').click();
  const fields = card.getByTestId('card-field');
  await expect(fields).toHaveCount(2);
  const text = fields.filter({ hasText: 'טקסט' });
  await text.locator('[data-column-type="text"]').click();
  await page.keyboard.type('ערך מהכרטיס');
  await page.keyboard.press('Enter');
  await expect(text).toContainText('ערך מהכרטיס');
  await expect(page.locator('div.grid', { hasText: 'Alpha' }).first()).toContainText('ערך מהכרטיס');

  // N19ב: tab settings — rename activity, hide time, add a fields tab with only the text column, move it first.
  await card.getByTestId('card-tabs-settings').click();
  const dialog = page.getByTestId('card-tab-settings-dialog');
  await expect(dialog).toBeVisible();
  const row = (id: string) => dialog.locator(`[data-testid="card-tab-row"][data-id="${id}"]`);
  await row('activity').getByTestId('card-tab-title').fill('היסטוריה');
  await row('time').getByTestId('card-tab-visible').click();
  await dialog.getByTestId('card-tab-add').click();
  const picker = dialog.getByTestId('card-tab-fields-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('card-tab-column-toggle').nth(1).click(); // off: the time column
  const added = dialog.getByTestId('card-tab-row').last();
  const addedId = await added.getAttribute('data-id');
  await added.getByTestId('card-tab-title').fill('פרטים');
  // Drag the new tab above "fields" (the first movable row).
  const handle = added.getByRole('button', { name: 'גרירה לשינוי סדר הלשוניות' });
  const target = row('fields');
  const from = (await handle.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y - 10, { steps: 5 });
  await page.mouse.move(from.x + from.width / 2, to.y + 4, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  await page.getByTestId('card-tabs-save').click();
  await expect(dialog).toBeHidden();

  const tabs = card.getByTestId('card-tab');
  await expect(tabs.first()).toHaveAttribute('data-tab-id', 'updates');
  await expect(tabs.nth(1)).toHaveAttribute('data-tab-id', addedId!);
  await expect(card.locator('[data-testid="card-tab"][data-tab-id="time"]')).toHaveCount(0);
  await expect(card.locator('[data-testid="card-tab"][data-tab-id="activity"]')).toHaveText('היסטוריה');
  await tabs.nth(1).click();
  await expect(card.getByTestId('card-field')).toHaveCount(1);
  await expect(card.getByTestId('card-field')).toContainText('ערך מהכרטיס');

  // Saved on the board: another item's card has the same tabs.
  await card.getByRole('button', { name: 'סגירה' }).click();
  await expect(card).toBeHidden();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Beta');
  await add.press('Enter');
  const beta = await openCard(page, 'Beta');
  await expect(beta.locator(`[data-testid="card-tab"][data-tab-id="${addedId}"]`)).toHaveText('פרטים');
  await expect(beta.getByTestId('card-updates-count')).toHaveCount(0);

  // The breadcrumb's board link goes back to the board.
  await beta.getByTestId('card-breadcrumb-board').click();
  await expect(beta).toBeHidden();
  await expect(page).not.toHaveURL(/\/i\//);
});

test('item card on a phone: full screen with a back button and the fields tab', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.locator('aside a', { hasText: 'לידים' }).first().click();
  const name = `נייד ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const card = await openCard(page, name);
  await page.setViewportSize({ width: 390, height: 844 });
  const box = (await card.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(389);
  await card.locator('[data-testid="card-tab"][data-tab-id="fields"]').click();
  await expect(card.getByTestId('card-field').first()).toBeVisible();
  await card.getByRole('button', { name: 'סגירה' }).click();
  await expect(card).toBeHidden();
});
