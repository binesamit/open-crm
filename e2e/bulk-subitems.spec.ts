// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * "ייבוא ועריכה" (until "עריכה גדולה") B4 — the subitems sheet: a new item typed in the items tab, then in the "תתי-פריטים" tab a pasted
 * block of new subitems whose parents are given by name (the new item, an existing item, a new subitem of the same
 * paste) and an existing sub-subitem moved to another item by typing its parent. An unknown parent is flagged in
 * the review ("fix" leads back to the cell, the row is cleared); approve → reload → the tree is right (sheet and
 * API) → undo from the activity log takes the whole batch back.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

type Item = { id: string; name: string; parent_item_id: string | null; depth: number };

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'delete', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `סאב בעריכה גדולה ${tag}`, workspace_id: ws.id });
  const detail = await api<{ columns: { id: string; type: string }[] }>('get', `/boards/${board.id}`);
  for (const c of detail.columns.filter((x) => x.type !== 'name'))
    await api('delete', `/boards/${board.id}/columns/${c.id}`);
  const alpha = await api<{ id: string }>('post', `/boards/${board.id}/items`, { name: `Alpha ${tag}` });
  await api('post', `/boards/${board.id}/items`, { name: `Beta ${tag}` });
  const a1 = await api<{ id: string }>('post', `/items/${alpha.id}/subitems`, { name: `Sub A1 ${tag}` });
  await api('post', `/items/${a1.id}/subitems`, { name: `Deep ${tag}` });
  const subId = (await api<{ subitems_board_id: string }>('get', `/boards/${board.id}`)).subitems_board_id;
  const subItems = async () => (await api<{ data: Item[] }>('get', `/boards/${subId}/items`)).data;
  const items = async () => (await api<{ data: Item[] }>('get', `/boards/${board.id}/items`)).data;
  return { board, tag, subItems, items };
};

const openSheet = async (page: Page) => {
  await page.getByTestId('board-more').click();
  await page.getByRole('menu').getByTestId('board-bulk-edit').click();
  // "ייבוא" opens on the choice of a file; the sheet is one click away.
  await page.getByTestId('bulk-start-sheet').click();
  const grid = page.getByTestId('bulk-grid');
  await expect(grid).toBeVisible();
  return grid;
};
const cell = (page: Page, row: number, col: number) => page.locator(`[data-bulk-cell="${row}:${col}"]`);
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

