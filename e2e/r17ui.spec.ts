// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Round 17 (r17ui):
 *: a column picker opened inside the automation dialog is fully on screen and its rows are readable
 *   (they used to shrink to blank slivers under the list's max height) — at 1072×817 and on a phone.
 *: a colour pick keeps its picker open (avatar menu → appearance, colour cell, group colour, label colour
 *   coloring); outside click / Esc close it.
 *: subitem triggers and parent / subitem actions are visible in the pickers, and column blanks list the
 *   item's, the subitems' and the parent's columns in sections (picking one switches the trigger / action).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

/** A board with many columns (a long picker), a colour column, an item with a subitem (so a sub-board) and its column. */
const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `r17ui ${tag}`, workspace_id: ws.id });
  for (let i = 1; i <= 22; i++)
    await api('post', `/boards/${board.id}/columns`, { id: `t${i}`, title: `עמודה ${i}`, type: 'text' });
  await api('post', `/boards/${board.id}/columns`, { id: 'paint', title: 'צבע', type: 'color_picker' });
  const parent = await api<{ id: string }>('post', `/boards/${board.id}/items`, { name: `Parent ${tag}` });
  const sub = await api<{ id: string; board_id: string }>('post', `/items/${parent.id}/subitems`, {
    name: `Sub ${tag}`,
  });
  await api('post', `/boards/${sub.board_id}/columns`, { id: 'subnote', title: `פירוט ${tag}`, type: 'text' });
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, `Parent ${tag}`)).toBeVisible();
  return { board, tag };
};

const openBuilder = async (page: Page, phone = false) => {
  // A phone has no automations button in the bar: the center opens from the board's ⋯ menu.
  if (phone) {
    await page.getByTestId('board-more').first().click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'אוטומציות' }).click();
  } else await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  await page.getByTestId('auto-custom').click();
  const builder = page.getByTestId('automation-builder');
  await expect(builder).toBeVisible();
  return builder;
};

