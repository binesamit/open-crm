// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * cardsub (prod items): the item card shows the item's subitems inside the "Fields" tab — a table under the
 * item's own fields, cells edited inline with the board's editors, "+ add subitem", a footer summing each column
 * like the board's; the "Subitems" tab picks a saved view of the sub-board (columns / filter / sort); the card's
 * settings turn the table under the fields off.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'put' | 'delete', path: string, data?: unknown) => {
    const res = await page.request[method](`/api/v1${path}`, { headers, data });
    expect(res.ok(), `${method} ${path}`).toBe(true);
    return (await res.json()) as T;
  };
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `סאב בכרטיס ${tag}`, workspace_id: ws.id });
  const item = await api<{ id: string }>('post', `/boards/${board.id}/items`, { name: `מוצרים ${tag}` });
  const first = await api<{ id: string }>('post', `/items/${item.id}/subitems`, { name: 'מוצר א' });
  const subId = (await api<{ subitems_board_id: string }>('get', `/boards/${board.id}`)).subitems_board_id;
  // The sub-board: a numbers column (quantity) and a text column, nothing else.
  const sub = await api<{ columns: { id: string; type: string }[] }>('get', `/boards/${subId}`);
  for (const c of sub.columns.filter((x) => x.type !== 'name')) await api('delete', `/boards/${subId}/columns/${c.id}`);
  await api('post', `/boards/${subId}/columns`, { id: 'qty', title: 'כמות', type: 'numbers' });
  await api('post', `/boards/${subId}/columns`, { id: 'notes', title: 'הערות', type: 'text' });
  const second = await api<{ id: string }>('post', `/items/${item.id}/subitems`, { name: 'מוצר ב' });
  await api('put', `/items/${first.id}/cells/qty`, { value: 2 });
  await api('put', `/items/${second.id}/cells/qty`, { value: 3 });
  // A saved view of the sub-board that hides the quantity and shows only quantities above 2.
  await api('post', `/boards/${subId}/views`, {
    name: `בלי כמות ${tag}`,
    type: 'table',
    visibility: 'shared',
    settings: {
      hidden_columns: ['qty'],
      query: {
        filter: {
          kind: 'group',
          operator: 'and',
          rules: [{ column_id: 'qty', operator: 'greater_than', values: [2] }],
        },
      },
    },
  });
  return { board, item, tag };
};

test('card: subitems inside the Fields tab — sum, inline edit, add; a view in the Subitems tab; off in settings', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { board, item, tag } = await setup(page);
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  const card = page.getByRole('dialog', { name: `מוצרים ${tag}` });
  await expect(card).toBeVisible();

  // Fields tab: the item's fields, then its subitems with the quantity column and the footer's sum.
  await card.locator('[data-testid="card-tab"][data-tab-id="fields"]').click();
  const section = card.getByTestId('card-fields-subitems');
  await expect(section).toBeVisible();
  const table = section.getByTestId('card-subitems-table');
  await expect(table.getByTestId('card-subitem')).toHaveCount(2);
  const sum = section.getByTestId('card-subitems-summary').locator('[data-summary="qty"]');
  await expect(sum).toContainText('5');

  // Inline edit: the quantity of "מוצר א" from 2 to 10 — the sum follows.
  const qty = table.locator('[data-testid="card-subitem"][data-item-name="מוצר א"] [data-column="qty"]');
  await qty.click();
  await qty.locator('input').fill('10');
  await qty.locator('input').press('Enter');
  await expect(qty).toHaveText('10');
  await expect(sum).toContainText('13');

  // "+ add subitem" in the same place.
  const add = section.getByTestId('card-subitems-add').locator('input');
  await add.fill('מוצר ג');
  await add.press('Enter');
  await expect(table.locator('[data-testid="card-subitem"][data-item-name="מוצר ג"]')).toBeVisible();
  await expect(table.getByTestId('card-subitem')).toHaveCount(3);

  // Subitems tab: pick the saved view — no quantity column, only quantities above 2 (10 and 3).
  await card.locator('[data-testid="card-tab"][data-tab-id="subitems"]').click();
  const tab = card.getByTestId('card-subitems');
  await expect(tab.locator('[data-column-head="qty"]')).toBeVisible();
  await tab.getByTestId('card-subitems-view').click();
  await page.getByRole('menuitemradio', { name: `בלי כמות ${tag}` }).click();
  await expect(tab.getByTestId('card-subitems-view')).toContainText(`בלי כמות ${tag}`);
  await expect(tab.locator('[data-column-head="qty"]')).toHaveCount(0);
  await expect(tab.locator('[data-column-head="notes"]')).toBeVisible();
  await expect(tab.getByTestId('card-subitem')).toHaveCount(2);
  await expect(tab.locator('[data-testid="card-subitem"][data-item-name="מוצר ג"]')).toHaveCount(0);
  // Back to the card's default: every subitem again.
  await tab.getByTestId('card-subitems-reset').click();
  await expect(tab.getByTestId('card-subitem')).toHaveCount(3);

  // Card settings: turn the table under the fields off.
  await card.getByTestId('card-tabs-settings').click();
  const dialog = page.getByTestId('card-tab-settings-dialog');
  await expect(dialog.getByTestId('card-subitems-settings')).toBeVisible();
  await dialog.getByTestId('card-subitems-in-fields').uncheck();
  await page.getByTestId('card-tabs-save').click();
  await expect(dialog).toBeHidden();
  const fieldsTab = card.locator('[data-testid="card-tab"][data-tab-id="fields"]');
  await fieldsTab.click();
  await expect(fieldsTab).toHaveAttribute('aria-current', 'page');
  await expect(card.getByTestId('card-fields-subitems')).toHaveCount(0);
});
