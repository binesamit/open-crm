// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod — "set a computed value" in the builder: a trigger that hears two columns (checked in its picker)
 * the calculation typed with column names and the linked board's columns offered by name, a preview on the board's
 * items, then the saved automation computing quantity × the linked service's minutes into a plain number column.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T = Json>(method: 'get' | 'post' | 'put', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const services = await api('post', '/boards', { name: `Services ${tag}`, workspace_id: ws.id });
  await api('post', `/boards/${services.id}/columns`, { id: 'min', title: 'דקות ליחידה', type: 'numbers' });
  const wash = await api('post', `/boards/${services.id}/items`, { name: `Wash ${tag}` });
  await api('put', `/items/${wash.id}/cells/min`, { value: 10 });
  const jobs = await api('post', '/boards', { name: `Jobs ${tag}`, workspace_id: ws.id });
  await api('post', `/boards/${jobs.id}/columns`, { id: 'qty', title: 'כמות', type: 'numbers' });
  await api('post', `/boards/${jobs.id}/columns`, {
    id: 'svc',
    title: 'שירות',
    type: 'board_relation',
    settings: { board_ids: [services.id] },
  });
  await api('post', `/boards/${jobs.id}/columns`, { id: 'minutes', title: 'דקות מתוכננות', type: 'numbers' });
  const line = await api('post', `/boards/${jobs.id}/items`, { name: `Line ${tag}` });
  await api('put', `/items/${line.id}/cells/qty`, { value: 3 });
  await api('put', `/items/${line.id}/cells/svc`, { value: { item_ids: [wash.id] } });
  const cell = async (key: string) => (await api('get', `/items/${line.id}`)).cells?.[key]?.value ?? null;
  const cleanup = async () => {
    for (const b of [jobs.id, services.id]) await page.request.delete(`/api/v1/boards/${b}`, { headers });
  };
  return { api, jobs, line, tag, cell, cleanup };
};

test.beforeEach(async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
});

test('set a computed value: two trigger columns, the calculation by name, a preview, then a run', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1280, height: 860 });
  const { api, jobs, line, tag, cell, cleanup } = await setup(page);
  try {
    await page.goto(`/a/demo/b/${jobs.id}`);
    await expect(page.locator(`[data-testid="item-row"][data-item-name="Line ${tag}"]`)).toBeVisible();
    await page.getByTestId('board-automations').click();
    await page.getByTestId('auto-tab-create').click();
    await page.getByTestId('auto-custom').click();
    const builder = page.getByTestId('automation-builder');
    await expect(builder).toBeVisible();
    const pop = page.getByTestId('popover');

    // "When a column changes": the picker checks several columns and stays open; the sentence names them all.
    await builder.getByTestId('auto-trigger-type').click();
    await page.getByTestId('auto-trigger-column_changed').click();
    await builder.locator('[data-slot="trigger.column"]').click();
    await expect(pop.getByTestId('slot-multi-columns')).toBeVisible();
    await pop.getByTestId('slot-option').filter({ hasText: 'כמות' }).first().click();
    await pop.getByTestId('slot-option').filter({ hasText: 'שירות' }).first().click();
    await expect(pop.getByTestId('slot-multi-columns')).toBeVisible();
    await page.keyboard.press('Escape');
    const trigger = builder.locator('[data-slot="trigger.column"]');
    await expect(trigger).toContainText('כמות');
    await expect(trigger).toContainText('שירות');

    // The action, its target column, then the calculation.
    await builder.getByTestId('auto-add-action').click();
    await page.getByTestId('auto-action-set_computed').click();
    await builder.locator('[data-slot="actions.0.column"]').click();
    await pop.getByTestId('slot-option').filter({ hasText: 'דקות מתוכננות' }).first().click();
    await expect(builder.locator('[data-slot="actions.0.column"]')).toContainText('דקות מתוכננות');

    await builder.locator('[data-slot="actions.0.expression"]').click();
    const editor = page.getByTestId('slot-expression');
    await expect(editor).toBeVisible();
    // The item's columns and the linked board's, by name; a pick types its reference.
    await editor.getByTestId('computed-vars-item').getByRole('button', { name: 'כמות' }).click();
    await expect(editor.getByTestId('slot-text')).toHaveValue('{כמות}');
    await expect(editor.getByTestId('computed-vars-svc').getByRole('button', { name: 'דקות ליחידה' })).toBeVisible();
    await editor.getByTestId('slot-text').fill('{כמות|1} * {שירות.דקות ליחידה}');

    // The preview computes on the board's item (nothing is written).
    await editor.getByTestId('computed-preview-run').click();
    await expect(editor.getByTestId('computed-preview-row').filter({ hasText: `Line ${tag}` })).toContainText('30');
    expect(await cell('minutes')).toBeNull();

    // A missing column is named.
    await editor.getByTestId('slot-text').fill('{כמות} * {אין כזו}');
    await editor.getByTestId('computed-preview-run').click();
    await expect(editor.getByTestId('computed-preview-error')).toContainText('אין כזו');

    await editor.getByTestId('slot-text').fill('{כמות|1} * {שירות.דקות ליחידה}');
    await editor.getByTestId('slot-apply').click();
    await expect(editor).toBeHidden();
    await expect(builder.locator('[data-slot="actions.0.expression"]')).toContainText('{כמות|1} * {שירות.דקות ליחידה}');

    // Saved with keys; the engine computes when the quantity changes.
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/boards/${jobs.id}/automations`),
    );
    await page.getByTestId('auto-save').click();
    const res = await saved;
    expect(res.ok()).toBe(true);
    const recipe = ((await res.json()) as Json).recipe;
    expect(recipe.trigger).toMatchObject({ type: 'column_changed', columns: ['qty', 'svc'] });
    expect(recipe.actions[0]).toMatchObject({
      type: 'set_computed',
      column: 'minutes',
      expression: '{qty|1} * {svc.min}',
    });

    await api('put', `/items/${line.id}/cells/qty`, { value: 5 });
    await expect.poll(() => cell('minutes'), { timeout: 30_000 }).toBe(50);
    // A hand edit of the result is kept (the automation does not hear its own column).
    await api('put', `/items/${line.id}/cells/minutes`, { value: 99 });
    await page.waitForTimeout(3_000);
    expect(await cell('minutes')).toBe(99);
  } finally {
    await cleanup();
  }
});
