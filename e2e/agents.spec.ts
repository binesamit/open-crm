// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Agents (the planning notes "AGENTS-MCP" מ6–מ7): build an agent in the UI (profile, connection, tools, a board), run it
 * against the mocked model, approve its write from the run, and undo the whole run.
 *
 * Needs the API started with `AI_FAKE=scripted` (test-only; playwright.config sets it when it starts the API):
 * the scripted model plays the `TOOL <name> <json>` lines of the prompt — no key, no spend.
 */
test('build an agent, run it, approve its write, undo the run', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const api = (path: string) => `/api/v1${path}`;

  // Setup through the API: AI on, a connection, a board with one item.
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as { enabled: boolean };
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E agents ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Agents e2e ${tag}`, workspace_id: ws } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: `Lead ${tag}` } })
  ).json()) as { id: string };
  const itemName = async () =>
    ((await (await page.request.get(api(`/items/${item.id}`), { headers })).json()) as { name: string }).name;
  let agentId: string | null = null;

  try {
    // 1. Create the agent in the UI.
    await page.goto('/a/demo/agents');
    await expect(page.getByTestId('agents-page')).toBeVisible();
    await page.getByTestId('agent-new').click();
    await expect(page.getByTestId('agent-editor')).toBeVisible();
    await page.getByTestId('agent-name').fill(`סוכן בדיקה ${tag}`);
    await page.getByTestId('agent-role').fill('משנה שמות של לידים');
    await page.getByTestId('agent-instructions').fill('שנה רק את מה שהמשימה מבקשת.');

    await page.getByTestId('agent-tab-model').click();
    await page.getByTestId('agent-connection').click();
    await page.getByRole('menu').getByText(`E2E agents ${tag}`).click();

    await page.getByTestId('agent-tab-tools').click();
    await page.getByTestId('agent-tool-update_item').click();
    await expect(page.getByTestId('agent-tool-update_item')).toBeChecked();

    await page.getByTestId('agent-tab-boards').click();
    await page.getByTestId('agent-board-add').click();
    await page.mouse.move(1, 1);
    await page.getByRole('menu').getByText(`Agents e2e ${tag}`, { exact: false }).click();
    const boardRow = page.locator(`[data-testid="agent-board"][data-board="${board.id}"]`);
    await boardRow.getByTestId('agent-board-edit').click();

    // Learner mode is the default for a new agent: every write waits for a person.
    await page.getByTestId('agent-tab-limits').click();
    await expect(page.getByTestId('agent-mode-learner').locator('input')).toBeChecked();

    await page.getByTestId('agent-save').click();
    await expect(page).toHaveURL(/\/agents\/[0-9A-Z]{26}$/);
    agentId = page.url().split('/').at(-1)!;

    // 2. Run it now: the scripted model renames the item → the write waits for approval.
    await page.getByTestId('agent-tab-run').click();
    await page
      .getByTestId('agent-run-prompt')
      .fill(`שנה את השם\nTOOL update_item {"item_id":"${item.id}","name":"Renamed by agent ${tag}"}`);
    await page.getByTestId('agent-run-start').click();
    const view = page.getByTestId('run-view');
    await expect(view.getByTestId('run-status')).toHaveAttribute('data-status', 'waiting_approval');
    expect(await itemName()).toBe(`Lead ${tag}`);

    // 3. Approve from the run: the run resumes and the item changes.
    await view.getByTestId('approval-approve').click();
    await expect(view.getByTestId('run-status')).toHaveAttribute('data-status', 'succeeded', { timeout: 20_000 });
    await expect.poll(itemName).toBe(`Renamed by agent ${tag}`);
    await expect(view.locator('[data-testid="run-step"][data-kind="tool"][data-tool="update_item"]')).toHaveAttribute(
      'data-outcome',
      'ran',
    );

    // 4. Undo the whole run.
    await view.getByTestId('run-undo').click();
    await page.getByRole('alertdialog').getByRole('button').last().click();
    await expect.poll(itemName).toBe(`Lead ${tag}`);
    await expect(view.getByTestId('run-undo')).toHaveCount(0);

    // The runs list shows the run.
    await page.getByTestId('agent-tab-runs').click();
    await expect(page.getByTestId('run-row').first()).toHaveAttribute('data-status', 'succeeded');
    await page.screenshot({ path: 'e2e/screens/agents-run.png' });
  } finally {
    if (agentId) await page.request.delete(api(`/agents/${agentId}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.delete(api(`/boards/${board.id}`), { headers });
    await page.request.patch(api('/ai/settings'), { headers, data: { enabled: original.enabled } });
  }
});
