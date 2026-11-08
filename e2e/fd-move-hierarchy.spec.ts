// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn } from './helpers';

/**
 * the batch bar's "move to item": checked items go under another item (the app's own picker, no
 * native dialog), checked subitems go one level up; one undo each.
 * a subitem becomes an item from a right click: on its name (row menu) or on any of its cells.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const nameCell = (page: Page, name: string) => row(page, name).first().locator('[data-cell="-1"]');

type ApiItem = { id: string; name: string; parent_item_id: string | null; depth: number; position: string };

const newBoard = async (page: Page, items: string[]) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `היררכיה ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const item of items) {
    await add.fill(item);
    await add.press('Enter');
    await expect(row(page, item)).toBeVisible();
  }
  return /\/b\/([^/?]+)/.exec(page.url())![1]!;
};

/** Opens `name`'s subitems table (leaves it open when it already is). */
const openSubitems = async (page: Page, name: string) => {
  await row(page, name).first().hover();
  const toggle = row(page, name).first().getByTestId('subitems-toggle');
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
};

/**
 * Each of `names` shows exactly once — as an item of the board (`top`) or as a subitem — before the next click:
 * the board's and the sub-board's rows refetch separately after a move or an undo.
 */
const shownOnce = async (page: Page, names: string[], boardId: string, top: boolean) => {
  for (const name of names) {
    await expect(row(page, name)).toHaveCount(1);
    if (top) await expect(row(page, name)).toHaveAttribute('data-bulk-board', boardId);
    else await expect(row(page, name)).not.toHaveAttribute('data-bulk-board', boardId);
  }
};

/** Right click on `target` until the menu shows "move to item ▸", then opens that submenu. */
const rightClickTree = async (page: Page, target: Locator) => {
  await expect(async () => {
    await target.click({ button: 'right' });
    await expect(page.getByTestId('menu-tree')).toBeVisible({ timeout: 1000 });
  }).toPass();
  await page.getByTestId('menu-tree').click();
};

const byPosition = (a: ApiItem, b: ApiItem) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);

const tree = async (page: Page, boardId: string) => {
  const { headers } = await ownerContext(page);
  const get = async <T>(path: string) => (await (await page.request.get(`/api/v1${path}`, { headers })).json()) as T;
  const subId = async () => (await get<{ subitems_board_id: string | null }>(`/boards/${boardId}`)).subitems_board_id;
  const mains = async () => (await get<{ data: ApiItem[] }>(`/boards/${boardId}/items`)).data;
  const subs = async () => {
    const id = await subId();
    return id ? (await get<{ data: ApiItem[] }>(`/boards/${id}/items`)).data : [];
  };
  const tops = async () => (await mains()).sort(byPosition).map((i) => i.name);
  const under = async (name: string) => {
    const parent = [...(await mains()), ...(await subs())].find((i) => i.name === name)!;
    return (await subs())
      .filter((i) => i.parent_item_id === parent.id)
      .sort(byPosition)
      .map((i) => i.name);
  };
  return { tops, under };
};

test('batch bar: checked items go under an item, checked subitems one level up; undo', async ({ page }) => {
  const boardId = await newBoard(page, ['P', 'Q', 'A', 'B']);
  const t = await tree(page, boardId);

  // A and B checked → "move to item" → "under an item…" → pick Q in the app's own list.
  await row(page, 'A').getByTestId('row-select').click();
  await row(page, 'B').getByTestId('row-select').click();
  await page.getByTestId('batch-tree').click();
  await page.getByTestId('menu-tree-under').click();
  const dialog = page.getByTestId('tree-dialog');
  await expect(dialog).toBeVisible();
  // The moved rows are not offered as their own parent.
  await expect(dialog.getByTestId('tree-parent').filter({ hasText: 'A' })).toHaveCount(0);
  await dialog.getByTestId('tree-parent').filter({ hasText: 'Q' }).click();
  await page.getByTestId('tree-confirm').click();
  await expect.poll(() => t.under('Q')).toEqual(['A', 'B']);
  expect(await t.tops()).toEqual(['P', 'Q']);
  // The table shows it without a reload: A and B are gone from the top level and listed under Q (the first move
  // under an item also made the board's sub-board).
  await expect(row(page, 'A')).toHaveCount(0);
  await expect(row(page, 'Q').first().getByTestId('subitems-count')).toHaveText('2');
  await openSubitems(page, 'Q');
  await shownOnce(page, ['A', 'B'], boardId, false);

  // Ctrl+Z: both are items again (one batch).
  await page.mouse.move(1, 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => t.tops()).toEqual(['P', 'Q', 'A', 'B']);
  await expect.poll(() => t.under('Q')).toEqual([]);
  await shownOnce(page, ['A', 'B'], boardId, true);

  // Again, then the two subitems checked → "one level up": items right after Q, in order.
  await row(page, 'A').getByTestId('row-select').click();
  await row(page, 'B').getByTestId('row-select').click();
  await page.getByTestId('batch-tree').click();
  await page.getByTestId('menu-tree-under').click();
  await page.getByTestId('tree-dialog').getByTestId('tree-parent').filter({ hasText: 'Q' }).click();
  await page.getByTestId('tree-confirm').click();
  await expect.poll(() => t.under('Q')).toEqual(['A', 'B']);
  await openSubitems(page, 'Q');
  await shownOnce(page, ['A', 'B'], boardId, false);
  await row(page, 'A').getByTestId('row-select').click();
  await row(page, 'B').getByTestId('row-select').click();
  await page.getByTestId('batch-tree').last().click();
  await page.getByTestId('menu-tree-up').click();
  await expect.poll(() => t.tops()).toEqual(['P', 'Q', 'A', 'B']);
  // On screen too: Q's subitems table is empty again and A, B are top-level rows.
  await expect.poll(() => t.under('Q')).toEqual([]);
  await shownOnce(page, ['A', 'B'], boardId, true);
});

