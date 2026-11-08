// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * f9-updedit: editing an update offers what composing one does — 📎 attach, drop / paste images
 * (shown inline), and taking attached files off — under the same conditions. Cancel leaves the update as it was;
 * save detaches the removed files, attaches the new ones and marks the update "נערך".
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** A file pasted into this editor (a screenshot from the clipboard). */
const paste = (editor: Locator, name: string, type: string, b64: string) =>
  editor.evaluate(
    (el, f) => {
      const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], f.name, { type: f.type }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { name, type, b64 },
  );

test('editing an update: paste an image, attach a file, remove an attached one; cancel keeps it as it was', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const tag = uid();
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `עריכת עדכון ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: `פריט ${tag}` } });
  await page.goto(`/a/demo/b/${board.id}`);
  const r = page.locator(`[data-testid="item-row"][data-item-name="פריט ${tag}"]`);
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: `פריט ${tag}` });
  await expect(card).toBeVisible();

  // An update with one file.
  const box = card.getByLabel(/כתבו עדכון/);
  await box.click();
  await box.pressSequentially('עדכון לעריכה');
  await paste(box, 'old.txt', 'text/plain', Buffer.from('old').toString('base64'));
  await expect(card.getByTestId('composer-file-remove')).toHaveCount(1);
  await card.getByRole('button', { name: 'עדכון', exact: true }).click();
  const entry = card.locator('[data-testid="update-entry"]', { hasText: 'עדכון לעריכה' }).first();
  await expect(entry.locator('[data-testid="update-attachment"][data-name="old.txt"]')).toBeVisible();

  const openEdit = async () => {
    await entry.getByRole('button', { name: 'פעולות לעדכון' }).click();
    await page.getByRole('menuitem', { name: 'עריכה' }).click();
    const editor = entry.locator('.ProseMirror').first();
    await expect(editor).toBeVisible();
    return editor;
  };

  // Edit 1 — cancelled: the attached file shows in the editor, is taken off, an image is pasted; cancel undoes all.
  let editor = await openEdit();
  await expect(entry.locator('[data-testid="composer-file"][data-existing="true"][data-name="old.txt"]')).toBeVisible();
  await expect(entry.getByTestId('composer-attach')).toBeVisible();
  await entry.getByRole('button', { name: 'הסרת הקובץ: old.txt' }).click();
  await paste(editor, 'shot.png', 'image/png', PNG_1PX);
  await expect(entry.getByTestId('composer-image')).toBeVisible();
  const discarded = page.waitForResponse(
    (res) => res.request().method() === 'DELETE' && /\/api\/v1\/files\/[\w]+$/.test(res.url()),
  );
  await entry.getByTestId('composer-cancel').click();
  expect((await discarded).status()).toBe(200); // the unsent upload leaves storage
  await expect(entry.locator('[data-testid="update-attachment"][data-name="old.txt"]')).toBeVisible();
  await expect(entry.getByTestId('update-image')).toHaveCount(0);

  // Edit 2 — saved: remove old.txt, paste an image, attach a file with 📎, change the text.
  editor = await openEdit();
  await entry.getByRole('button', { name: 'הסרת הקובץ: old.txt' }).click();
  await paste(editor, 'shot.png', 'image/png', PNG_1PX);
  await expect(entry.getByTestId('composer-image')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await entry.getByTestId('composer-attach').click();
  await (await chooser).setFiles({ name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('new') });
  await expect(entry.locator('[data-testid="composer-file"][data-name="new.txt"]')).toBeVisible();
  // On the text, not the middle of the editor: the pasted image sits there now, and typing over a
  // selected image would take it out — and with it off the update.
  await editor.getByText('עדכון לעריכה').click();
  await editor.press('End');
  await editor.pressSequentially(' אחרי');
  const saved = page.waitForResponse(
    (res) => res.request().method() === 'PATCH' && /\/api\/v1\/updates\/[\w]+$/.test(res.url()),
  );
  await entry.getByTestId('composer-send').click();
  const body = (await (await saved).json()) as { files: { name: string }[]; edited_at: string | null };
  expect(body.files.map((f) => f.name).sort()).toEqual(['new.txt', 'shot.png']);
  expect(body.edited_at).not.toBeNull();

  await expect(entry).toContainText('עדכון לעריכה אחרי');
  await expect(entry).toContainText('נערך');
  await expect(entry.getByTestId('update-image')).toBeVisible();
  await expect(entry.locator('[data-testid="update-attachment"][data-name="new.txt"]')).toBeVisible();
  await expect(entry.locator('[data-testid="update-attachment"][data-name="old.txt"]')).toHaveCount(0);
});

test("the API refuses attaching someone else's or an unknown file on edit", async ({ page }) => {
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `עריכה API ${uid()}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'x' } })
  ).json()) as { id: string };
  const u = (await (
    await page.request.post(`/api/v1/items/${item.id}/updates`, { headers, data: { body: 'hi' } })
  ).json()) as { id: string };
  const res = await page.request.patch(`/api/v1/updates/${u.id}`, {
    headers,
    data: { file_ids: ['01NOTAFILE0000000000000000'] },
  });
  expect(res.status()).toBe(422);
});
