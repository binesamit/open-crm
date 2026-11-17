// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * r19relfilter (the planning notes "RELATION-FILTERS", ס7): a connect-boards column that offers only the items of a shared
 * view of the linked board. The column settings pick the view; the picker lists only matching items with a
 * "by …" caption; a linked item that stops matching stays, greyed with ⚠, and can be unlinked; "show only matching
 * in the cell" hides it behind "+1 hidden". Setup goes through the API; the UI is what is under test.
 */
const json = async <T>(res: { json: () => Promise<unknown> }) => (await res.json()) as T;
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const cell = (page: Page, name: string, column: string) => row(page, name).locator(`[data-column="${column}"]`);

const LABELS = [
  { id: 1, label: 'פעיל', color: 'forest', index: 0 },
  { id: 2, label: 'לא פעיל', color: 'gray', index: 1 },
];

const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = (await json<{ data: { id: string }[] }>(await page.request.get('/api/v1/workspaces', { headers })))
    .data[0]!.id;
  const stamp = Date.now().toString(36);
  const board = async (n: string) =>
    (
      await json<{ id: string }>(
        await page.request.post('/api/v1/boards', { headers, data: { name: `${n} ${stamp}`, workspace_id: ws } }),
      )
    ).id;
  const clients = await board('סבב19 לקוחות');
  const deals = await board('סבב19 עסקאות');
  await page.request.post(`/api/v1/boards/${clients}/columns`, {
    headers,
    data: { id: 'state', title: 'מצב', type: 'status', settings: { labels: LABELS } },
  });
  await page.request.post(`/api/v1/boards/${deals}/columns`, {
    headers,
    data: { id: 'client', title: 'לקוח', type: 'board_relation', settings: { board_ids: [clients] } },
  });
  const item = (boardId: string, n: string, cells: Record<string, unknown> = {}) =>
    page.request
      .post(`/api/v1/boards/${boardId}/items`, { headers, data: { name: n, cells } })
      .then((r) => json<{ id: string }>(r));
  const view = await json<{ id: string }>(
    await page.request.post(`/api/v1/boards/${clients}/views`, {
      headers,
      data: {
        name: 'לקוחות פעילים',
        type: 'table',
        visibility: 'shared',
        settings: {
          query: {
            filter: {
              kind: 'group',
              operator: 'and',
              negate: false,
              rules: [{ kind: 'rule', column_id: 'state', operator: 'any_of', values: ['פעיל'], negate: false }],
            },
          },
        },
      },
    }),
  );
  const levi = await item(clients, 'לוי ושות', { state: { index: 1 } });
  await item(clients, 'פעיל בעמ', { state: { index: 1 } });
  await item(clients, 'כהן בעמ', { state: { index: 2 } });
  await item(deals, 'עסקה ישנה', { client: { item_ids: [levi.id] } });
  await item(deals, 'עסקה חדשה');
  const setState = (id: string, index: number) =>
    page.request.put(`/api/v1/items/${id}/cells/state`, { headers, data: { value: { index } } });
  return { headers, clients, deals, view, levi, setState };
};

const openBoard = async (page: Page, boardId: string) => {
  await page.goto(`/a/demo/b/${boardId}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
};

const columnSettings = async (page: Page, title: string) => {
  await page.getByRole('button', { name: new RegExp(`^פעולות לעמודה ${title}`) }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'הגדרות עמודה' }).click();
};

test('a relation column offers only the items of a shared view; a link that stops matching stays marked', async ({
  page,
}) => {
  const s = await setup(page);
  await openBoard(page, s.deals);

  // ס3: the column settings pick "by view" → the shared view.
  await columnSettings(page, 'לקוח');
  const section = page.getByTestId('relation-filter-section');
  await expect(section).toBeVisible();
  await section.getByTestId('relation-filter-mode-view').click();
  await page.getByTestId('relation-filter-view').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'לקוחות פעילים', exact: true }).click();
  await expect(page.getByTestId('relation-filter-live-note')).toBeVisible();
  await page.getByTestId('column-settings-save').click();
  await expect(section).toHaveCount(0);

  // ס4: the picker lists only matching items, with the caption.
  await cell(page, 'עסקה חדשה', 'client').click();
  await expect(page.getByTestId('relation-filter-caption')).toBeVisible();
  const list = page.getByRole('listbox');
  await expect(list.getByText('פעיל בעמ')).toBeVisible();
  await expect(list.getByText('לוי ושות')).toBeVisible();
  await expect(list.getByText('כהן בעמ')).toHaveCount(0);
  await page.getByPlaceholder('חיפוש פריטים').fill('כהן');
  await expect(page.getByTestId('relation-hidden-hint')).toBeVisible();
  await page.keyboard.press('Escape');

  // The linked client becomes inactive: the link stays, greyed with ⚠.
  expect((await s.setState(s.levi.id, 2)).ok()).toBe(true);
  await page.reload();
  await expect(page.getByTestId('board-scroll')).toBeVisible();
  const old = cell(page, 'עסקה ישנה', 'client');
  await expect(old.getByTestId('relation-chip-unmatched')).toContainText('לוי ושות');

  // "Show only matching in the cell": hidden behind "+1".
  await columnSettings(page, 'לקוח');
  await page.getByTestId('relation-only-matching').check();
  await page.getByTestId('column-settings-save').click();
  await expect(old.getByTestId('relation-hidden-count')).toBeVisible();
  await expect(old.getByTestId('relation-chip-unmatched')).toHaveCount(0);

  // Back to showing everything; then remove the link from the chip.
  await columnSettings(page, 'לקוח');
  await page.getByTestId('relation-only-matching').uncheck();
  await page.getByTestId('column-settings-save').click();
  await old.getByTestId('relation-unlink').click();
  await expect(old.getByTestId('relation-chip-unmatched')).toHaveCount(0);
  const res = await page.request.get(`/api/v1/boards/${s.deals}/items`, { headers: s.headers });
  const deal = (await json<{ data: { name: string; cells: Record<string, unknown> }[] }>(res)).data.find(
    (i) => i.name === 'עסקה ישנה',
  );
  expect(deal?.cells.client).toBeUndefined();
});

test('the board filter "has a link that does not match" finds the deals linked to an inactive client', async ({
  page,
}) => {
  const s = await setup(page);
  await page.request.patch(`/api/v1/boards/${s.deals}/columns/client`, {
    headers: s.headers,
    data: {
      settings: { board_ids: [s.clients], choice_filter: { [s.clients]: { mode: 'view', view_id: s.view.id } } },
    },
  });
  await s.setState(s.levi.id, 2);
  const q = Buffer.from(
    JSON.stringify({
      filter: {
        kind: 'group',
        operator: 'and',
        negate: false,
        rules: [{ kind: 'rule', column_id: 'client', operator: 'has_unmatched_link', values: [], negate: false }],
      },
    }),
  ).toString('base64url');
  await page.goto(`/a/demo/b/${s.deals}?q=${q}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
  await expect(row(page, 'עסקה ישנה')).toBeVisible();
  await expect(row(page, 'עסקה חדשה')).toHaveCount(0);
});
