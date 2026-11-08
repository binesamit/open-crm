// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod — chat with the agent from anywhere: the shell's ✦ button opens the AI panel on any page, and quick
 * search (Ctrl+B, which stays search) sends what was typed to it with "ask the agent" —
 * about where the person is (here a document, then the home screen); the panel's picker switches to one of the
 * account's agents, whose change waits for approval and then runs.
 *
 * Needs the API with `AI_FAKE=scripted` (playwright.config sets it): `TOOL <name> <json>` lines play as tool calls.
 */
const api = (path: string) => `/api/v1${path}`;

test('the AI panel from anywhere: a document, quick search at home, and a chat with an agent', async ({ page }) => {
  test.setTimeout(240_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as Record<string, unknown>;
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E anywhere ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  await page.request.patch(api('/ai/settings'), {
    headers,
    data: {
      enabled: true,
      assistant: { enabled: true, connection_id: connection.id, model: 'claude-sonnet-5-5', roles: ['member'] },
    },
  });
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Anywhere ${tag}`, workspace_id: ws } })
  ).json()) as { id: string };
  const doc = (await (
    await page.request.post(api(`/workspaces/${ws}/docs`), { headers, data: { name: `Plan ${tag}` } })
  ).json()) as { id: string };
  const agent = (await (
    await page.request.post(api('/agents'), {
      headers,
      data: {
        name: `Sales ${tag}`,
        role: 'Sales',
        connection_id: connection.id,
        model: 'claude-sonnet-5-5',
        tools: ['get_board', 'create_item'],
        boards: [{ board_id: board.id, level: 'edit' }],
        approval_mode: 'autonomous',
      },
    })
  ).json()) as { id: string };
  try {
    // 1. On a document: the ✦ button opens the panel about it.
    await page.goto(`/a/demo/d/${doc.id}`);
    await page.getByTestId('assistant-open').first().click();
    const panel = page.getByTestId('assistant-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('assistant-context')).toContainText('מסמך');
    await panel.getByTestId('assistant-close').click();
    await expect(panel).toHaveCount(0);

    // 2. At home: Ctrl+B is still quick search; its "ask the agent" row opens the panel, the question ready.
    await page.goto('/a/demo');
    // The shortcut is bound once the shell has mounted, so wait for it and press until the palette opens.
    await expect(page.getByTestId('assistant-open').first()).toBeVisible();
    await expect(async () => {
      await page.keyboard.press('Control+b');
      await expect(page.getByTestId('search-input')).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    const question = `what is late ${tag}`;
    await page.getByTestId('search-input').fill(question);
    await page.locator('[data-kind="ai"]').click();
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId('assistant-context')).toContainText('כל החשבון');
    await expect(panel.getByRole('textbox')).toHaveValue(question);

    // 3. Pick the agent and ask it for a change: it waits for approval, then runs.
    await panel.getByTestId('assistant-agent').click();
    await page.getByTestId(`assistant-agent-${agent.id}`).click();
    await expect(panel.getByTestId('assistant-agent')).toContainText(`Sales ${tag}`);
    const box = panel.getByRole('textbox');
    await box.fill(`TOOL create_item {"board_id":"${board.id}","name":"From ${tag}"}`);
    await box.press('Enter');
    const card = panel.getByTestId('assistant-action').first();
    await expect(card).toBeVisible();
    await card.getByTestId('assistant-approve').click();
    await expect
      .poll(async () => {
        const items = (await (await page.request.get(api(`/boards/${board.id}/items`), { headers })).json()) as {
          data: { name: string }[];
        };
        return items.data.map((i) => i.name);
      })
      .toContain(`From ${tag}`);
  } finally {
    await page.request.delete(api(`/agents/${agent.id}`), { headers });
    await page.request.delete(api(`/docs/${doc.id}`), { headers });
    await page.request.delete(api(`/boards/${board.id}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { enabled: original.enabled, assistant: original.assistant },
    });
  }
});
