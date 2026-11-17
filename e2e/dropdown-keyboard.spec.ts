// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn, pickGroupColumn } from './helpers';

/** Fixes before M5: keyboard in label lists, the "created" column, date groups, built-in templates. */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, name: string, columns: string[]) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  for (const type of columns) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Item');
  await add.press('Enter');
  await expect(row(page, 'Item')).toBeVisible();
};

test('a dropdown list works from the keyboard: ↓ to the boxes, Enter toggles', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `מקלדת רשימה ${Date.now().toString(36)}`, ['רשימה נפתחת']);
  const cell = row(page, 'Item').locator('[data-column-type="dropdown"]');
  await cell.click();
  const search = page.getByTestId('popover').getByRole('textbox');
  for (const label of ['אדום', 'כחול']) {
    await search.fill(label);
    await search.press('Enter'); // creates the label and picks it
    await expect(cell.getByTestId('cell-value')).toContainText(label);
  }
  await expect(cell.getByTestId('cell-value')).toContainText('כחול');
  await page.keyboard.press('Escape');
  await expect(cell).toBeFocused();

  // Enter opens the list; ↓ goes to the first box; Enter takes "אדום" off; ↓ Enter takes "כחול" off.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  const boxes = page.getByTestId('popover').getByRole('checkbox');
  await expect(boxes.first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cell.getByTestId('cell-value')).not.toContainText('אדום');
  await page.keyboard.press('ArrowDown');
  await expect(boxes.nth(1)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(cell.getByTestId('cell-value')).not.toContainText('כחול');
});

test('the "created" column shows creator and date, date only or creator only', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `נוצר ${Date.now().toString(36)}`, ['יומן יצירה']);
  const cell = row(page, 'Item').locator('[data-column-type="creation_log"]');
  await expect(cell).toContainText(' · '); // who · when
  await expect(cell).toContainText(/\d{2}\/\d{2}\/\d{4}/);

  await page.getByRole('button', { name: /^פעולות לעמודה יומן יצירה/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'הגדרות עמודה' }).click();
  await page.getByTestId('creation-log-mode').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'תאריך בלבד' }).click();
  await page.getByTestId('column-settings-save').click();
  await expect(cell).not.toContainText(' · ');
  await expect(cell).toContainText(/^\s*\d{2}\/\d{2}\/\d{4}\s*$/);
});

test('grouping by a date column uses relative buckets (today, next week…)', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, `קיבוץ יום ${Date.now().toString(36)}`, ['תאריך']);
  await row(page, 'Item').locator('[data-column-type="date"]').click();
  await page.getByTestId('popover').getByRole('button', { name: 'היום', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByTestId('toolbar-group').click();
  await pickGroupColumn(page, /תאריך/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('board-section').first()).toContainText('היום');
});

test('admins remove a built-in template from the account', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  // Its own built-in, whatever the local account holds (s4f-e2e): the first built-in of the platform — brought back
  // first when an earlier run (or a person) removed it — and put back again at the end, so no run uses them up.
  const { headers } = await ownerContext(page);
  type Tpl = { key: string; name: string; account?: boolean };
  const list = async (path: string) =>
    ((await (await page.request.get(`/api/v1${path}`, { headers })).json()) as { data: Tpl[] }).data;
  const shown = (await list('/templates')).filter((t) => t.account === false);
  const hidden = await list('/templates/hidden');
  const tpl = [...shown, ...hidden].sort((a, b) => a.key.localeCompare(b.key))[0];
  expect(tpl, 'the platform has no built-in templates (seed)').toBeTruthy();
  const restore = async () => {
    if ((await list('/templates/hidden')).some((t) => t.key === tpl!.key))
      expect((await page.request.post(`/api/v1/templates/${tpl!.key}/restore`, { headers, data: {} })).ok()).toBe(true);
  };
  await restore();
  try {
    await page.goto('/a/demo/admin/templates');
    // Names may hold quotes (שו"ת): escaped for the attribute selector.
    const row = page
      .locator(`[data-testid="template-row"][data-name="${tpl!.name.replace(/"/g, '\\"')}"]`)
      .filter({ hasText: 'מובנית' });
    await expect(row).toHaveCount(1);
    await row.getByRole('button', { name: /^פעולות לתבנית/ }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'מחיקה' }).click();
    const removed = page.waitForResponse(
      (r) => r.request().method() === 'DELETE' && r.url().endsWith(`/templates/${encodeURIComponent(tpl!.key)}`),
    );
    await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
    expect((await removed).ok()).toBe(true);
    await expect(row).toHaveCount(0);
    expect((await list('/templates/hidden')).map((t) => t.key)).toContain(tpl!.key);
  } finally {
    await restore();
  }
});
