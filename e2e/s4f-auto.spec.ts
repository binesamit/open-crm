// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * s4f-auto — "date arrives" on a "last updated" column: the trigger's column picker offers last-updated columns
 * (of chosen columns too, r23ui) next to the date columns, and the saved automation reads that column's time (the
 * schedule logic itself is covered by apps/api/test/s4f-auto-date-last-updated.test.ts).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `s4f auto ${tag}`, workspace_id: ws.id });
  await api('post', `/boards/${board.id}/columns`, { id: 'stage', title: 'שלב', type: 'text' });
  await api('post', `/boards/${board.id}/columns`, { id: 'due', title: 'יעד', type: 'date' });
  await api('post', `/boards/${board.id}/columns`, {
    id: 'stage_upd',
    title: 'שלב עודכן',
    type: 'last_updated',
    settings: { mode: 'date', columns: ['stage'] },
  });
  await api('post', `/boards/${board.id}/columns`, { id: 'made', title: 'נוצר', type: 'creation_log' });
  await api('post', `/boards/${board.id}/items`, { name: `Deal ${tag}` });
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(page.locator(`[data-testid="item-row"][data-item-name="Deal ${tag}"]`)).toBeVisible();
  return { board, headers };
};

test('date arrives: the trigger picks a last-updated column and saves', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { board, headers } = await setup(page);

  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  // The "date arrives → set status" recipe from the dates category.
  await page.getByTestId('auto-template-cat-dates').click();
  await page.locator('[data-testid="automation-template"][data-id="date_set_status"]').click();
  const builder = page.getByTestId('automation-builder');
  await expect(builder).toBeVisible();

  await builder.locator('[data-slot="trigger.column"]').click();
  const pop = page.getByTestId('popover');
  const options = pop.getByTestId('slot-option');
  await expect(options.filter({ hasText: 'יעד' })).toBeVisible();
  await expect(options.filter({ hasText: 'שלב עודכן' })).toBeVisible();
  // Other computed columns and plain text are not dates a trigger can wait for.
  await expect(options.filter({ hasText: 'נוצר' })).toHaveCount(0);
  await expect(options.filter({ hasText: /^שלב$/ })).toHaveCount(0);
  await options.filter({ hasText: 'שלב עודכן' }).click();
  await expect(builder.locator('[data-slot="trigger.column"]')).toContainText('שלב עודכן');

  // The server accepts the same trigger (save-time validation of the column type).
  const res = await page.request.post(`/api/v1/boards/${board.id}/automations`, {
    headers,
    data: {
      title: 'שלב תקוע',
      recipe: {
        trigger: { type: 'date_arrived', column: 'stage_upd', offset_days: 3, time: '09:00' },
        actions: [{ type: 'notify', to: '@board_owners', message: '{item.name}' }],
      },
    },
  });
  expect(res.status()).toBe(201);
});
