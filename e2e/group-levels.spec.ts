// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, pickGroupColumn, signIn } from './helpers';

/**
 * Prod ק3: grouping in levels — status, then amount inside each status: a header per
 * parent with its count, the inner sections indented with their rows, a summary per parent; a parent collapses its
 * levels; the levels are kept in the view; the board's groups can be the first level.
 */
test('two grouping levels: parents with counts and summaries, collapse a parent, kept after a reload', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const api = (path: string) => `/api/v1${path}`;
  const post = async (path: string, data: unknown) => {
    const res = await page.request.post(api(path), { headers, data });
    expect(res.ok(), await res.text()).toBeTruthy();
    return (await res.json()) as { id: string };
  };
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = await post('/boards', { name: `Group levels ${tag}`, workspace_id: ws });
  try {
    await post(`/boards/${board.id}/columns`, { id: 'st', title: 'מצב', type: 'status' });
    await post(`/boards/${board.id}/columns`, { id: 'amt', title: 'סכום', type: 'numbers' });
    await post(`/boards/${board.id}/items`, { name: 'A', cells: { st: { index: 1 }, amt: 100 } });
    await post(`/boards/${board.id}/items`, { name: 'B', cells: { st: { index: 1 }, amt: 300 } });
    await post(`/boards/${board.id}/items`, { name: 'C', cells: { st: { index: 0 }, amt: 100 } });

    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('toolbar-group').click();
    await pickGroupColumn(page, 'מצב');
    await page.getByTestId('group-add-level').click();
    await page.getByTestId('group-column-2').click();
    await page.getByRole('menu').getByRole('menuitemradio', { name: 'סכום', exact: true }).click();
    await page.getByTestId('group-mode-exact-2').click();
    await page.keyboard.press('Escape');

    const level = (n: number) => page.locator(`[data-testid="board-section"][data-level="${n}"]`);
    // Two statuses, each a parent; inside them the amounts (100 · 300 under one, 100 under the other).
    await expect(level(0)).toHaveCount(2);
    await expect(level(1)).toHaveCount(3);
    await expect(level(0).first()).toContainText('1');
    // A summary row closes each parent (after its inner sections' own).
    await expect(page.getByTestId('summary-row').first()).toBeVisible();

    // A parent collapses its levels: the last status (two amounts inside) folds, the other's one stays.
    await level(0).last().getByRole('button', { expanded: true }).first().click();
    await expect(level(1)).toHaveCount(1);

    // Kept in the view.
    await page.reload();
    await expect(level(0)).toHaveCount(2);
    await expect(level(1)).toHaveCount(1);

    // The board's groups as the first level.
    await page.getByTestId('toolbar-group').click();
    await pickGroupColumn(page, 'ללא קיבוץ (קבוצות הבורד)');
    await expect(page.getByTestId('group-level')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(level(0).first()).toBeVisible();
  } finally {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
  }
});
