// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Prod fixes, round 15 (board): the toolbar's tools (no collapse-all / person; coloring in the gear; hidden right
 * before the gear), a wide filter panel, "select all" boxes in the group / subitems header rows, and colour
 * pickers that stay open after a pick.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, items: string[]) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`r15 ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of items) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }
};

const addSubitem = async (page: Page, parent: string, name: string) => {
  const toggle = row(page, parent).getByTestId('subitems-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') {
    await row(page, parent).hover();
    await toggle.click();
  }
  const field = page.getByLabel('+ הוספת תת-פריט');
  await field.fill(name);
  await field.press('Enter');
  await expect(row(page, name)).toBeVisible();
};

test('toolbar: no collapse-all or person, hidden right before the gear, coloring inside the gear', async ({ page }) => {
  await newBoard(page, ['Alpha']);
  const toolbar = page.getByTestId('board-toolbar');
  await expect(toolbar.getByTestId('toolbar-collapse-all')).toHaveCount(0);
  await expect(toolbar.getByTestId('toolbar-person')).toHaveCount(0);
  await expect(toolbar.getByTestId('toolbar-coloring')).toHaveCount(0);

  // "Hidden" is the tool right before the gear.
  const order = await toolbar
    .locator('[data-testid^="toolbar-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  const tools = order.filter((id) => !id!.startsWith('toolbar-search') && !id!.endsWith('-count'));
  expect(tools.indexOf('toolbar-view-settings')).toBe(tools.indexOf('toolbar-hide') + 1);

  // Coloring: a page of the gear, with a way back.
  await page.getByTestId('toolbar-view-settings').click();
  await expect(page.getByTestId('view-settings')).toBeVisible();
  await page.getByTestId('toolbar-coloring').click();
  await expect(page.getByTestId('coloring-panel')).toBeVisible();
  await page.getByTestId('coloring-add').click();
  await expect(page.getByTestId('coloring-rule')).toHaveCount(1);
  // Picking a colour keeps the panel open.
  await page.getByTestId('coloring-color').nth(3).click();
  await expect(page.getByTestId('coloring-panel')).toBeVisible();
  await page.getByTestId('view-settings-back').click();
  await expect(page.getByTestId('view-settings')).toBeVisible();
  await page.keyboard.press('Escape');
  // The gear counts the coloring rules.
  await expect(page.getByTestId('toolbar-view-settings')).toContainText('1');

  // Collapse all is still in the group menu (and Ctrl+G); then "expand all" brings everything back.
  const section = page.getByTestId('board-section').first();
  await section.hover();
  await section.getByRole('button', { name: /פעולות לקבוצה/ }).click();
  await page.getByRole('menuitem', { name: 'כיווץ כל הקבוצות' }).click();
  await expect(row(page, 'Alpha')).toHaveCount(0);
  const folded = page.getByTestId('board-section').first();
  await folded.hover();
  await folded.getByRole('button', { name: /פעולות לקבוצה/ }).click();
  await page.getByRole('menuitem', { name: 'פתיחת הכל' }).click();
  await expect(row(page, 'Alpha')).toBeVisible();
});

test('the filter panel is wide (up to 880px) and stays on screen', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await newBoard(page, ['Alpha']);
  await page.getByTestId('toolbar-filter').click();
  const panel = page.getByTestId('popover').filter({ has: page.getByTestId('filter-panel') });
  await expect(panel).toBeVisible();
  const box = (await panel.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(860);
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1400);

  // A narrower window: 95% of it, still inside.
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 800, height: 900 });
  await page.getByTestId('toolbar-filter').click();
  const narrow = (await panel.boundingBox())!;
  expect(narrow.width).toBeGreaterThan(700);
  expect(narrow.x).toBeGreaterThanOrEqual(0);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(800);
});

test('select-all boxes in the group header and the subitems header (indeterminate when partly picked)', async ({
  page,
}) => {
  await newBoard(page, ['A', 'B', 'C']);
  const head = page.getByTestId('group-header').first().getByTestId('section-select');
  await expect(head).toBeVisible();
  await expect(head).toHaveAttribute('data-state', 'none');

  await head.click();
  await expect(page.getByTestId('batch-count')).toHaveText('3');
  await expect(head).toHaveAttribute('data-state', 'all');
  await row(page, 'B').getByTestId('row-select').click();
  await expect(head).toHaveAttribute('data-state', 'some');
  expect(await head.evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
  await head.click(); // partly picked → all
  await expect(page.getByTestId('batch-count')).toHaveText('3');
  await head.click(); // all → none
  await expect(page.getByTestId('batch-bar')).toHaveCount(0);

  // The subitems' header row selects that parent's subitems (their own batch bar).
  await addSubitem(page, 'A', 'S1');
  await addSubitem(page, 'A', 'S2');
  const subHead = page.getByTestId('subhead').getByTestId('subitems-select');
  await expect(subHead).toBeVisible();
  await subHead.click();
  await expect(subHead).toHaveAttribute('data-state', 'all');
  await expect(row(page, 'S1').getByTestId('row-select')).toBeChecked();
  await expect(row(page, 'S2').getByTestId('row-select')).toBeChecked();
  await expect(page.getByTestId('batch-count')).toHaveText('2');
  await row(page, 'S2').getByTestId('row-select').click();
  await expect(subHead).toHaveAttribute('data-state', 'some');
  await subHead.click();
  await subHead.click();
  await expect(row(page, 'S1').getByTestId('row-select')).not.toBeChecked();
});

test('colour pickers stay open after a pick: group colour, status label colour', async ({ page }) => {
  await newBoard(page, ['Alpha']);
  // The group colour palette.
  const section = page.getByTestId('board-section').first();
  await section.hover();
  await section.getByRole('button', { name: /פעולות לקבוצה/ }).click();
  await page.getByRole('menuitem', { name: 'צבע', exact: true }).click();
  const colors = page.getByTestId('group-colors');
  await expect(colors).toBeVisible();
  await colors.getByTestId('group-color').nth(2).click();
  await expect(colors).toBeVisible();
  await expect(colors.getByTestId('group-color').nth(2)).toHaveAttribute('aria-pressed', 'true');
  await colors.getByTestId('group-color').nth(4).click();
  await expect(colors).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(colors).toHaveCount(0);

  // A status label's colour in the label editor.
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'סטטוס', exact: true }).click();
  await row(page, 'Alpha').locator('[data-column-type="status"]').click();
  await page.getByRole('button', { name: 'עריכת תוויות' }).click();
  const first = page.getByTestId('label-editor').getByTestId('label-row').first();
  await first.getByTestId('label-color').click();
  const palette = first.getByTestId('label-palette');
  await expect(palette).toBeVisible();
  await palette.getByTestId('label-swatch').nth(5).click();
  await expect(palette).toBeVisible();
  await palette.getByTestId('label-swatch').nth(6).click();
  await expect(palette).toBeVisible();
  // A click elsewhere in the editor folds it.
  await page
    .getByTestId('label-editor')
    .getByRole('button', { name: /תווית חדשה/ })
    .click();
  await expect(palette).toHaveCount(0);
});
