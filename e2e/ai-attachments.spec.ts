// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod — files in the AI chat: a pasted screenshot and a chosen file upload at once and show as chips (one
 * can be taken off), the sent message shows its image and file, and the server keeps them with the message. And
 * Ctrl+B opens quick search on a Hebrew keyboard layout too (`e.key` is "נ" there), above an open AI panel.
 *
 * Needs the API with `AI_FAKE=scripted` (playwright.config sets it).
 */
const api = (path: string) => `/api/v1${path}`;

/** A tiny PNG (its signature is what the server checks). */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 1, 2]);

test('the AI chat takes pasted and chosen files; Ctrl+B works on a Hebrew layout', async ({ page }) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as Record<string, unknown>;
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E files ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  await page.request.patch(api('/ai/settings'), {
    headers,
    data: {
      enabled: true,
      assistant: { enabled: true, connection_id: connection.id, model: 'claude-sonnet-5-5', roles: ['member'] },
    },
  });
  try {
    await page.goto('/a/demo');
    await page.getByTestId('assistant-open').first().click();
    const panel = page.getByTestId('assistant-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('assistant-new').click();
    const box = panel.getByTestId('assistant-input');

    // 1. A pasted screenshot (a file on the clipboard, no text) becomes a chip with its preview.
    await box.evaluate(
      (el, bytes) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(bytes)], 'screenshot.png', { type: 'image/png' }));
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      },
      [...PNG],
    );
    await expect(panel.getByTestId('assistant-attachment')).toHaveCount(1);
    await expect(panel.locator('[data-testid="assistant-attachment"] img')).toBeVisible();

    // 2. Chosen files: two more; one is taken off again before sending.
    await panel.getByTestId('assistant-file-input').setInputFiles([
      { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from(`Budget ${tag}`) },
      { name: 'extra.txt', mimeType: 'text/plain', buffer: Buffer.from('remove me') },
    ]);
    await expect(panel.getByTestId('assistant-attachment')).toHaveCount(3);
    await panel
      .locator('[data-testid="assistant-attachment"][data-name="extra.txt"]')
      .getByTestId('assistant-attachment-remove')
      .click();
    await expect(panel.getByTestId('assistant-attachment')).toHaveCount(2);

    // 3. Send: the bubble shows the image and the file; the chips are gone; the server kept both on the message.
    await box.fill(`What is in these? ${tag}`);
    await panel.getByTestId('assistant-send').click();
    const mine = panel.locator('[data-testid="assistant-message"][data-role="user"]').last();
    await expect(mine.getByTestId('assistant-message-image')).toBeVisible();
    await expect(mine.getByTestId('assistant-message-file')).toContainText('notes.txt');
    await expect(panel.getByTestId('assistant-attachment')).toHaveCount(0);
    await expect(panel.locator('[data-testid="assistant-message"][data-role="assistant"]').last()).toBeVisible();
    const list = (await (await page.request.get(api('/ai/assistant/conversations'), { headers })).json()) as {
      data: { id: string; title: string }[];
    };
    const conv = list.data.find((c) => c.title.includes(tag))!;
    const got = (await (await page.request.get(api(`/ai/assistant/conversations/${conv.id}`), { headers })).json()) as {
      messages: { role: string; files: { name: string }[] }[];
    };
    expect(
      got.messages
        .find((m) => m.role === 'user')!
        .files.map((f) => f.name)
        .sort(),
    ).toEqual(['notes.txt', 'screenshot.png']);

    // 4. Ctrl+B with a Hebrew layout ("נ" on the B key) opens quick search, above the open panel.
    await page.keyboard.press('Escape');
    await page.getByTestId('assistant-open').first().click();
    await expect(panel).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'נ', code: 'KeyB', ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    await expect(page.getByTestId('search-input')).toBeVisible();
    // Above the panel: the search field takes a click where the panel is not.
    await page.getByTestId('search-input').click();
    await expect(page.getByTestId('search-input')).toBeFocused();
  } finally {
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { enabled: original.enabled, assistant: original.assistant },
    });
  }
});
