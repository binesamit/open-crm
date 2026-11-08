// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * "ייבוא ועריכה" (until "עריכה גדולה") (12-ROADMAP B1 + B2): open from the board's ⋯, paste a 3×3 block from the clipboard (one existing
 * row + two new rows, one new status label), type into a cell, finish → the review shows the new label → approve →
 * the values are there after a reload; a second bulk edit is taken back whole by Ctrl+Z (new row, new label, cells).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'delete', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `עריכה גדולה ${tag}`, workspace_id: ws.id });
  // Only the columns this test types into: name, status, text, numbers.
  const detail = await api<{ columns: { id: string; type: string }[] }>('get', `/boards/${board.id}`);
  for (const c of detail.columns.filter((x) => x.type !== 'name'))
    await api('delete', `/boards/${board.id}/columns/${c.id}`);
  await api('post', `/boards/${board.id}/columns`, { title: 'מצב', type: 'status' });
  await api('post', `/boards/${board.id}/columns`, { title: 'הערה', type: 'text' });
  await api('post', `/boards/${board.id}/columns`, { title: 'כמות', type: 'numbers' });
  await api('post', `/boards/${board.id}/items`, { name: `Alpha ${tag}` });
  await api('post', `/boards/${board.id}/items`, { name: `Beta ${tag}` });
  return { board, tag };
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

test('bulk edit: paste a block with new rows and a new label, review, write, reload; Ctrl+Z undoes all', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  forbidNativeDialogs(page);
  await signIn(page);
  const { board, tag } = await setup(page);
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, `Beta ${tag}`)).toBeVisible();

  const grid = await openSheet(page);
  // name, מצב, הערה, כמות, group (new rows).
  await expect(page.locator('[data-bulk-header]')).toHaveCount(5);
  await expect(grid).toHaveAttribute('data-rows', '2');
  await expect(cell(page, 0, 0)).toHaveText(`Alpha ${tag}`);

  // Edit Alpha's text cell (Enter opens the editor, Enter commits and goes down). Playwright types Hebrew as
  // text input without key presses, so the editor is opened first.
  await cell(page, 0, 2).click();
  await page.keyboard.press('Enter');
  await page.keyboard.type('הוקלד');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 2)).toHaveText('הוקלד');
  await expect(cell(page, 0, 2)).toHaveAttribute('data-edited', 'true');

  // A 3×3 block from "Excel" at Beta's name: Beta renamed, two new rows, a new status label.
  const label = `חדש-${tag}`.slice(0, 20);
  const tsv = [`Beta2 ${tag}\t${label}\tב`, `Gamma ${tag}\tבתהליך\tג`, `Delta ${tag}\t${label}\tד`].join('\n');
  await page.evaluate((text) => navigator.clipboard.writeText(text), tsv);
  await cell(page, 1, 0).click();
  await page.keyboard.press('Control+V');
  await expect(grid).toHaveAttribute('data-rows', '4');
  await expect(cell(page, 1, 0)).toHaveText(`Beta2 ${tag}`);
  await expect(cell(page, 3, 0)).toHaveText(`Delta ${tag}`);
  await expect(cell(page, 3, 1)).toHaveText(label);
  // An unknown label is marked as a new value; a bad number is marked invalid.
  await expect(cell(page, 3, 1)).toHaveAttribute('data-parse', 'labels');
  await cell(page, 2, 3).click();
  await page.keyboard.type('abc');
  await page.keyboard.press('Enter');
  await expect(cell(page, 2, 3)).toHaveAttribute('data-parse', 'invalid');
  // The sheet's own Ctrl+Z steps back (the bad number goes away).
  await page.keyboard.press('Control+Z');
  await expect(cell(page, 2, 3)).toHaveText('');

  await page.getByTestId('bulk-finish').click();
  const review = page.getByTestId('bulk-review');
  await expect(review).toBeVisible();
  await expect(page.getByTestId('bulk-review-counts')).toHaveAttribute('data-created', '2');
  await expect(page.getByTestId('bulk-review-counts')).toHaveAttribute('data-updated', '2');
  const newLabel = page.locator(`[data-testid="bulk-new-label"][data-label="${label}"]`);
  await expect(newLabel).toBeVisible();
  await expect(newLabel).toHaveAttribute('data-add', 'true');
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByTestId('bulk-sheet')).toHaveCount(0);

  await page.reload();
  await expect(row(page, `Delta ${tag}`)).toBeVisible();
  await expect(row(page, `Gamma ${tag}`)).toBeVisible();
  await expect(row(page, `Beta2 ${tag}`)).toBeVisible();
  await expect(row(page, `Delta ${tag}`).locator('[data-column-type="status"]')).toContainText(label);
  await expect(row(page, `Beta2 ${tag}`).locator('[data-column-type="status"]')).toContainText(label);
  await expect(row(page, `Gamma ${tag}`).locator('[data-column-type="text"]')).toContainText('ג');
  await expect(row(page, `Alpha ${tag}`).locator('[data-column-type="text"]')).toContainText('הוקלד');

  // A second bulk edit — one more new row with another new label, and a changed cell — then Ctrl+Z.
  const grid2 = await openSheet(page);
  await expect(grid2).toHaveAttribute('data-rows', '4');
  const label2 = `שני-${tag}`.slice(0, 20);
  await page.evaluate((text) => navigator.clipboard.writeText(text), `Epsilon ${tag}\t${label2}\tה`);
  await cell(page, 4, 0).click();
  await page.keyboard.press('Control+V');
  await cell(page, 0, 2).click();
  await page.keyboard.press('F2');
  await page.keyboard.press('Control+A');
  await page.keyboard.type('שונה');
  await page.keyboard.press('Enter');
  await page.getByTestId('bulk-finish').click();
  await expect(page.locator(`[data-testid="bulk-new-label"][data-label="${label2}"]`)).toBeVisible();
  await page.getByTestId('bulk-approve').click();
  await expect(page.getByTestId('bulk-sheet')).toHaveCount(0);
  await expect(row(page, `Epsilon ${tag}`)).toBeVisible();
  await expect(row(page, `Alpha ${tag}`).locator('[data-column-type="text"]')).toContainText('שונה');

  await page.keyboard.press('Control+Z');
  await expect(row(page, `Epsilon ${tag}`)).toHaveCount(0);
  await expect(row(page, `Alpha ${tag}`).locator('[data-column-type="text"]')).toContainText('הוקלד');
  await page.reload();
  await expect(row(page, `Delta ${tag}`)).toBeVisible();
  await expect(row(page, `Epsilon ${tag}`)).toHaveCount(0);
  await expect(row(page, `Alpha ${tag}`).locator('[data-column-type="text"]')).toContainText('הוקלד');
  // The second label is off the column again (its only cell went to the trash with the new row).
  const { headers } = await ownerContext(page);
  const cols = (await (await page.request.get(`/api/v1/boards/${board.id}`, { headers })).json()) as {
    columns: { type: string; settings: { labels?: { label: string; is_deactivated?: boolean }[] } }[];
  };
  const status = cols.columns.find((c) => c.type === 'status')!;
  expect(status.settings.labels!.some((l) => l.label === label2 && !l.is_deactivated)).toBe(false);
  expect(status.settings.labels!.some((l) => l.label === label && !l.is_deactivated)).toBe(true);
});
