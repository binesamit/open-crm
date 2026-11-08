// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * r19relfilter leftovers — the form editor's warning. A connect-boards column offers only the clients of a shared
 * view ("active"); a hidden question on it that links an inactive client shows a yellow, non-blocking warning in the
 * form editor (the form still links it on submit, marked). Picking an active client clears the warning.
 */

const json = async <T>(res: { json: () => Promise<unknown> }) => (await res.json()) as T;

const makeBoards = async (page: Page, suffix: string) => {
  const { headers } = await ownerContext(page);
  const ws = (await json<{ data: { id: string }[] }>(await page.request.get('/api/v1/workspaces', { headers })))
    .data[0]!.id;
  const post = (path: string, data: unknown) => page.request.post(`/api/v1${path}`, { headers, data });
  const clients = await json<{ id: string }>(await post('/boards', { name: `לקוחות ${suffix}`, workspace_id: ws }));
  await post(`/boards/${clients.id}/columns`, {
    id: 'state',
    title: 'מצב',
    type: 'status',
    settings: {
      labels: [
        { id: 1, label: 'פעיל', color: 'forest', index: 0 },
        { id: 2, label: 'לא פעיל', color: 'gray', index: 1 },
      ],
    },
  });
  await post(`/boards/${clients.id}/items`, { name: `פעיל ${suffix}`, cells: { state: { index: 1 } } });
  await post(`/boards/${clients.id}/items`, { name: `רדום ${suffix}`, cells: { state: { index: 2 } } });
  const view = await json<{ id: string }>(
    await post(`/boards/${clients.id}/views`, {
      name: `פעילים ${suffix}`,
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
    }),
  );
  const board = await json<{ id: string }>(await post('/boards', { name: `עסקאות ${suffix}`, workspace_id: ws }));
  await post(`/boards/${board.id}/columns`, {
    id: 'client',
    title: 'לקוח',
    type: 'board_relation',
    settings: {
      board_ids: [clients.id],
      choice_filter: { [clients.id]: { mode: 'view', view_id: view.id } },
    },
  });
  return { boardId: board.id };
};

test('a hidden connect-boards value outside the column filter shows a yellow warning in the form editor', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const suffix = Date.now().toString(36);
  const b = await makeBoards(page, suffix);
  await page.goto(`/a/demo/b/${b.boardId}`);

  await page.getByTestId('view-add').click();
  await page.getByTestId('view-add-form').click();
  await page.getByRole('dialog').getByRole('textbox').fill('טופס עסקה');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('form-view')).toBeVisible();

  // "Client" (connect boards): hidden by itself, an item of the linked board.
  await page.getByTestId('form-add-question').click();
  await page.getByTestId('form-add-column-client').click();
  const client = page.locator('[data-testid="form-question"][data-column="client"]');
  await expect(client.getByTestId('form-hidden-source-item')).toHaveAttribute('aria-checked', 'true');

  // An inactive client: the column's filter does not offer it → the warning (the value is kept).
  await client.getByTestId('form-hidden-item-search').fill(`רדום ${suffix}`);
  await client
    .getByTestId('form-hidden-item-option')
    .filter({ hasText: `רדום ${suffix}` })
    .click();
  await expect(client.getByTestId('form-hidden-item-picked')).toHaveText(`רדום ${suffix}`);
  const warning = client.getByTestId('form-hidden-choice-warning');
  await expect(warning).toBeVisible();
  await expect(warning.getByRole('status')).toContainText(`פעילים ${suffix}`);

  // An active client: no warning.
  await client.getByTestId('form-hidden-item-change').click();
  await client.getByTestId('form-hidden-item-search').fill(`פעיל ${suffix}`);
  await client
    .getByTestId('form-hidden-item-option')
    .filter({ hasText: `פעיל ${suffix}` })
    .click();
  await expect(client.getByTestId('form-hidden-item-picked')).toHaveText(`פעיל ${suffix}`);
  await expect(client.getByTestId('form-hidden-choice-warning')).toHaveCount(0);
});