test('bulk edit: subitems tab — paste with parents (a new one too), move, review, write, reload, undo', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  forbidNativeDialogs(page);
  await signIn(page);
  const { board, tag, subItems, items } = await setup(page);
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, `Beta ${tag}`)).toBeVisible();

  const grid = await openSheet(page);
  // Items tab: name + group; a new item typed under the last row.
  await expect(grid).toHaveAttribute('data-rows', '2');
  await expect(page.locator('[data-bulk-header]')).toHaveCount(2);
  await expect(page.getByTestId('bulk-tab-main')).toHaveAttribute('aria-selected', 'true');
  await cell(page, 2, 0).click();
  await page.keyboard.type(`Gamma ${tag}`);
  await page.keyboard.press('Enter');
  await expect(grid).toHaveAttribute('data-rows', '3');

  // The subitems tab: the sub-board's columns (name, person, status, date) and the parent column last.
  await page.getByTestId('bulk-tab-sub').click();
  await expect(page.getByTestId('bulk-sheet')).toHaveAttribute('data-tab', 'sub');
  const sub = page.getByTestId('bulk-grid');
  await expect(sub).toHaveAttribute('data-rows', '2');
  await expect(page.locator('[data-bulk-header]')).toHaveCount(5);
  await expect(page.locator('[data-bulk-header="__parent"]')).toBeVisible();
  await expect(cell(page, 0, 0)).toHaveText(`Sub A1 ${tag}`);
  await expect(cell(page, 0, 4)).toHaveText(`Alpha ${tag}`);
  await expect(cell(page, 1, 4)).toHaveText(`Sub A1 ${tag}`);
  // A sub-subitem shows its level.
  await expect(page.locator('[data-bulk-row="1"]')).toHaveAttribute('data-level', '2');
  await expect(page.locator('[data-bulk-row="1"]').getByTestId('bulk-level')).toBeVisible();

  // Move "Deep" under Beta by typing its parent.
  await cell(page, 1, 4).click();
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+A');
  await page.keyboard.type(`Beta ${tag}`);
  await page.keyboard.press('Enter');
  await expect(cell(page, 1, 4)).toHaveAttribute('data-parse', 'value');

  // A block from "Excel": under the new item, under an existing item, under a new subitem, under nobody.
  const tsv = [
    `New S1 ${tag}\t\t\t\tgamma ${tag}`,
    `New S2 ${tag}\t\t\t\tBeta ${tag}`,
    `New S3 ${tag}\t\t\t\tNew S1 ${tag}`,
    `Lost ${tag}\t\t\t\tNobody ${tag}`,
  ].join('\n');
  await page.evaluate((text) => navigator.clipboard.writeText(text), tsv);
  await cell(page, 2, 0).click();
  await page.keyboard.press('Control+V');
  await expect(sub).toHaveAttribute('data-rows', '6');
  await expect(cell(page, 2, 4)).toHaveAttribute('data-parse', 'value');
  await expect(cell(page, 5, 4)).toHaveAttribute('data-parse', 'invalid');
  // The new subitem under a new subitem is one level deeper.
  await expect(page.locator('[data-bulk-row="4"]')).toHaveAttribute('data-level', '2');

  // Finish: the unknown parent is listed with its reason; "fix" goes back to that cell in the subitems tab.
  await page.getByTestId('bulk-finish').click();
  const bad = page.locator('[data-testid="bulk-invalid"][data-sheet="sub"]');
  await expect(bad).toHaveCount(1);
  await expect(bad).toHaveAttribute('data-reason', 'parent_missing');
  await bad.click();
  await expect(page.getByTestId('bulk-sheet')).toHaveAttribute('data-tab', 'sub');
  // Clear the whole bad row (name … parent) with the mouse and Delete: the empty new row goes away.
  await cell(page, 5, 0).click();
  await cell(page, 5, 4).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('bulk-grid')).toHaveAttribute('data-rows', '5');

  await page.getByTestId('bulk-finish').click();
  await expect(page.locator('[data-testid="bulk-invalid"]')).toHaveCount(0);
  const counts = page.getByTestId('bulk-review-counts');
  await expect(counts).toHaveAttribute('data-created', '4'); // Gamma + 3 subitems
  await expect(counts).toHaveAttribute('data-updated', '1'); // Deep moved
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByTestId('bulk-sheet')).toHaveCount(0);

  // After a reload: the tree, in the sheet and in the data.
  await page.reload();
  await expect(row(page, `Gamma ${tag}`)).toBeVisible();
  await openSheet(page);
  await page.getByTestId('bulk-tab-sub').click();
  const parentOf = async (name: string) => {
    const r = page
      .locator('[data-bulk-row]')
      .filter({ has: page.locator(`[data-column="s:name"]`, { hasText: name }) });
    return r.locator('[data-column="__parent"]').innerText();
  };
  await expect(page.getByTestId('bulk-grid')).toHaveAttribute('data-rows', '5');
  expect(await parentOf(`New S1 ${tag}`)).toBe(`Gamma ${tag}`);
  expect(await parentOf(`New S2 ${tag}`)).toBe(`Beta ${tag}`);
  expect(await parentOf(`New S3 ${tag}`)).toBe(`New S1 ${tag}`);
  expect(await parentOf(`Deep ${tag}`)).toBe(`Beta ${tag}`);
  await page.getByTestId('bulk-cancel').click();
  await expect(page.getByTestId('bulk-sheet')).toHaveCount(0);

  const all = await subItems();
  const main = await items();
  const id = (list: Item[], name: string) => list.find((i) => i.name === name)!;
  const gamma = id(main, `Gamma ${tag}`);
  const beta = id(main, `Beta ${tag}`);
  expect(id(all, `New S1 ${tag}`)).toMatchObject({ parent_item_id: gamma.id, depth: 1 });
  expect(id(all, `New S2 ${tag}`)).toMatchObject({ parent_item_id: beta.id, depth: 1 });
  expect(id(all, `New S3 ${tag}`)).toMatchObject({ parent_item_id: id(all, `New S1 ${tag}`).id, depth: 2 });
  expect(id(all, `Deep ${tag}`)).toMatchObject({ parent_item_id: beta.id, depth: 1 });

  // Undo from the board's activity log: the whole batch.
  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'יומן פעילות' }).click();
  const log = page.getByTestId('board-activity');
  const entry = log
    .getByTestId('activity-entry')
    .filter({ has: page.getByTestId('activity-undo') })
    .first();
  await expect(entry).toBeVisible();
  await entry.getByTestId('activity-undo').click();
  await expect(log.locator('[data-testid="activity-entry"][data-undone="true"]').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(row(page, `Gamma ${tag}`)).toHaveCount(0);
  await page.reload();
  await expect(row(page, `Beta ${tag}`)).toBeVisible();
  await expect(row(page, `Gamma ${tag}`)).toHaveCount(0);
  const back = await subItems();
  expect(back.map((i) => i.name).sort()).toEqual([`Deep ${tag}`, `Sub A1 ${tag}`]);
  expect(id(back, `Deep ${tag}`)).toMatchObject({ parent_item_id: id(back, `Sub A1 ${tag}`).id, depth: 2 });
});