/** The element is inside the viewport (a 1px tolerance). */
const onScreen = async (page: Page, el: Locator) => {
  const box = (await el.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(-1);
  expect(box.y).toBeGreaterThanOrEqual(-1);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
};

/** Every visible row of the column list is a full-height, readable chip. */
const rowsReadable = async (list: Locator) => {
  const chips = list.getByTestId('slot-option');
  expect(await chips.count()).toBeGreaterThan(10);
  for (let i = 0; i < 5; i++) {
    const chip = chips.nth(i);
    const box = (await chip.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(24);
    // The text fits the chip's height (not cut to a sliver).
    expect(await chip.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  }
};

const columnPicker = async (page: Page, phone = false) => {
  // The phone: the page is laid out for a phone first (crossing the breakpoint re-mounts the page, and an open
  // dialog with it), then the center opens there as a sheet.
  if (phone) await page.setViewportSize({ width: 390, height: 844 });
  const builder = await openBuilder(page, phone);
  await builder.getByTestId('auto-add-action').click();
  await page.getByTestId('auto-action-clear_column').click();
  await builder.locator('[data-slot="actions.0.column"]').click();
  const pop = page.getByTestId('popover');
  await expect(pop.getByTestId('slot-columns')).toBeVisible();
  return pop;
};

test.beforeEach(async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
});

test('a column picker in the automation dialog: on screen, readable rows (desktop 1072×817)', async ({ page }) => {
  await page.setViewportSize({ width: 1072, height: 817 });
  await setup(page);
  const pop = await columnPicker(page);
  await onScreen(page, pop);
  await rowsReadable(pop.getByTestId('slot-columns'));
  // The list scrolls inside the panel: the last column is reachable.
  await pop.getByTestId('slot-option').filter({ hasText: 'עמודה 22' }).scrollIntoViewIfNeeded();
  await expect(pop.getByTestId('slot-option').filter({ hasText: 'עמודה 22' })).toBeInViewport();
  await pop.getByTestId('slot-option').filter({ hasText: 'עמודה 22' }).click();
  await expect(page.getByTestId('automation-builder').locator('[data-slot="actions.0.column"]')).toHaveText(/עמודה 22/);
});

test('a column picker in the automation dialog: on screen, readable rows (phone)', async ({ page }) => {
  await page.setViewportSize({ width: 1072, height: 817 });
  await setup(page);
  const pop = await columnPicker(page, true);
  await onScreen(page, pop);
  await rowsReadable(pop.getByTestId('slot-columns'));
});

test('subitems in automations: triggers, actions and sectioned column pickers', async ({ page }) => {
  await page.setViewportSize({ width: 1072, height: 817 });
  const { tag } = await setup(page);
  const builder = await openBuilder(page);

  // The trigger menu: the subitem triggers are there, in their own section.
  await builder.getByTestId('auto-trigger-type').click();
  for (const k of ['subitem_created', 'subitem_status_changed', 'subitem_column_changed'])
    await expect(page.getByTestId(`auto-trigger-${k}`)).toBeVisible();
  await page.getByTestId('auto-trigger-column_changed').click();

  // "When a column changes": item columns and subitem columns, under headers; a subitem column switches the
  // trigger to "when a subitem's column changes".
  await builder.locator('[data-slot="trigger.column"]').click();
  const pop = page.getByTestId('popover');
  await expect(pop.locator('[data-testid="slot-col-section"][data-scope="item"]')).toBeVisible();
  await expect(pop.locator('[data-testid="slot-col-section"][data-scope="subitems"]')).toBeVisible();
  await pop
    .getByTestId('slot-option')
    .filter({ hasText: `פירוט ${tag}` })
    .click();
  await expect(builder.getByTestId('auto-trigger-type')).toHaveText(/תת-פריט|subitem_column_changed/);
  await expect(builder.locator('[data-slot="trigger.column"]')).toHaveText(new RegExp(`פירוט ${tag}`));

  // The action menu: set / copy on the parent and the subitems.
  await builder.getByTestId('auto-add-action').click();
  for (const k of [
    'set_parent_column',
    'set_subitems_column',
    'copy_from_parent',
    'copy_to_parent',
    'copy_to_subitems',
    'create_subitem',
  ])
    await expect(page.getByTestId(`auto-action-${k}`)).toBeAttached();
  await page.getByTestId('auto-action-set_column').click();

  // On a subitem run "set column" offers the subitem's own columns and its parent's; a parent column makes it
  // "set the parent's column".
  await builder.locator('[data-slot="actions.0.column"]').click();
  await expect(pop.locator('[data-testid="slot-col-section"][data-scope="item"]')).toBeVisible();
  await expect(pop.locator('[data-testid="slot-col-section"][data-scope="parent"]')).toBeVisible();
  await pop.getByTestId('slot-option').filter({ hasText: 'עמודה 3' }).first().click();
  await expect(builder.locator('[data-testid="auto-action"]').first()).toHaveAttribute(
    'data-type',
    'set_parent_column',
  );
});

test('colour picks keep their picker open', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  const { tag } = await setup(page);

  // The avatar menu → appearance: a colour theme is tried without closing the menu.
  await page.getByTestId('profile-menu').first().click();
  await page.getByTestId('menu-appearance').click();
  await page.getByTestId('menu-palette-ocean').click();
  await expect(page.getByTestId('profile-menu-panel')).toBeVisible();
  await expect(page.getByTestId('menu-palette-ocean')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('menu-palette-f4').click();
  await expect(page.getByTestId('menu-palette-f4')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('profile-menu-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('profile-menu-panel')).toHaveCount(0);

  // A colour cell: a swatch keeps the palette open; Esc closes it.
  await row(page, `Parent ${tag}`).locator('[data-column="paint"]').click();
  const palette = page.getByTestId('color-palette');
  await expect(palette).toBeVisible();
  await palette.getByTestId('color-swatch').nth(2).click();
  await expect(palette).toBeVisible();
  await palette.getByTestId('color-swatch').nth(5).click();
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toHaveCount(0);

  // The group colour.
  const section = page.getByTestId('board-section').first();
  await section.hover();
  await section.getByRole('button', { name: /פעולות לקבוצה/ }).click();
  await page.getByRole('menuitem', { name: 'צבע', exact: true }).click();
  const colors = page.getByTestId('group-colors');
  await colors.getByTestId('group-color').nth(3).click();
  await expect(colors).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(colors).toHaveCount(0);

  // Coloring (the gear's page): a colour keeps the panel open.
  await page.getByTestId('toolbar-view-settings').click();
  await page.getByTestId('toolbar-coloring').click();
  await page.getByTestId('coloring-add').click();
  await page.getByTestId('coloring-color').nth(2).click();
  await expect(page.getByTestId('coloring-panel')).toBeVisible();
  await page.getByTestId('coloring-color').nth(6).click();
  await expect(page.getByTestId('coloring-panel')).toBeVisible();
  await page.keyboard.press('Escape');
});
