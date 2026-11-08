// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * The product owner's fix list, AI round (sync-ai):
 * 1. connecting AI is live everywhere — an open assistant panel turns on by itself when an admin picks a connection
 *    (elsewhere: another tab / another admin), no reload;
 * 2. approvals read as sentences with names; the JSON only behind "technical details";
 * 3. Markdown that AI writes shows formatted (headings, lists, tables) in updates.
 *
 * Needs the API with `AI_FAKE=scripted` (playwright.config sets it): `TOOL <name> <json>` lines of a chat message
 * play as tool calls.
 */
const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;

const setup = async (page: Page, headers: Headers, tag: string) => {
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as Record<string, unknown>;
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E sync-ai ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Sync AI ${tag}`, workspace_id: ws } })
  ).json()) as { id: string };
  const status = (await (
    await page.request.post(api(`/boards/${board.id}/columns`), { headers, data: { title: 'Status', type: 'status' } })
  ).json()) as { id: string; settings: { labels: { label: string }[] } };
  const item = (await (
    await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: `Lead ${tag}` } })
  ).json()) as { id: string };
  const cleanup = async () => {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { enabled: original.enabled, assistant: original.assistant, format_markdown: true },
    });
  };
  return { original, connection, board, status, item, cleanup };
};

test('connecting AI turns the open assistant on without a reload', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const { original, connection, board, cleanup } = await setup(page, headers, tag);
  try {
    const assistant = original.assistant as Record<string, unknown>;
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { assistant: { ...assistant, enabled: true, connection_id: null } },
    });
    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('board-assistant').click();
    await expect(page.getByTestId('assistant-unavailable')).toHaveAttribute('data-reason', 'not_configured');

    // Another admin (here: a request outside this tab) picks the connection → the panel opens up by itself.
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { assistant: { ...assistant, enabled: true, connection_id: connection.id } },
    });
    await expect(page.getByTestId('assistant-input')).toBeVisible({ timeout: 10_000 });

    // And removing the connection closes it again.
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await expect(page.getByTestId('assistant-unavailable')).toHaveAttribute('data-reason', 'not_configured', {
      timeout: 10_000,
    });
  } finally {
    await cleanup();
  }
});

test('a proposed change reads as a sentence; JSON only behind technical details; Markdown updates are formatted', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const { original, connection, board, status, item, cleanup } = await setup(page, headers, tag);
  try {
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { assistant: { ...(original.assistant as object), enabled: true, connection_id: connection.id } },
    });
    const label = status.settings.labels[0]!.label;
    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('board-assistant').click();
    const panel = page.getByTestId('assistant-panel');

    // 1. A status change: names, not ids.
    await panel
      .getByTestId('assistant-input')
      .fill(`TOOL update_item {"item_id":"${item.id}","cells":{"${status.id}":"${label}"}}`);
    await panel.getByTestId('assistant-send').click();
    const action = panel.locator('[data-testid="assistant-action"][data-tool="update_item"]').last();
    await expect(action).toHaveAttribute('data-status', 'pending');
    const sentence = action.getByTestId('action-sentence');
    await expect(sentence).toContainText(`Lead ${tag}`);
    await expect(sentence).toContainText(`Sync AI ${tag}`);
    await expect(sentence).toContainText(label);
    await expect(action).not.toContainText(item.id);
    // The JSON only after "technical details".
    await expect(action.getByTestId('action-tech')).toHaveCount(0);
    await action.getByTestId('action-tech-toggle').click();
    await expect(action.getByTestId('action-tech-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(action.getByTestId('action-tech-input')).toContainText(item.id);
    await action.getByTestId('assistant-approve').click();
    await expect(action).toHaveAttribute('data-status', 'done');

    // 2. An update in Markdown: formatted in the item's updates.
    const md = `## Summary ${tag}\\n\\n- **won**\\n- next\\n\\n| a | b |\\n|-|-|\\n| 1 | 2 |`;
    await panel.getByTestId('assistant-input').fill(`TOOL create_update {"item_id":"${item.id}","text":"${md}"}`);
    await panel.getByTestId('assistant-send').click();
    const write = panel.locator('[data-testid="assistant-action"][data-tool="create_update"]').last();
    await expect(write.getByTestId('action-sentence')).toContainText(`Lead ${tag}`);
    await write.getByTestId('assistant-approve').click();
    await expect(write).toHaveAttribute('data-status', 'done');
    await panel.getByTestId('assistant-close').click();

    await page.goto(`/a/demo/b/${board.id}/i/${item.id}?tab=updates`);
    const body = page.locator('.update-body').first();
    await expect(body.locator('h2')).toHaveText(`Summary ${tag}`);
    await expect(body.locator('li strong')).toHaveText('won');
    await expect(body.locator('table th').first()).toHaveText('a');
    await expect(body).not.toContainText('**');
    await page.screenshot({ path: 'e2e/screens/sync-ai-markdown.png' });
  } finally {
    await cleanup();
  }
});

test('Administration → AI: the "format AI text" switch is saved', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  try {
    await page.goto('/a/demo/admin/ai');
    const toggle = page.getByTestId('ai-format-markdown');
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await expect
      .poll(
        async () => ((await (await page.request.get(api('/ai/settings'), { headers })).json()) as Json).format_markdown,
      )
      .toBe(false);
  } finally {
    await page.request.patch(api('/ai/settings'), { headers, data: { format_markdown: true } });
  }
});

type Json = Record<string, unknown>;
