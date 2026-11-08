// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod — "@" in the AI chat: typing "@" and letters lists items / boards (quick search's results), Enter
 * picks one, "@name" goes into the text and a chip shows the reference; Esc closes the list only; the sent message
 * links to what it pointed at, and the server keeps the references on the message.
 *
 * Needs the API with `AI_FAKE=scripted` (playwright.config sets it).
 */
const api = (path: string) => `/api/v1${path}`;

test('the AI chat points at an item and a board with "@"', async ({ page }) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as Record<string, unknown>;
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E refs ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
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
    await page.request.post(api('/boards'), { headers, data: { name: `Refboard${tag}`, workspace_id: ws } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: `Refitem${tag}` } })
  ).json()) as { id: string };
  try {
    await page.goto('/a/demo');
    await page.getByTestId('assistant-open').first().click();
    const panel = page.getByTestId('assistant-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('assistant-new').click();
    const box = panel.getByTestId('assistant-input');
    await box.click();

    // 1. "@" + letters: the item is suggested; Esc closes the list but not the panel.
    await page.keyboard.type(`How is @Refitem${tag}`);
    const option = panel.locator('[data-testid="assistant-ref-option"][data-type="item"]').first();
    await expect(option).toContainText(`Refitem${tag}`);
    await page.keyboard.press('Escape');
    await expect(panel.getByTestId('assistant-ref-list')).toHaveCount(0);
    await expect(panel).toBeVisible();
    // Typing on brings it back; Enter picks the highlighted (first) suggestion.
    await page.keyboard.press('Backspace');
    await expect(option).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(box).toHaveValue(new RegExp(`How is @Refitem${tag} $`));
    await expect(panel.locator('[data-testid="assistant-ref"][data-type="item"]')).toContainText(`Refitem${tag}`);

    // 2. A board, picked with the mouse.
    await page.keyboard.type(`and @Refboard${tag.slice(0, 3)}`);
    await panel.locator('[data-testid="assistant-ref-option"][data-type="board"]').first().click();
    await expect(panel.getByTestId('assistant-ref')).toHaveCount(2);

    // 3. Send: the message links to both; the server keeps them.
    await panel.getByTestId('assistant-send').click();
    const mine = panel.locator('[data-testid="assistant-message"][data-role="user"]').last();
    await expect(mine.getByTestId('assistant-message-ref')).toHaveCount(2);
    await expect(panel.getByTestId('assistant-ref')).toHaveCount(0);
    await expect(panel.locator('[data-testid="assistant-message"][data-role="assistant"]').last()).toBeVisible();
    const list = (await (await page.request.get(api('/ai/assistant/conversations'), { headers })).json()) as {
      data: { id: string; title: string }[];
    };
    const conv = list.data.find((c) => c.title.includes(tag))!;
    const got = (await (await page.request.get(api(`/ai/assistant/conversations/${conv.id}`), { headers })).json()) as {
      messages: { role: string; refs: { type: string; id: string }[] }[];
    };
    expect(got.messages.find((m) => m.role === 'user')!.refs).toEqual([
      expect.objectContaining({ type: 'item', id: item.id }),
      expect.objectContaining({ type: 'board', id: board.id }),
    ]);
    // The item's link opens its card on its board.
    await mine.getByTestId('assistant-message-ref').first().click();
    await expect(page).toHaveURL(new RegExp(`/b/${board.id}/i/${item.id}`));
  } finally {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { enabled: original.enabled, assistant: original.assistant },
    });
  }
});
