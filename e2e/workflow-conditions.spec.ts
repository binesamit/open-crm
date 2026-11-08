// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * round 2 — conditions for a move on another column: "finance = paid in full" before חדש → בטיפול. A move
 * whose conditions are not met opens a popup on its own: the board's message, a ✓/✗ list and the finance column to
 * change there; saving makes the move with it. When the conditions are met the move happens at once, with no popup.
 */
const STAGES = [
  { id: 0, label: 'חדש', color: 'yellow', index: 0 },
  { id: 1, label: 'בטיפול', color: 'navy', index: 1 },
  { id: 2, label: 'סגור', color: 'forest', index: 2, is_done: true },
];
const FINANCE = [
  { id: 0, label: 'מקדמה', color: 'orange', index: 0 },
  { id: 1, label: 'שולם במלא', color: 'green', index: 1 },
];
const MESSAGE = 'אי אפשר להתקדם לפני תשלום מלא';

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

test('a move with a condition on another column: the popup shows what is missing and fixes it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'patch', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = Date.now().toString(36);
  const board = await api<{ id: string }>('post', '/boards', { name: `conditions ${tag}`, workspace_id: ws.id });
  const stage = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'שלב',
    type: 'status',
    settings: { labels: STAGES },
  });
  const finance = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'כספים',
    type: 'status',
    settings: { labels: FINANCE },
  });
  await api('patch', `/boards/${board.id}/columns/${stage.id}`, {
    settings: {
      labels: STAGES,
      workflow: {
        enabled: true,
        free_start: true,
        transitions: [
          {
            from: 0,
            to: 1,
            message: MESSAGE,
            conditions: {
              kind: 'group',
              operator: 'and',
              negate: false,
              rules: [{ kind: 'rule', column_id: finance.id, operator: 'any_of', values: ['1'], negate: false }],
            },
          },
          { from: 1, to: 2 },
        ],
      },
    },
  });
  const unpaid = `לא שולם ${tag}`;
  const paid = `שולם ${tag}`;
  await api('post', `/boards/${board.id}/items`, {
    name: unpaid,
    cells: { [stage.id]: { index: 0 }, [finance.id]: { index: 0 } },
  });
  await api('post', `/boards/${board.id}/items`, {
    name: paid,
    cells: { [stage.id]: { index: 0 }, [finance.id]: { index: 1 } },
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/a/demo/b/${board.id}`);

  // The editor calls them "conditions for the move" and keeps the board's own message.
  await page.locator(`[data-header="${stage.id}"]`).click({ button: 'right' });
  await page.getByRole('menu').getByTestId('column-workflow').click();
  const dialog = page.getByTestId('workflow-dialog');
  await dialog.getByTestId('workflow-move-0-1').getByRole('button').first().click();
  await expect(dialog.getByText('תנאים למעבר')).toBeVisible();
  await expect(dialog.getByTestId('workflow-message')).toHaveValue(MESSAGE);
  await page.screenshot({ path: test.info().outputPath('conditions-editor.png') });
  await page.getByRole('button', { name: 'ביטול', exact: true }).click();
  await expect(dialog).toBeHidden();

  // Paid: the move happens at once, no popup.
  const paidCell = row(page, paid).locator(`[data-column="${stage.id}"] [data-cell-edit]`);
  await paidCell.click();
  await page.getByTestId('popover').getByTestId('status-option').filter({ hasText: 'בטיפול' }).click();
  await expect(paidCell).toHaveText('בטיפול');
  await expect(page.getByTestId('popup-dialog')).toBeHidden();

  // Not paid: a popup with the message, the ✗ and the finance column.
  const cell = row(page, unpaid).locator(`[data-column="${stage.id}"] [data-cell-edit]`);
  await cell.click();
  await page.getByTestId('popover').getByTestId('status-option').filter({ hasText: 'בטיפול' }).click();
  const popup = page.getByTestId('popup-dialog');
  await expect(popup.getByTestId('popup-move-message')).toHaveText(MESSAGE);
  const check = popup.getByTestId('popup-check');
  await expect(check).toHaveCount(1);
  await expect(check).toHaveAttribute('data-met', 'false');
  await expect(check).toContainText('כספים צריך להיות: שולם במלא');
  await page.screenshot({ path: test.info().outputPath('conditions-popup.png') });

  // Changed in the popup: ticked off, and saved with the move.
  await popup.locator(`[data-testid="popup-input"][data-column="${finance.id}"] [data-cell-edit]`).click();
  await page.getByTestId('popover').getByTestId('status-option').filter({ hasText: 'שולם במלא' }).click();
  await expect(check).toHaveAttribute('data-met', 'true');
  await page.getByTestId('popup-save').click();
  await expect(popup).toBeHidden();
  await expect(cell).toHaveText('בטיפול');
  await expect(row(page, unpaid).locator(`[data-column="${finance.id}"]`)).toHaveText('שולם במלא');
});
