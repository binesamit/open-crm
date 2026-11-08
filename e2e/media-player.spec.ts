// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * audio and video stored in the account's storage play inside the app — right in the update, and in the
 * file viewer — with our own controls. A recording uploaded without a type plays too (its extension says what it is).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

/** One second of silence: 8 kHz, 8-bit mono WAV. */
const silentWav = () => {
  const n = 8000;
  const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(8000, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  b.fill(128, 44);
  return b.toString('base64');
};

test('an audio file in an update plays in place, with speed; the viewer plays it too', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const tag = uid();
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `נגן ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: `פריט ${tag}` } });
  await page.goto(`/a/demo/b/${board.id}`);
  const r = page.locator(`[data-testid="item-row"][data-item-name="פריט ${tag}"]`);
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: `פריט ${tag}` });

  // A recording pasted without a type (as some phones and Windows send it).
  const box = card.getByLabel(/כתבו עדכון/);
  await box.click();
  await box.pressSequentially('הקלטה');
  await box.evaluate((el, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'voice.wav', { type: '' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, silentWav());
  await expect(card.getByTestId('composer-file-remove')).toHaveCount(1);
  await card.getByRole('button', { name: 'עדכון', exact: true }).click();

  const entry = card.locator('[data-testid="update-entry"]', { hasText: 'הקלטה' }).first();
  const media = entry.getByTestId('update-media');
  await expect(media).toHaveAttribute('data-kind', 'audio');
  const player = media.getByTestId('media-player');
  await expect(player).toBeVisible();
  await expect(player.getByTestId('media-duration')).toHaveText('0:01', { timeout: 10_000 });

  // Speed: chosen from our menu, shown on the button.
  await player.getByTestId('media-speed').click();
  await page.getByTestId('media-speed-1.5').click();
  await expect(player.getByTestId('media-speed')).toHaveText('×1.5');

  // Play: it plays to the end (one second) and stops.
  await player.getByTestId('media-play').click();
  await expect(player).toHaveAttribute('data-state', 'paused', { timeout: 10_000 });

  // The name opens the file viewer, which plays it with the same player.
  await media.getByTestId('update-file').click();
  await expect(page.getByTestId('file-viewer').getByTestId('media-player')).toBeVisible();
});
