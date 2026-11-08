// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Audit 2026-10-10 round 3 (/): the board table is an ARIA grid; an empty board says
 * so with "add a first item" and the templates; an offline banner; the item card is a modal dialog with a role
 * description; between 640 and 767px a dialog is a bottom sheet like the rest of the phone layout.
 * "add a first item" also works on a phone.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page) => {
  const name = `נגישות ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  return name;
};

test('empty board: "add a first item" focuses the add field; the state goes with the first item', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page);
  const empty = page.getByTestId('board-empty');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('הבורד עדיין ריק');
  // The demo owner is an admin: the templates live in Administration.
  await expect(page.getByTestId('board-empty-templates')).toHaveAttribute('href', /\/admin\/templates$/);

  await page.getByTestId('board-empty-add').click();
  const field = page.locator('[data-add-item]').first();
  await expect(field).toBeFocused();
  await field.fill('ראשון');
  await field.press('Enter');
  await expect(row(page, 'ראשון')).toBeVisible({ timeout: 15_000 });
  await expect(empty).toHaveCount(0);

  // A search that hides everything is not an empty board.
  await page.getByTestId('toolbar-search').fill('zzz-nothing');
  await expect(page.getByTestId('board-empty')).toHaveCount(0);
});

test('the board table is an ARIA grid: rows with their index, column headers and cells', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = await newBoard(page);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const n of ['Alpha', 'Bravo']) {
    await add.fill(n);
    await add.press('Enter');
    await expect(row(page, n)).toBeVisible();
  }
  const grid = page.getByRole('grid', { name });
  await expect(grid).toBeVisible();
  const total = Number(await grid.getAttribute('aria-rowcount'));
  expect(total).toBeGreaterThanOrEqual(4); // title, header, two items (+ add, summary)
  // A new board has the name column only (+1 per column added).
  const cols = Number(await grid.getAttribute('aria-colcount'));
  expect(cols).toBeGreaterThanOrEqual(1);

  // The column headers: the name first, then each column, numbered.
  const headers = grid.getByRole('columnheader');
  await expect(headers.first()).toHaveAttribute('aria-colindex', '1');
  expect(await headers.count()).toBe(cols);

  // An item row: a row with its index, holding one gridcell per column, the name first.
  const alpha = grid.getByRole('row').filter({ has: row(page, 'Alpha') });
  await expect(alpha).toHaveCount(1);
  const index = Number(await alpha.getAttribute('aria-rowindex'));
  expect(index).toBeGreaterThan(0);
  expect(index).toBeLessThanOrEqual(total);
  const cells = alpha.getByRole('gridcell');
  expect(await cells.count()).toBe(cols);
  await expect(cells.first()).toHaveAttribute('aria-colindex', '1');
  await expect(cells.first()).toContainText('Alpha');

  // Rows that are not items (the group title, "+ add") hold one cell across the row.
  const addRow = grid.getByRole('row').filter({ has: page.getByPlaceholder(/\+ הוספת/) });
  await expect(addRow.getByRole('gridcell')).toHaveCount(1);
  await expect(addRow.getByRole('gridcell')).toHaveAttribute('aria-colspan', String(cols));

  // The item card: a modal dialog named by the item, described as an item card.
  await row(page, 'Alpha').hover();
  await row(page, 'Alpha').getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: 'Alpha' });
  await expect(card).toHaveAttribute('aria-modal', 'true');
  await expect(card).toHaveAttribute('aria-roledescription', 'כרטיס פריט');
});

test('offline: a banner says changes are not saved; it goes when the connection is back', async ({ page, context }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo');
  // Loaded first: going offline in the middle of the first load is the "no connection" error screen instead.
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('offline-banner')).toHaveCount(0);
  await context.setOffline(true);
  const banner = page.getByTestId('offline-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('role', 'status');
  await expect(banner).toContainText('אין חיבור לאינטרנט');
  await context.setOffline(false);
  await expect(banner).toHaveCount(0);
});

test('between 640 and 767px a dialog opens as a bottom sheet, like the phone layout around it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.setViewportSize({ width: 700, height: 900 });
  // A dialog of the profile page (the phone layout has no sidebar "+").
  await page.goto('/a/demo/profile');
  await page.getByTestId('profile-avatar').click();
  await page.getByTestId('profile-photo-avatar').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  // Full width, against the bottom edge.
  expect(box.width).toBeGreaterThan(690);
  expect(box.y + box.height).toBeGreaterThan(895);
});

/**
 * Accessibility stage 3: the accessibility statement is a published legal document, linked from the
 * sign-in page and from the help menu on every screen; the coordinator's details come from the owner's settings.
 */
test('the accessibility statement: linked from sign-in and the help menu, with the standard it follows', async ({
  page,
  browser,
}) => {
  // Seeded as a draft: the owner fills the coordinator and publishes it (as from the owner console).
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  await page.request.patch('/api/v1/platform/settings', {
    headers,
    data: {
      legal: {
        accessibility_coordinator: 'רכזת בדיקה',
        accessibility_phone: '03-0000000',
        accessibility_email: 'access@example.test',
      },
    },
  });
  expect((await page.request.post('/api/v1/platform/legal/accessibility/publish', { headers })).ok()).toBe(true);

  const out = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  const login = await out.newPage();
  await login.goto('/login');
  const link = login.getByTestId('legal-link-accessibility');
  await expect(link).toHaveText('הצהרת נגישות');
  // A new tab, like the other legal links.
  const [doc] = await Promise.all([out.waitForEvent('page'), link.click()]);
  await expect(doc.getByTestId('legal-doc-title')).toHaveText('הצהרת נגישות');
  await expect(doc.getByTestId('legal-doc')).toContainText('5568');
  await expect(doc.getByTestId('legal-doc')).toContainText('רכזת בדיקה');
  await out.close();

  await page.goto('/a/demo');
  await page.getByTestId('help-menu').click();
  const [tab] = await Promise.all([
    page.context().waitForEvent('page'),
    page.getByTestId('help-accessibility').click(),
  ]);
  await expect(tab.getByTestId('legal-doc-title')).toHaveText('הצהרת נגישות');
  await tab.close();

  // Also from the profile menu (so hiding "Help" in the bar never hides it) and from the owner console.
  await page.getByTestId('profile-menu').click();
  await expect(page.getByTestId('menu-accessibility')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.goto('/owner');
  await expect(page.getByTestId('owner-accessibility')).toHaveAttribute('href', /accessibility/);
});

test('empty board on a phone: "add a first item" goes to the phone add field', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = (p: string) => `/api/v1${p}`;
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const newApiBoard = async (name: string) =>
    (await (await page.request.post(api('/boards'), { headers, data: { name, workspace_id: ws } })).json()) as {
      id: string;
    };

  // The phone's table: the button goes to its "+ add" field (the field lost its mark before).
  const phone = await newApiBoard(`טלפון ${Date.now()}`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/demo/b/${phone.id}`);
  await page.getByTestId('board-empty-add').click();
  const field = page.locator('[data-add-item]').first();
  await expect(field).toBeFocused();
  await field.fill('מהטלפון');
  await field.press('Enter');
  await expect(page.getByTestId('board-empty')).toHaveCount(0);
});