test('bulk edit: a CSV imported into the subitems tab maps "Parent item" and hangs the rows by it', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { board, tag, subItems, items } = await setup(page);
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, `Beta ${tag}`)).toBeVisible();
  await openSheet(page);
  await page.getByTestId('bulk-tab-sub').click();
  await expect(page.getByTestId('bulk-grid')).toHaveAttribute('data-rows', '2');

  const csv = `Name,Parent item\nCsv One ${tag},Alpha ${tag}\nCsv Two ${tag},beta ${tag}\n`;
  await page.getByTestId('bulk-import-file').setInputFiles({
    name: `subs-${tag}.csv`,
    mimeType: 'text/csv',
    buffer: Buffer.from(csv, 'utf8'),
  });
  await expect(page.getByTestId('bulk-import')).toBeVisible();
  await expect(page.locator('[data-testid="bulk-import-row"][data-source="Parent item"]')).toHaveAttribute(
    'data-target',
    '__parent',
  );
  await expect(page.getByTestId('bulk-import-summary')).toHaveAttribute('data-created', '2');
  await page.getByTestId('bulk-import-apply').click();
  await expect(page.getByTestId('bulk-sheet')).toHaveAttribute('data-tab', 'sub');
  await expect(page.getByTestId('bulk-grid')).toHaveAttribute('data-rows', '4');
  await expect(cell(page, 3, 4)).toHaveAttribute('data-parse', 'value');

  await page.getByTestId('bulk-finish').click();
  await expect(page.getByTestId('bulk-review-counts')).toHaveAttribute('data-created', '2');
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByTestId('bulk-sheet')).toHaveCount(0);
  const main = await items();
  const all = await subItems();
  const idOf = (name: string) => main.find((i) => i.name === name)!.id;
  expect(all.find((i) => i.name === `Csv One ${tag}`)).toMatchObject({ parent_item_id: idOf(`Alpha ${tag}`) });
  expect(all.find((i) => i.name === `Csv Two ${tag}`)).toMatchObject({ parent_item_id: idOf(`Beta ${tag}`) });
});
