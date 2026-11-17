// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * AI columns (מ11) and the AI assistant panel (מ12) — the planning notes "AGENTS-MCP".
 *
 * Needs the API started with `AI_FAKE=scripted` (playwright.config sets it): the scripted model answers an
 * `ANSWER <text>` found in the data (an AI cell's value) and plays `TOOL <name> <json>` lines of a chat message as
 * tool calls — no key, no spend.
 */
const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;

const setup = async (page: Page, headers: Headers, tag: string) => {
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as Record<string, unknown>;
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E ai2 ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `AI e2e ${tag}`, workspace_id: ws } })
  ).json()) as { id: string };
  const cleanup = async () => {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { enabled: original.enabled, assistant: original.assistant },
    });
  };
  return { connection, board, cleanup };
};

test('AI column: fill a cell, see the AI mark, undo; run from the batch bar', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const { connection, board, cleanup } = await setup(page, headers, tag);
  try {
    const col = (await (
      await page.request.post(api(`/boards/${board.id}/columns`), {
        headers,
        data: { title: 'סיכום AI', type: 'ai', settings: { kind: 'summarize', connection_id: connection.id } },
      })
    ).json()) as { id: string };
    const one = `Lead ANSWER summary-${tag}`;
    const two = `Other ANSWER second-${tag}`;
    for (const name of [one, two])
      await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name } });

    await page.goto(`/a/demo/b/${board.id}`);
    const row = page.locator(`[data-testid="item-row"][data-item-name="${one}"]`);
    await expect(row).toBeVisible();
    const cell = row.getByTestId('ai-cell');
    await expect(cell).toHaveAttribute('data-ai', 'empty');

    // Run one cell from its button.
    await cell.getByTestId('ai-cell-run').click();
    await expect(cell).toHaveAttribute('data-ai', 'generated');
    await expect(cell).toContainText(`summary-${tag}`);
    await expect(cell.getByTestId('ai-cell-mark')).toBeVisible();

    // The toast undoes the run.
    await page.getByTestId('toast-action').first().click();
    await expect(cell).toHaveAttribute('data-ai', 'empty');

    // The batch bar: select both rows → AI → the column.
    for (const name of [one, two])
      await page.locator(`[data-testid="item-row"][data-item-name="${name}"]`).getByTestId('row-select').click();
    await page.getByTestId('batch-ai').click();
    await page.getByTestId('batch-ai-column').click();
    await expect(cell).toContainText(`summary-${tag}`);
    await expect(
      page.locator(`[data-testid="item-row"][data-item-name="${two}"]`).getByTestId('ai-cell'),
    ).toContainText(`second-${tag}`);

    // The column settings: what it does, its connection, "run on the empty cells".
    await page.keyboard.press('Escape');
    await page.locator(`[data-header="${col.id}"]`).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /הגדרות|settings/i }).click();
    await expect(page.getByTestId('ai-column-form')).toBeVisible();
    await expect(page.getByTestId('ai-connection')).toContainText(`E2E ai2 ${tag}`);
    await page.getByTestId('ai-kind-classify').click();
    await page.getByTestId('ai-labels').fill('Hot\nCold');
    await page.getByTestId('column-settings-save').click();
    await expect(page.getByTestId('ai-column-form')).toHaveCount(0);
    await page.screenshot({ path: 'e2e/screens/ai2-column.png' });
  } finally {
    await cleanup();
  }
});

test('assistant panel: read, propose, approve, undo; off state links to the settings', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const { connection, board, cleanup } = await setup(page, headers, tag);
  try {
    const settings = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as {
      assistant: Record<string, unknown>;
    };
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { assistant: { ...settings.assistant, enabled: true, connection_id: connection.id } },
    });
    await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: `Existing ${tag}` } });

    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('board-assistant').click();
    const panel = page.getByTestId('assistant-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('assistant-suggestion').first()).toBeVisible();

    // A read: the scripted model reads the board, then answers.
    await panel.getByTestId('assistant-input').fill(`what is here?\nTOOL get_board {"board_id":"${board.id}"}`);
    await panel.getByTestId('assistant-send').click();
    const answer = panel.locator('[data-testid="assistant-message"][data-role="assistant"]').last();
    await expect(answer.getByTestId('assistant-reads')).toBeVisible();
    await expect(answer.getByTestId('assistant-text')).toBeVisible();

    // A write: proposed, nothing changes until approved.
    const name = `From assistant ${tag}`;
    await panel
      .getByTestId('assistant-input')
      .fill(`create a task\nTOOL create_item {"board_id":"${board.id}","name":"${name}"}`);
    await panel.getByTestId('assistant-input').press('Enter');
    const action = panel.locator('[data-testid="assistant-action"][data-tool="create_item"]').last();
    await expect(action).toHaveAttribute('data-status', 'pending');
    // The card names the change in the UI language and shows its input once (no English title prefix).
    await expect(action).toContainText('יצירת פריט');
    await expect(action.getByTestId('assistant-action-preview')).not.toContainText('Create item');
    const row = page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
    await expect(row).toHaveCount(0);
    await action.getByTestId('assistant-approve').click();
    await expect(action).toHaveAttribute('data-status', 'done');
    await expect(row).toBeVisible();

    // One undo takes the approved actions back.
    await panel.getByTestId('assistant-undo').last().click();
    await expect(row).toHaveCount(0);

    // History: the conversation is kept; a new one starts empty.
    await panel.getByTestId('assistant-history').click();
    await expect(panel.getByTestId('assistant-conversation')).toHaveCount(1);
    await panel.getByTestId('assistant-new').click();
    await expect(panel.getByTestId('assistant-suggestion').first()).toBeVisible();
    await page.screenshot({ path: 'e2e/screens/ai2-assistant.png' });
    await panel.getByTestId('assistant-close').click();

    // Off: the panel says so, with a link to the AI settings for an admin.
    await page.request.patch(api('/ai/settings'), { headers, data: { enabled: false } });
    await page.reload();
    await page.getByTestId('board-assistant').click();
    await expect(page.getByTestId('assistant-unavailable')).toHaveAttribute('data-reason', 'ai_disabled');
    await page.getByTestId('assistant-settings-link').click();
    await expect(page).toHaveURL(/\/admin\/ai$/);
    // The AI page's settings load after its panels (first visit in a long run: slower than the default 5s).
    await expect(page.getByTestId('ai-assistant-settings')).toBeVisible({ timeout: 15_000 });
  } finally {
    await cleanup();
  }
});
