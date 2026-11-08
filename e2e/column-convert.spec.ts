// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * D28 "שינוי סוג עמודה" (the planning notes "COLUMN-CONVERSION"): from the column's menu, choose the new type, read the
 * preview (counts, examples, new labels), convert. text → numbers keeps a failure in the backup (marked in the
 * cell, "show only failed"), the toast's "undo" takes it all back; text → status creates the labels the values
 * need, and Ctrl+Z undoes the whole conversion.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const setup = async (page: Page, title: string, values: string[]) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'put' | 'delete', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `המרת עמודה ${tag}`, workspace_id: ws.id });
  const detail = await api<{ columns: { id: string; type: string }[] }>('get', `/boards/${board.id}`);
  for (const c of detail.columns.filter((x) => x.type !== 'name'))
    await api('delete', `/boards/${board.id}/columns/${c.id}`);
  const column = await api<{ id: string }>('post', `/boards/${board.id}/columns`, { title, type: 'text' });
  const names: string[] = [];
  for (const [i, v] of values.entries()) {
    const name = `פריט ${i + 1} ${tag}`;
    names.push(name);
    const it = await api<{ id: string }>('post', `/boards/${board.id}/items`, { name });
    await api('put', `/items/${it.id}/cells/${column.id}`, { value: v });
  }
  return { board, key: column.id, names };
};

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const cellOf = (page: Page, name: string, key: string) => row(page, name).locator(`[data-column="${key}"]`);

/** Right-click on the column's header → "שינוי סוג עמודה" → the dialog. */
const openConvert = async (page: Page, key: string) => {
  await page.locator(`[data-header="${key}"]`).click({ button: 'right' });
  await page.getByRole('menu').getByTestId('column-convert').click();
  await expect(page.getByTestId('convert-dialog')).toBeVisible();
};

test('text → numbers: preview, convert, a failure kept in the backup and marked; undo from the toast', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { board, key, names } = await setup(page, 'סכום', ['1,250 ₪', 'בערך 5', '₪ 300']);
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, names[2]!)).toBeVisible();

  await openConvert(page, key);
  await page.locator('[data-testid="convert-target"][data-type="numbers"]').click();
  const counts = page.getByTestId('convert-counts');
  await expect(counts).toHaveAttribute('data-converted', '2');
  await expect(counts).toHaveAttribute('data-failed', '1');
  await expect(page.getByTestId('convert-failed-sample')).toContainText('בערך 5');
  await expect(page.getByTestId('convert-sample').first()).toContainText('1,250 ₪');
  await page.getByTestId('convert-apply').click();
  await expect(page.getByTestId('convert-dialog')).toBeHidden();

  // The column is numbers now; the failed cell is empty, marked with its original value.
  await expect(cellOf(page, names[0]!, key)).toHaveAttribute('data-column-type', 'numbers');
  await expect(cellOf(page, names[0]!, key)).toContainText('1,250'); // a new numbers column shows 1,000
  const mark = cellOf(page, names[1]!, key).getByTestId('convert-failed-mark');
  await expect(mark).toBeVisible();
  await mark.hover();
  const tip = (await mark.getAttribute('title')) ?? (await mark.getAttribute('data-tip')) ?? '';
  expect(tip).toContain('בערך 5');

  // "Show only failed": just that item; then all again.
  await expect(page.getByTestId('convert-banner-row')).toHaveAttribute('data-count', '1');
  await page.getByTestId('convert-show-failed').click();
  await expect(row(page, names[1]!)).toBeVisible();
  await expect(row(page, names[0]!)).toBeHidden();
  await page.getByTestId('convert-show-failed').click();
  await expect(row(page, names[0]!)).toBeVisible();

  // Undo from the toast: text again, every value back.
  await page.getByTestId('toast-action').first().click();
  await expect(cellOf(page, names[0]!, key)).toHaveAttribute('data-column-type', 'text');
  await expect(cellOf(page, names[0]!, key)).toContainText('1,250 ₪');
  await expect(cellOf(page, names[1]!, key)).toContainText('בערך 5');
  await expect(page.getByTestId('convert-banner')).toBeHidden();
});

test('text → status creates the labels the values need; Ctrl+Z undoes the whole conversion', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { board, key, names } = await setup(page, 'שלב', ['בטיפול', 'Done', 'done']);
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, names[2]!)).toBeVisible();

  await openConvert(page, key);
  // The keyboard reaches the type list too: focus the status option and press Enter.
  await page.locator('[data-testid="convert-target"][data-type="status"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('convert-counts')).toHaveAttribute('data-converted', '3');
  await expect(page.locator('[data-testid="convert-label"][data-name="בטיפול"]')).toBeVisible();
  await expect(page.locator('[data-testid="convert-label"][data-name="Done"]')).toBeVisible();
  await expect(page.locator('[data-testid="convert-label"]')).toHaveCount(2);
  await page.getByTestId('convert-apply').click();
  await expect(page.getByTestId('convert-dialog')).toBeHidden();

  await expect(cellOf(page, names[1]!, key)).toHaveAttribute('data-column-type', 'status');
  await expect(cellOf(page, names[2]!, key)).toContainText('Done');
  await expect(cellOf(page, names[0]!, key)).toContainText('בטיפול');

  // The history lists it.
  await page.locator(`[data-header="${key}"]`).click({ button: 'right' });
  await page.getByRole('menu').getByTestId('column-conversions').click();
  await expect(page.getByTestId('convert-history-row').first()).toHaveAttribute('data-status', 'done');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('convert-history')).toBeHidden();

  // Ctrl+Z (within a minute, nothing typed) takes the conversion back: text, the original spellings.
  await page.mouse.click(5, 5);
  await page.keyboard.press('Control+Z');
  await expect(cellOf(page, names[2]!, key)).toHaveAttribute('data-column-type', 'text');
  await expect(cellOf(page, names[2]!, key)).toContainText('done');
});
