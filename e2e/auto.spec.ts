// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Product decisions: subitem columns in automations and account automation templates.
 * Boards are made through the API; the builder, the template library and the install flow through the UI.
 */
const api = (path: string) => `/api/v1${path}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test('a subitem trigger picks the sub-board’s columns; save as template; install on another board', async ({
  page,
}) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: Json[] }).data[0]!;
  const mkBoard = async (name: string) =>
    (await (await page.request.post(api('/boards'), { headers, data: { name, workspace_id: ws.id } })).json()) as Json;
  const source = await mkBoard(`Auto src ${tag}`);
  const target = await mkBoard(`Auto dst ${tag}`);
  const boardIds = [source.id, target.id];
  try {
    for (const b of boardIds)
      await page.request.post(api(`/boards/${b}/columns`), { headers, data: { title: 'הערות', type: 'text' } });
    const parent = (await (
      await page.request.post(api(`/boards/${source.id}/items`), { headers, data: { name: 'אב' } })
    ).json()) as Json;
    const sub = (await (
      await page.request.post(api(`/items/${parent.id}/subitems`), { headers, data: { name: 'בן' } })
    ).json()) as Json;
    await page.request.post(api(`/boards/${sub.board_id}/columns`), {
      headers,
      data: { title: `פירוט ${tag}`, type: 'text' },
    });

    // The builder: "when a subitem's column changes" lists the sub-board's columns.
    await page.goto(`/a/demo/b/${source.id}`);
    await page.getByTestId('board-automations').click();
    await page.getByTestId('auto-tab-create').click();
    await page.locator('[data-testid="automation-template"]').first().click();
    const builder = page.getByTestId('automation-builder');
    await builder.getByTestId('auto-trigger-type').click();
    await page
      .getByRole('menuitemradio', { name: /כשעמודה של תת-פריט|auto\.kind\.subitem_column_changed/ })
      .first()
      .click();
    await builder.locator('[data-slot="trigger.column"]').click();
    await expect(page.getByTestId('slot-option').filter({ hasText: `פירוט ${tag}` })).toBeVisible();
    await page
      .getByTestId('slot-option')
      .filter({ hasText: `פירוט ${tag}` })
      .click();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'סגירת החלון' }).last().click();

    // An automation (through the API), saved as a template from the account's center.
    const auto = (await (
      await page.request.post(api(`/boards/${source.id}/automations`), {
        headers,
        data: {
          title: `תבנית ${tag}`,
          is_active: false,
          recipe: { trigger: { type: 'item_created' }, actions: [{ type: 'set_column', column: 'text', value: 'x' }] },
        },
      })
    ).json()) as Json;
    // The race (s4f-e2e): the row's ⋯ offers "save as template" only once the template library has loaded (its
    // `can_manage`) — a menu opened before that has no such item, and it appears (shifting the rest) while open.
    // So: wait for the library first.
    const library = page.waitForResponse(
      (r) => r.request().method() === 'GET' && new URL(r.url()).pathname === '/api/v1/automation-templates',
    );
    await page.goto('/a/demo/automations');
    expect((await library).ok()).toBe(true);
    const templates = page.getByTestId('automation-templates');
    await expect(templates.getByTestId('tpl-row').or(templates.getByTestId('tpl-empty')).first()).toBeVisible();
    const row = page.locator('[data-testid="autoall-row"]', { hasText: `תבנית ${tag}` });
    await row.getByTestId('auto-row-menu').click();
    await page.getByTestId('auto-save-template').click();
    const saved = page.waitForResponse(
      (r) => r.request().method() === 'POST' && r.url().endsWith(`/automations/${auto.id}/save-as-template`),
    );
    await page.getByTestId('tpl-save-confirm').click();
    expect((await saved).ok()).toBe(true);
    const tpl = page.locator('[data-testid="tpl-row"]', { hasText: `תבנית ${tag}` });
    await expect(tpl).toBeVisible();

    // Install on the other board: the blank is proposed (same type and title), the automation lands there off.
    await tpl.getByTestId('tpl-install').click();
    await page.getByTestId('tpl-install-board').click();
    await page.getByRole('menuitemradio', { name: `Auto dst ${tag}` }).click();
    // Every blank proposed for this board (not the previous answer's) — the button is enabled only then.
    await expect(page.locator('[data-testid="tpl-slot"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="tpl-slot"][data-empty="true"]')).toHaveCount(0);
    await expect(page.getByTestId('tpl-install-confirm')).toBeEnabled();
    const installedRes = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' && r.url().endsWith('/install') && r.url().includes('/automation-templates/'),
    );
    await page.getByTestId('tpl-install-confirm').click();
    expect((await installedRes).ok()).toBe(true);
    await expect(page.getByTestId('tpl-install-dialog')).toBeHidden();
    const installed = (
      (await (await page.request.get(api(`/boards/${target.id}/automations`), { headers })).json()) as {
        data: Json[];
      }
    ).data;
    expect(installed.map((x) => x.title)).toContain(`תבנית ${tag}`);

    // Delete the template (the library's ⋯).
    await tpl.getByTestId('tpl-row-menu').click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'מחיקה' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
    await expect(tpl).toHaveCount(0);
    await page.request.delete(api(`/automations/${auto.id}`), { headers });
  } finally {
    for (const b of boardIds) await page.request.delete(api(`/boards/${b}`), { headers });
  }
});
