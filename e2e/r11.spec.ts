// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Round 11 (product owner): "כאשר יש ערך בשדה חיפוש ועוברים בין התצוגות הוא צריך להישאר" — the board's search text is the
 * board's, not a view's: it stays when switching between the board's views (table / cards / kanban…), survives a
 * refresh in the same tab, is not a change to the view (no save bar), and the X clears it everywhere.
 * Setup goes through the API; the UI is what is under test.
 */
const json = async <T>(res: { json: () => Promise<unknown> }) => (await res.json()) as T;
const rowNames = (page: Page) =>
  page.getByTestId('item-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-item-name')));
const tiles = (page: Page) => page.getByTestId('cards').getByTestId('item-tile');
const tab = (page: Page, name: string) => page.getByTestId('view-tab').filter({ hasText: name });
const openTab = async (page: Page, name: string) => {
  await tab(page, name).click();
  await expect(tab(page, name)).toHaveAttribute('aria-selected', 'true');
};

test('the board search stays when switching views; X clears it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = (await json<{ data: { id: string }[] }>(await page.request.get('/api/v1/workspaces', { headers })))
    .data[0]!.id;
  const boardId = (
    await json<{ id: string }>(
      await page.request.post('/api/v1/boards', {
        headers,
        data: { name: `סבב11 חיפוש ${Date.now().toString(36)}`, workspace_id: ws },
      }),
    )
  ).id;
  for (const name of ['Alpha', 'Bravo', 'Charlie'])
    await page.request.post(`/api/v1/boards/${boardId}/items`, { headers, data: { name } });

  await page.goto(`/a/demo/b/${boardId}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
  // A second view of another type (cards); it opens on creation.
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: /כרטיסים/ }).click();
  await page.getByRole('dialog').getByRole('textbox').fill('גלריה');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(tab(page, 'גלריה')).toHaveAttribute('aria-selected', 'true');
  await expect(tiles(page)).toHaveCount(3);

  // Search in the table…
  await openTab(page, 'טבלה');
  const search = page.getByTestId('toolbar-search');
  await search.fill('bra');
  await expect.poll(() => rowNames(page)).toEqual(['Bravo']);
  // …is not a change to the view.
  await expect(page.getByTestId('save-bar')).toBeHidden();

  // …and stays in the cards view, still filtering.
  await openTab(page, 'גלריה');
  await expect(search).toHaveValue('bra');
  await expect(tiles(page)).toHaveCount(1);
  await expect(page.getByTestId('save-bar')).toBeHidden();

  // …and back in the table.
  await openTab(page, 'טבלה');
  await expect(search).toHaveValue('bra');
  await expect.poll(() => rowNames(page)).toEqual(['Bravo']);

  // A refresh in the same tab keeps it.
  await page.reload();
  await expect(page.getByTestId('toolbar-search')).toHaveValue('bra');
  await expect.poll(() => rowNames(page)).toEqual(['Bravo']);

  // Typed and switched at once (inside the typing pause): kept too.
  await page.getByTestId('toolbar-search').fill('char');
  await openTab(page, 'גלריה');
  await expect(page.getByTestId('toolbar-search')).toHaveValue('char');
  await expect(tiles(page)).toHaveCount(1);

  // The X clears it — in every view.
  await page.getByTestId('toolbar-search-clear').click();
  await expect(page.getByTestId('toolbar-search')).toHaveValue('');
  await expect(tiles(page)).toHaveCount(3);
  await openTab(page, 'טבלה');
  await expect(page.getByTestId('toolbar-search')).toHaveValue('');
  await expect.poll(async () => (await rowNames(page)).sort()).toEqual(['Alpha', 'Bravo', 'Charlie']);
});
