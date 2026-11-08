// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Plan — "whose timer" in the builder: a new timer action defaults to whoever made the change; the
 * blank picks a people column (its fallback blank goes away) or back to the person, with a fallback column.
 */
const api = (path: string) => `/api/v1${path}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test('whose timer: default, pick a people column, back to the person with a fallback', async ({ page }) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: Json[] }).data[0]!;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Timer ${tag}`, workspace_id: ws.id } })
  ).json()) as Json;
  try {
    const col = async (title: string, type: string) =>
      (await (
        await page.request.post(api(`/boards/${board.id}/columns`), { headers, data: { title, type } })
      ).json()) as Json;
    const status = await col('סטטוס', 'status');
    const people = await col(`אחראי ${tag}`, 'people');
    const time = await col('זמן', 'time_tracking');
    const created = (await (
      await page.request.post(api(`/boards/${board.id}/automations`), {
        headers,
        data: {
          title: `timer ${tag}`,
          recipe: {
            trigger: { type: 'status_changed', column: status.id, labels: 'any' },
            actions: [{ type: 'start_time_tracking', column: time.id }],
          },
        },
      })
    ).json()) as Json;
    expect(created.recipe.actions[0].who).toBe('@actor');

    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('board-automations').click();
    const row = page.locator(`[data-testid="automation-row"][data-title="timer ${tag}"]`);
    await row.getByTestId('automation-edit').click();
    const builder = page.getByTestId('automation-builder');
    await expect(builder.locator('[data-slot="actions.0.fallback"]')).toBeVisible();

    await builder.locator('[data-slot="actions.0.who"]').click();
    const picker = page.getByTestId('slot-timer-who');
    await expect(picker).toBeVisible();
    await picker
      .getByTestId('slot-option')
      .filter({ hasText: `אחראי ${tag}` })
      .click();
    await expect(builder.locator('[data-slot="actions.0.fallback"]')).toHaveCount(0);
    await expect(builder.locator('[data-slot="actions.0.who"]')).toContainText(`אחראי ${tag}`);

    await builder.locator('[data-slot="actions.0.who"]').click();
    await page.getByTestId('slot-timer-who').getByTestId('slot-option').first().click(); // whoever made the change
    await builder.locator('[data-slot="actions.0.fallback"]').click();
    await page
      .getByTestId('slot-timer-fallback')
      .getByTestId('slot-option')
      .filter({ hasText: `אחראי ${tag}` })
      .click();
    await page.getByTestId('auto-save').click(); // in the dialog's footer, outside the builder's body
    await expect(builder).toHaveCount(0);

    const saved = (await (await page.request.get(api(`/automations/${created.id}`), { headers })).json()) as Json;
    expect(saved.recipe.actions[0]).toMatchObject({ who: '@actor', fallback: `column:${people.id}` });
  } finally {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
  }
});