test('right click: a subitem becomes an item from its name or from any of its cells', async ({ page }) => {
  const boardId = await newBoard(page, ['P', 'Q']);
  const t = await tree(page, boardId);
  await row(page, 'P').hover();
  await row(page, 'P').getByTestId('subitems-toggle').click();
  const field = page.getByLabel('+ הוספת תת-פריט').first();
  for (const n of ['S', 'T']) {
    await field.fill(n);
    await field.press('Enter');
    await expect(row(page, n)).toBeVisible();
  }

  // The name cell's row menu: "move to item ▸ one level up" → an item right after P.
  await rightClickTree(page, nameCell(page, 'S'));
  await page.getByTestId('menu-tree-up').click();
  await expect.poll(() => t.tops()).toEqual(['P', 'S', 'Q']);
  await shownOnce(page, ['S'], boardId, true);

  // A value cell's menu offers the same.
  await rightClickTree(page, row(page, 'T').first().locator('[data-cell="0"]'));
  await page.getByTestId('menu-tree-up').click();
  await expect.poll(() => t.tops()).toEqual(['P', 'T', 'S', 'Q']);
  expect(await t.under('P')).toEqual([]);
  await shownOnce(page, ['T'], boardId, true);
});

test('right click: "under an item…" for a top-level item and for a subitem (); undo', async ({ page }) => {
  const boardId = await newBoard(page, ['P', 'Q', 'A']);
  const t = await tree(page, boardId);

  // A top-level item, from its name: under P (the app's own picker) — a subitem now, on screen too.
  await rightClickTree(page, nameCell(page, 'A'));
  // An item has no level above: only "under an item…".
  await expect(page.getByTestId('menu-tree-up')).toHaveCount(0);
  await page.getByTestId('menu-tree-under').click();
  const dialog = page.getByTestId('tree-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('tree-parent').filter({ hasText: 'A' })).toHaveCount(0);
  await dialog.getByTestId('tree-parent').filter({ hasText: 'P' }).click();
  await page.getByTestId('tree-confirm').click();
  await expect.poll(() => t.under('P')).toEqual(['A']);
  expect(await t.tops()).toEqual(['P', 'Q']);
  await expect(row(page, 'P').first().getByTestId('subitems-count')).toHaveText('1');
  await openSubitems(page, 'P');
  await shownOnce(page, ['A'], boardId, false);

  // The subitem, from one of its cells: under Q.
  await rightClickTree(page, row(page, 'A').first().locator('[data-cell="0"]'));
  await expect(page.getByTestId('menu-tree-up')).toBeVisible();
  await page.getByTestId('menu-tree-under').click();
  await page.getByTestId('tree-dialog').getByTestId('tree-parent').filter({ hasText: 'Q' }).click();
  await page.getByTestId('tree-confirm').click();
  await expect.poll(() => t.under('Q')).toEqual(['A']);
  expect(await t.under('P')).toEqual([]);
  await openSubitems(page, 'Q');
  await shownOnce(page, ['A'], boardId, false);

  // Ctrl+Z: back under P (one batch).
  await page.mouse.move(1, 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => t.under('P')).toEqual(['A']);
  expect(await t.under('Q')).toEqual([]);
  await openSubitems(page, 'P');
  await shownOnce(page, ['A'], boardId, false);
});
