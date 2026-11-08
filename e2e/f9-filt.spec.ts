// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod bug (f9 filt): on an imported board, opening the filter crashed the whole view ("משהו השתבש
 * בתצוגה הזו" — Operator "is_empty" does not apply to …" on a creation log column). Now:
 * - the panel offers only operators / quick choices the column type supports (a creation log: relative dates, no
 *   "blank" — it is never empty);
 * - a saved view with a rule the type does not support (old / imported data) still shows its items; the rule is
 *   skipped, marked invalid in the builder, not counted, and can be removed.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

type Json = { id: string; [k: string]: unknown };

const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async <T = Json>(method: 'get' | 'post' | 'patch', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api('post', '/boards', { name: `f9 סינון ${tag}`, workspace_id: ws.id });
  // A creation log column with an imported key.
  await api('post', `/boards/${board.id}/columns`, { id: 'created_log_f9', title: 'יומן יצירה', type: 'creation_log' });
  await api('post', `/boards/${board.id}/columns`, { id: 'stage', title: 'שלב', type: 'status' });
  for (const name of ['Alpha', 'Bravo']) await api('post', `/boards/${board.id}/items`, { name });
  return { api, board, tag };
};

const names = (page: Page) =>
  page.getByTestId('item-row').evaluateAll((rows) => rows.map((r) => r.getAttribute('data-item-name')));

test('the filter panel opens on a creation log column and offers only what it supports', async ({ page }) => {
  const { board } = await setup(page);
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('toolbar-filter').click();
  const panel = page.getByTestId('filter-panel');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('error-screen')).toHaveCount(0);

  // Quick filter: relative dates, but no "blank" for a column that is never empty.
  await panel.getByTestId('filter-rail-created_log_f9').click();
  const quick = panel.getByTestId('quick-created_log_f9');
  await expect(quick.getByRole('button', { name: /היום/ })).toBeVisible();
  await expect(quick.getByRole('button', { name: /^ללא/ })).toHaveCount(0);
  await quick.getByRole('button', { name: /היום/ }).click();
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Bravo']);

  // Advanced: the operator menu of the creation log has no "is empty" / "is not empty".
  await panel.getByTestId('filter-rail-advanced').click();
  await panel.getByTestId('filter-add-rule').click();
  const rule = panel.getByTestId('filter-rule').last();
  await rule.getByTestId('rule-column').click();
  await page.getByRole('menuitemradio', { name: 'יומן יצירה', exact: true }).click();
  await rule.getByTestId('rule-operator').click();
  await expect(page.getByRole('menuitemradio', { name: 'ריק', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitemradio', { name: 'לא ריק', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('error-screen')).toHaveCount(0);
});

test('a saved view with an operator the column does not support still works; the rule is marked and removable', async ({
  page,
}) => {
  const { api, board, tag } = await setup(page);
  const viewName = `ישן ${tag}`;
  await api('post', `/boards/${board.id}/views`, {
    name: viewName,
    type: 'table',
    settings: {
      query: {
        filter: {
          kind: 'group',
          operator: 'and',
          rules: [{ kind: 'rule', column_id: 'created_log_f9', operator: 'is_empty', values: [], negate: false }],
        },
      },
    },
  });
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('view-tab').filter({ hasText: viewName }).click();

  // The view shows its items (the stale rule is skipped), not the error screen; the rule is not counted.
  await expect.poll(() => names(page)).toEqual(['Alpha', 'Bravo']);
  await expect(page.getByTestId('error-screen')).toHaveCount(0);
  await expect(page.getByTestId('toolbar-filter-count')).toHaveCount(0);

  // The builder marks it invalid and it can be removed.
  await page.getByTestId('toolbar-filter').click();
  const panel = page.getByTestId('filter-panel');
  const rule = panel.locator('[data-testid="filter-rule"][data-invalid="invalid_operator"]');
  await expect(rule).toHaveCount(1);
  await expect(rule.getByTestId('filter-rule-invalid')).toBeVisible();
  await rule.getByRole('button', { name: 'הסרת תנאי' }).click();
  await expect(panel.getByTestId('filter-rule')).toHaveCount(0);
  await expect(page.getByTestId('error-screen')).toHaveCount(0);
});
