// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * (automations on external flows; a flow notification opens the flow here) and (operate /
 * edit flows with the AI). No real platform answers: the connection points at an invalid address and the flows /
 * runs calls are answered by `page.route` — the API tests (apps/api/test/flows2.test.ts) cover the platform side.
 */
const api = (path: string) => `/api/v1${path}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const FLOW = {
  id: 'w1',
  name: 'Leads → SMS',
  active: true,
  status: 'error',
  updated_at: null,
  last_run_at: new Date().toISOString(),
  last_run_status: 'error',
  errors_7d: 1,
  open_url: 'https://n8n.e2e.invalid/workflow/w1',
  tags: [],
};
const RUN = {
  id: '104',
  flow_id: 'w1',
  flow_name: 'Leads → SMS',
  status: 'error',
  started_at: new Date().toISOString(),
  finished_at: new Date().toISOString(),
  duration_ms: 900,
  error: 'SMS provider said 401',
  error_node: 'HTTP Request',
  mode: 'trigger',
  can_retry: true,
  open_url: null,
};

test('flows2: AI switches, deep link to a run, ask the assistant, a flow trigger in the builder', async ({ page }) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const conn = (await (
    await page.request.post(api('/flow-connections'), {
      headers,
      data: {
        name: `n8n flows2 ${tag}`,
        target: { platform: 'n8n', base_url: 'https://n8n.e2e.invalid', api_key: 'e2e-key-0000-wxyz' },
      },
    })
  ).json()) as Json;
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: Json[] }).data[0]!;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Flows2 ${tag}`, workspace_id: ws.id } })
  ).json()) as Json;
  try {
    // The platform, faked for this connection.
    await page.route(`**/api/v1/flow-connections/${conn.id}/flows`, (r) => r.fulfill({ json: { data: [FLOW] } }));
    await page.route(`**/api/v1/flow-connections/${conn.id}/runs?**`, (r) => r.fulfill({ json: { data: [RUN] } }));

    // 1. The connection's AI switches (operate / edit) are settings in the dialog.
    await page.goto('/a/demo/admin/flows');
    const card = page.locator(`[data-testid="flow-connection"][data-name="n8n flows2 ${tag}"]`);
    await card.getByTestId('flow-connection-edit').click();
    await expect(page.getByTestId('flow-setting-ai-operate')).toBeVisible();
    await expect(page.getByTestId('flow-setting-ai-edit')).toBeVisible();
    await page.getByTestId('flow-setting-ai-edit').click();
    await page.getByTestId('flow-connection-save').click();
    await expect(page.getByTestId('flow-connection-dialog')).toHaveCount(0);
    const saved = (await (await page.request.get(api('/flow-connections'), { headers })).json()) as { data: Json[] };
    expect(saved.data.find((c) => c.id === conn.id)!.settings).toMatchObject({ ai_operate: true, ai_edit: false });

    // 2. A flow notification's link: the connection, the flow's runs, the run marked.
    await page.goto(`/a/demo/flows?connection=${conn.id}&flow=w1&run=104`);
    const runs = page.getByTestId('flow-runs-dialog');
    await expect(runs).toBeVisible();
    await expect(runs.locator('[data-testid="flow-run"][data-run-id="104"]')).toHaveAttribute('data-marked', 'true');
    await expect(runs.getByTestId('flow-run-error')).toContainText('SMS provider said 401');

    // 3. "Ask the assistant" on the failed run: the panel opens with the flow and the run in its box.
    await runs.getByTestId('flow-ask-assistant').click();
    const panel = page.getByTestId('assistant-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('assistant-context')).toContainText('Leads → SMS');
    const unavailable = panel.getByTestId('assistant-unavailable');
    // Either the box (an AI connection is set) or the "no connection" note — wait for one before choosing.
    await expect(panel.getByTestId('assistant-input').or(unavailable)).toBeVisible();
    if (!(await unavailable.isVisible())) {
      await expect(panel.getByTestId('assistant-input')).toHaveValue(
        new RegExp(`${conn.id}[\\s\\S]*w1[\\s\\S]*104|104[\\s\\S]*${conn.id}`),
      );
    }
    await panel.getByTestId('assistant-close').click();

    // The same from the flows table row.
    await page.goto(`/a/demo/flows?connection=${conn.id}`);
    await page.locator('[data-testid="flow-row"][data-flow-id="w1"]').getByTestId('flow-ask-assistant').click();
    await expect(page.getByTestId('assistant-panel')).toBeVisible();
    await page.getByTestId('assistant-close').click();

    // 4. The builder: "an external flow failed" → its connection blank lists the account's connections.
    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('board-automations').click();
    await page.getByTestId('auto-tab-create').click();
    await page.locator('[data-testid="automation-template"]').first().click();
    const builder = page.getByTestId('automation-builder');
    await builder.getByTestId('auto-trigger-type').click();
    await page.getByTestId('auto-trigger-flow_failed').click();
    await builder.locator('[data-slot="trigger.connection"]').click();
    const list = page.getByTestId('slot-flow-connection');
    await expect(list).toBeVisible();
    await list.locator(`[data-testid="slot-option"][data-value="${conn.id}"]`).click();
    await builder.locator('[data-slot="trigger.flow"]').click();
    await page.getByTestId('slot-flow-flow').locator('[data-testid="slot-option"][data-value="w1"]').click();
    await expect(builder.locator('[data-slot="trigger.flow"]')).toContainText('Leads → SMS');
    await page.getByRole('button', { name: 'סגירת החלון' }).last().click();

    // Saved through the API with {flow.*} texts: the account's automations list it.
    const auto = await page.request.post(api(`/boards/${board.id}/automations`), {
      headers,
      data: {
        is_active: false,
        recipe: {
          trigger: { type: 'flow_failed', connection: conn.id, flow: 'w1' },
          actions: [{ type: 'create_item', board: '@self', name: '{flow.name}: {flow.error}' }],
        },
      },
    });
    expect(auto.status()).toBe(201);
  } finally {
    await page.request.delete(api(`/flow-connections/${conn.id}`), { headers });
    await page.request.delete(api(`/boards/${board.id}`), { headers });
  }
});
