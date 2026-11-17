// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Locator, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * c9: the status label editor shows the labels in the picker's own columns — two columns when the
 * picker has two, three when it has three — each label where it will appear (RTL: the first column on the right,
 * top to bottom). A drag reorders across columns in reading order, and a new label shows at once in the column it
 * will land in.
 */
const COLORS = ['forest', 'yellow', 'crimson', 'turquoise', 'navy', 'purple', 'green', 'orange', 'rust', 'olive_deep'];
const labelsOf = (n: number, prefix: string) =>
  Array.from({ length: n }, (_, i) => ({ id: i, label: `${prefix}${i}`, color: COLORS[i % COLORS.length]!, index: i }));

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = Date.now().toString(36);
  const board = await api<{ id: string }>('post', '/boards', { name: `תוויות בעמודות ${tag}`, workspace_id: ws.id });
  // 12 labels → the picker has 2 columns (6 + 6); 20 → 3 columns (7 + 7 + 6).
  const two = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'שתיים',
    type: 'status',
    settings: { labels: labelsOf(12, 'ב') },
  });
  const three = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'שלוש',
    type: 'status',
    settings: { labels: labelsOf(20, 'ג') },
  });
  await api('post', `/boards/${board.id}/items`, { name: `פריט ${tag}` });
  return { boardId: board.id, tag, two: two.id, three: three.id };
};

const drag = async (page: Page, from: Locator, to: Locator) => {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2, a.y - 10, { steps: 5 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  // dnd-kit swallows clicks for 50ms after a drop; a person never clicks that fast, a test does.
  await page.waitForTimeout(100);
};

/** The label names column by column, as the editor shows them. */
const editorColumns = (editor: Locator) =>
  editor
    .getByTestId('label-editor-column')
    .evaluateAll((cols) =>
      cols.map((c) => [...c.querySelectorAll<HTMLInputElement>('input[aria-label="שם התווית"]')].map((i) => i.value)),
    );

test('the label editor shows the picker’s columns: 2 columns for 2, 3 for 3; drag and add across them', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { boardId, tag, two, three } = await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/a/demo/b/${boardId}`);
  const cellOf = (col: string) => row(page, `פריט ${tag}`).locator(`[data-column="${col}"] [data-cell-edit]`);
  const popover = page.getByTestId('popover');
  const picker = popover.getByTestId('status-picker');
  const editor = popover.getByTestId('label-editor');

  for (const [col, n, columns, rows] of [
    [three, 20, 3, 7],
    [two, 12, 2, 6],
  ] as const) {
    await cellOf(col).click();
    await expect(picker).toHaveAttribute('data-columns', String(columns));
    await expect(picker).toHaveAttribute('data-rows', String(rows));
    const pickerColumns = await picker.getAttribute('data-columns');
    await popover.getByRole('button', { name: 'עריכת תוויות' }).click();
    // The editor: the same columns and rows as the picker, the same labels in each.
    await expect(editor).toHaveAttribute('data-columns', pickerColumns!);
    await expect(editor).toHaveAttribute('data-rows', String(rows));
    await expect(editor.getByTestId('label-editor-column')).toHaveCount(columns);
    const cols = await editorColumns(editor);
    const prefix = n === 20 ? 'ג' : 'ב';
    expect(cols.flat()).toEqual(Array.from({ length: n }, (_, i) => `${prefix}${i}`));
    expect(cols[0]).toHaveLength(rows);
    // RTL: the second column is to the left of the first, its first label level with the first one.
    const first = (await editor.getByTestId('label-row').nth(0).boundingBox())!;
    const second = (await editor.getByTestId('label-row').nth(1).boundingBox())!;
    const nextColumn = (await editor.getByTestId('label-row').nth(rows).boundingBox())!;
    expect(Math.abs(second.x - first.x)).toBeLessThan(1);
    expect(second.y).toBeGreaterThan(first.y);
    expect(nextColumn.x + nextColumn.width).toBeLessThan(first.x);
    expect(Math.abs(nextColumn.y - first.y)).toBeLessThan(1);
    await expect(editor.getByText('כך יופיעו התוויות בבחירה')).toBeVisible();
    if (n === 20) {
      await editor.getByRole('button', { name: 'ביטול' }).click();
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
    }
  }

  // Two columns (6 + 6): drag the first label onto the second label of the second column — reading order.
  const rows = editor.getByTestId('label-row');
  await drag(page, rows.nth(0).getByRole('button', { name: 'גרירה לשינוי הסדר' }), rows.nth(7));
  await expect
    .poll(() => editorColumns(editor))
    .toEqual([
      ['ב1', 'ב2', 'ב3', 'ב4', 'ב5', 'ב6'],
      ['ב7', 'ב0', 'ב8', 'ב9', 'ב10', 'ב11'],
    ]);

  // A new label: 13 → 7 + 6, it shows at once at the end of the second column, focused.
  await editor.getByRole('button', { name: /תווית חדשה/ }).click();
  const fresh = editor.locator('[data-fresh]');
  await expect(fresh).toHaveCount(1);
  await expect(editor.getByTestId('label-editor-column').nth(1).getByTestId('label-row').last()).toHaveAttribute(
    'data-fresh',
    'true',
  );
  await expect(fresh.getByLabel('שם התווית')).toBeFocused();
  await page.keyboard.type('חדשה');
  expect((await editorColumns(editor)).map((c) => c.length)).toEqual([7, 6]);
  await editor.getByRole('button', { name: 'שמירה' }).click();
  await expect(editor).toHaveCount(0);

  // The picker shows them exactly there.
  await expect(picker).toHaveAttribute('data-columns', '2');
  await expect(picker).toHaveAttribute('data-rows', '7');
  const chips = picker.getByTestId('status-option');
  await expect(chips).toHaveText(['ב1', 'ב2', 'ב3', 'ב4', 'ב5', 'ב6', 'ב7', 'ב0', 'ב8', 'ב9', 'ב10', 'ב11', 'חדשה']);
  await popover.getByRole('button', { name: 'עריכת תוויות' }).click();
  await expect(editor).toHaveAttribute('data-columns', '2');
  await expect(editor).toHaveAttribute('data-rows', '7');
  await editor.getByRole('button', { name: 'ביטול' }).click();
  await page.keyboard.press('Escape');
});
