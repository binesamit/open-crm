// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Prod (our own look, canvas v3): the filter panel is a side rail of columns + one column's values in the
 * middle + an "active" row of removable chips; "תנאים מתקדמים" opens the same builder as before (and/or, nested
 * groups, negation). The item's update box is a closed one-line box while idle and empty.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const names = (page: Page) =>
  page.getByTestId('item-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-item-name')));

const newBoard = async (page: Page, items: string[], status = false) => {
  const name = `d6 ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  if (status) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: 'סטטוס', exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const item of items) {
    await add.fill(item);
    await add.press('Enter');
    await expect(row(page, item)).toBeVisible();
  }
};

const setStatus = async (page: Page, item: string, label: string) => {
  await row(page, item).locator('[data-column-type="status"]').click();
  await page.getByTestId('popover').getByRole('button', { name: label, exact: true }).click();
  await expect(row(page, item).locator('[data-column-type="status"]')).toHaveText(label);
};

test('filter panel: rail, one column of values, active chips, and the same advanced builder', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['Alpha', 'Bravo', 'Charlie'], true);
  await setStatus(page, 'Alpha', 'הושלם');
  await setStatus(page, 'Bravo', 'חסום');

  const button = page.getByTestId('toolbar-filter');
  await expect(button).toHaveText('סינון');
  await button.click();
  const panel = page.getByTestId('filter-panel');
  const rail = panel.getByTestId('filter-rail');
  await expect(rail.getByTestId('filter-rail-__group__')).toBeVisible();
  await expect(rail.getByTestId('filter-rail-advanced')).toHaveText(/תנאים מתקדמים/);
  // Nothing on: it opens on the first column, with no chips.
  await expect(panel).toHaveAttribute('data-section', '__group__');
  await expect(panel.getByTestId('filter-active-chip')).toHaveCount(0);
  await expect(panel.getByTestId('filter-clear')).toBeDisabled();

  // The status column: a check list with search, coloured labels, counts and "ללא סטטוס".
  await rail.locator('[data-testid^="filter-rail-status"]').click();
  const values = panel.locator('[data-testid^="quick-status"]');
  await expect(values.locator('[data-testid^="quick-search-"]')).toBeVisible();
  await expect(values.getByRole('button', { name: /ללא סטטוס/ })).toContainText('1');
  await values.getByRole('button', { name: /הושלם/ }).click();
  await values.getByRole('button', { name: /חסום/ }).click();
  await expect(values.getByRole('button', { name: /הושלם/ })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Bravo']);
  await expect(rail.locator('[data-testid^="filter-rail-count-status"]')).toHaveText('2');
  await expect(panel.getByTestId('filter-count')).toHaveText('2 תואמים');
  const chips = panel.getByTestId('filter-active-chip');
  await expect(chips).toHaveCount(1);
  await expect(chips.first()).toContainText('הושלם, חסום');

  // The search narrows the list.
  await values.locator('[data-testid^="quick-search-"]').fill('חס');
  await expect(values.getByRole('button', { name: /הושלם/ })).toHaveCount(0);
  await expect(values.getByRole('button', { name: /חסום/ })).toBeVisible();

  // Advanced conditions: the same builder — a rule, AND/OR, a nested group with "not".
  await rail.getByTestId('filter-rail-advanced').click();
  await expect(panel.getByTestId('filter-advanced')).toBeVisible();
  await expect(panel.getByTestId('filter-rule')).toHaveCount(1); // the quick pick is a rule here too
  await panel.getByTestId('filter-group-1').getByTestId('filter-add-group').last().click();
  const inner = panel.getByTestId('filter-group-2');
  await expect(inner).toHaveCount(1);
  const rule = inner.getByTestId('filter-rule').first();
  await rule.getByTestId('rule-column').click();
  await page.getByRole('menuitemradio', { name: 'שם', exact: true }).click();
  await rule.getByTestId('rule-operator').click();
  await page.getByRole('menuitemradio', { name: 'מכיל', exact: true }).click();
  await rule.getByTestId('rule-text').fill('Brav');
  await expect.poll(() => names(page)).toEqual(['Bravo']);
  await inner.getByRole('button', { name: 'לא (שלילה)' }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha']);
  await expect(rail.getByTestId('filter-rail-count-advanced')).toHaveText('1');
  await panel.getByTestId('filter-combinator').click();
  await page.getByRole('menuitemradio', { name: 'או', exact: true }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  await expect(page.getByTestId('toolbar-filter-count')).toHaveText('2');

  // A chip's ✕ removes its rule; "ניקוי" removes everything.
  await expect(chips).toHaveCount(2);
  await chips.nth(1).getByRole('button').click();
  await expect(chips).toHaveCount(1);
  await expect(panel.getByTestId('filter-group-2')).toHaveCount(0);
  await panel.getByTestId('filter-clear').click();
  await expect(chips).toHaveCount(0);
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Bravo', 'Charlie']);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('toolbar-filter-count')).toHaveCount(0);
});

test('filter panel: opens on the advanced conditions when only they hold rules; phones get a bottom sheet', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['Alpha', 'Bravo']);
  await page.getByTestId('toolbar-filter').click();
  const panel = page.getByTestId('filter-panel');
  await panel.getByTestId('filter-rail-advanced').click();
  await panel.getByTestId('filter-add-rule').click();
  const rule = panel.getByTestId('filter-rule').last();
  await rule.getByTestId('rule-column').click();
  await page.getByRole('menuitemradio', { name: 'שם', exact: true }).click();
  await rule.getByTestId('rule-operator').click();
  await page.getByRole('menuitemradio', { name: 'מכיל', exact: true }).click();
  await rule.getByTestId('rule-text').fill('Alp');
  await expect.poll(() => names(page)).toEqual(['Alpha']);
  await page.keyboard.press('Escape');
  await page.getByTestId('toolbar-filter').click();
  await expect(panel).toHaveAttribute('data-section', 'advanced');
  await page.keyboard.press('Escape');

  // A phone: the rail scrolls sideways above the values, inside the bottom sheet.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId('mobile-filter-open').click();
  await page.getByTestId('mobile-filter-sheet').getByTestId('toolbar-filter').click();
  await expect(panel).toBeVisible();
  const box = (await page.getByTestId('popover').filter({ has: panel }).boundingBox())!;
  expect(box.width).toBeGreaterThan(380);
  expect(box.y + box.height).toBeGreaterThan(830);
  await panel.getByTestId('filter-rail-__group__').click();
  await expect(panel.getByTestId('quick-__group__')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('update box: closed one line while idle and empty, opens on click, stays open with a draft', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['Composer']);
  await row(page, 'Composer').hover();
  await row(page, 'Composer').getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: 'Composer' });
  const box = card.getByTestId('composer');
  await expect(box).toHaveAttribute('data-collapsed', 'true');
  await expect(box.getByTestId('composer-send')).toHaveCount(0);
  const closed = (await box.boundingBox())!;
  expect(closed.height).toBeLessThan(56);

  // A click anywhere on it opens the full composer.
  await box.click({ position: { x: 20, y: 20 } });
  await expect(box).not.toHaveAttribute('data-collapsed', 'true');
  await expect(box.getByTestId('composer-send')).toBeVisible();
  await expect(card.getByLabel(/כתבו עדכון/)).toBeFocused();

  // Leaving it empty closes it again.
  await card.getByRole('heading', { level: 2 }).first().click();
  await expect(box).toHaveAttribute('data-collapsed', 'true');

  // With text it stays open, and a reopened card keeps the draft open.
  await card.getByLabel(/כתבו עדכון/).click();
  await page.keyboard.type('טיוטה פתוחה');
  await card.getByRole('heading', { level: 2 }).first().click();
  await expect(box).not.toHaveAttribute('data-collapsed', 'true');
  await card.getByRole('button', { name: 'סגירה' }).last().click();
  await expect(card).toBeHidden();
  await row(page, 'Composer').hover();
  await row(page, 'Composer').getByRole('link', { name: 'פתיחה' }).click();
  await expect(box).not.toHaveAttribute('data-collapsed', 'true');
  await expect(box.getByTestId('composer-draft')).toBeVisible();

  // Posting empties it; once focus leaves, it is one line again.
  await card.getByRole('button', { name: 'עדכון', exact: true }).click();
  await expect(card.getByTestId('update-entry').first()).toContainText('טיוטה פתוחה');
  await card.getByRole('heading', { level: 2 }).first().click();
  await expect(box).toHaveAttribute('data-collapsed', 'true');
});
