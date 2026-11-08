// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * a workflow move that needs subitems: the owner turns the rule on for a move (at least 2 subitems with
 * an amount); the move then opens a popup with the item's subitems, where new ones are added with their amounts and
 * saved together with the move.
 */
const LABELS = [
  { id: 0, label: 'חדש', color: 'yellow', index: 0 },
  { id: 1, label: 'בטיפול', color: 'navy', index: 1 },
  { id: 2, label: 'סגור', color: 'forest', index: 2, is_done: true },
];

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

test('a move needs subitems: the popup adds them with their values and saves them with the move', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = Date.now().toString(36);
  const board = await api<{ id: string }>('post', '/boards', { name: `subitems rule ${tag}`, workspace_id: ws.id });
  const stage = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'שלב',
    type: 'status',
    settings: { labels: LABELS },
  });
  const name = `הצעה ${tag}`;
  const item = await api<{ id: string }>('post', `/boards/${board.id}/items`, {
    name,
    cells: { [stage.id]: { index: 0 } },
  });
  // The board's sub-board (made by a first subitem elsewhere) gets an amount column.
  const seed = await api<{ id: string }>('post', `/boards/${board.id}/items`, { name: `seed ${tag}` });
  await api('post', `/items/${seed.id}/subitems`, { name: 'seed' });
  const subId = (await api<{ subitems_board_id: string }>('get', `/boards/${board.id}`)).subitems_board_id;
  const amount = await api<{ id: string }>('post', `/boards/${subId}/columns`, { title: 'סכום', type: 'numbers' });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/a/demo/b/${board.id}`);

  // The owner: חדש → בטיפול needs at least 2 subitems with "סכום".
  await page.locator(`[data-header="${stage.id}"]`).click({ button: 'right' });
  await page.getByRole('menu').getByTestId('column-workflow').click();
  const dialog = page.getByTestId('workflow-dialog');
  await dialog.getByTestId('workflow-cell-0-1').click();
  await dialog.getByTestId('workflow-cell-1-2').click();
  await dialog.getByTestId('workflow-move-0-1').getByRole('button').first().click();
  const rules = dialog.getByTestId('workflow-subitems');
  await rules.getByTestId('workflow-subitems-on').click();
  await rules.getByTestId('workflow-subitems-min').fill('2');
  await rules.getByTestId(`workflow-subitems-required-${amount.id}`).click();
  await expect(rules.getByTestId(`workflow-subitems-required-${amount.id}`)).toHaveAttribute('aria-pressed', 'true');
  await page.screenshot({ path: test.info().outputPath('subitems-rule.png') });
  await page.getByTestId('workflow-save').click();
  await expect(dialog).toBeHidden();

  // The move opens the popup with a subitems section; saving with none says what is missing.
  const cell = row(page, name).locator(`[data-column="${stage.id}"] [data-cell-edit]`);
  await cell.click();
  await page.getByTestId('popover').getByTestId('status-option').filter({ hasText: 'בטיפול' }).click();
  const popup = page.getByTestId('popup-dialog');
  await expect(popup.getByTestId('popup-subitems')).toBeVisible();
  await expect(popup.getByTestId('popup-subitems-count')).toHaveText('0 מתוך 2 נדרשים');
  await page.getByTestId('popup-save').click();
  await expect(page.getByTestId('popup-error')).toHaveText('צריך לפחות 2 תתי-פריטים שמלאים בהם: סכום');
  await expect(cell).toHaveText('חדש');

  // Two new rows with their amounts.
  for (const [i, [line, sum]] of [
    ['עיצוב', '1200'],
    ['פיתוח', '3400'],
  ].entries()) {
    await popup.getByTestId('popup-subitems-add').click();
    const r = popup.getByTestId('popup-subitem-new').nth(i);
    await r.getByTestId('popup-subitem-name').fill(line!);
    await r.locator(`[data-column="${amount.id}"]`).click();
    await page.keyboard.type(sum!);
    await page.keyboard.press('Enter');
  }
  await expect(popup.getByTestId('popup-subitems-count')).toHaveText('2 מתוך 2 נדרשים ✓');
  await page.screenshot({ path: test.info().outputPath('subitems-popup.png') });
  await page.getByTestId('popup-save').click();
  await expect(popup).toBeHidden();
  await expect(cell).toHaveText('בטיפול');

  const subs = (
    await api<{ data: { parent_item_id: string; name: string; cells: Record<string, { value: unknown }> }[] }>(
      'get',
      `/boards/${subId}/items`,
    )
  ).data.filter((x) => x.parent_item_id === item.id);
  expect(subs.map((x) => [x.name, x.cells[amount.id]?.value]).sort()).toEqual([
    ['עיצוב', 1200],
    ['פיתוח', 3400],
  ]);
});

test('a computed subitem name: the popup asks for its connected-board column, not a typed name', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'put', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = Date.now().toString(36);
  const clients = await api<{ id: string }>('post', '/boards', { name: `clients ${tag}`, workspace_id: ws.id });
  const client = `לקוח ${tag}`;
  await api('post', `/boards/${clients.id}/items`, { name: client });
  const board = await api<{ id: string }>('post', '/boards', { name: `computed subitems ${tag}`, workspace_id: ws.id });
  const stage = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'שלב',
    type: 'status',
    settings: { labels: LABELS },
  });
  const name = `עסקה ${tag}`;
  const item = await api<{ id: string }>('post', `/boards/${board.id}/items`, {
    name,
    cells: { [stage.id]: { index: 0 } },
  });
  const seed = await api<{ id: string }>('post', `/boards/${board.id}/items`, { name: `seed ${tag}` });
  await api('post', `/items/${seed.id}/subitems`, { name: 'seed' });
  const subId = (await api<{ subitems_board_id: string }>('get', `/boards/${board.id}`)).subitems_board_id;
  // The subitems' name is the client they are linked to.
  const rel = await api<{ id: string }>('post', `/boards/${subId}/columns`, {
    title: 'לקוח',
    type: 'board_relation',
    settings: { board_ids: [clients.id], allow_multiple: false },
  });
  await api('put', `/boards/${subId}/name-source`, { mode: 'column', column_id: rel.id });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/a/demo/b/${board.id}`);
  await page.locator(`[data-header="${stage.id}"]`).click({ button: 'right' });
  await page.getByRole('menu').getByTestId('column-workflow').click();
  const dialog = page.getByTestId('workflow-dialog');
  await dialog.getByTestId('workflow-cell-0-1').click();
  await dialog.getByTestId('workflow-cell-1-2').click();
  await dialog.getByTestId('workflow-move-0-1').getByRole('button').first().click();
  const rules = dialog.getByTestId('workflow-subitems');
  await rules.getByTestId('workflow-subitems-on').click();
  // The connected-board column can be required.
  await rules.getByTestId(`workflow-subitems-required-${rel.id}`).click();
  await page.getByTestId('workflow-save').click();
  await expect(dialog).toBeHidden();

  const cell = row(page, name).locator(`[data-column="${stage.id}"] [data-cell-edit]`);
  await cell.click();
  await page.getByTestId('popover').getByTestId('status-option').filter({ hasText: 'בטיפול' }).click();
  const popup = page.getByTestId('popup-dialog');
  await popup.getByTestId('popup-subitems-add').click();
  const r = popup.getByTestId('popup-subitem-new').first();
  // No typed name: it is built from the client column, which is in the row.
  await expect(r.getByTestId('popup-subitem-name')).toHaveCount(0);
  await expect(r.getByTestId('popup-subitem-name-computed')).toBeVisible();
  await r.locator(`[data-column="${rel.id}"]`).click();
  await page.locator('label').filter({ hasText: client }).click();
  // The picked client shows by its name in the draft.
  await expect(r.locator(`[data-column="${rel.id}"]`)).toContainText(client);
  await expect(popup.getByTestId('popup-subitems-count')).toHaveText('1 מתוך 1 נדרשים ✓');
  await page.screenshot({ path: test.info().outputPath('computed-name-popup.png') });
  await page.getByTestId('popup-save').click();
  await expect(popup).toBeHidden();
  await expect(cell).toHaveText('בטיפול');

  const subs = (
    await api<{ data: { parent_item_id: string; name: string }[] }>('get', `/boards/${subId}/items`)
  ).data.filter((x) => x.parent_item_id === item.id);
  expect(subs.map((x) => x.name)).toEqual([client]);
});
