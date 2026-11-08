// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * File versions: in the file viewer's "Versions" tab — upload a new version (it becomes current)
 * view an older one (the bar), make it current again (a new version), delete one (after a confirm); the cell keeps
 * one file throughout. Removing the file from the cell sends it to the trash, and restoring puts it back.
 */
const uid = () => Date.now().toString(36);

/** Upload through the real presign → PUT → complete flow; returns the file id. */
const upload = async (page: Page, headers: Record<string, string>, name: string, text: string) => {
  const bytes = Buffer.from(text, 'utf8');
  const pre = (await (
    await page.request.post('/api/v1/files/presign', {
      headers,
      data: { name, size: bytes.length, mime: 'text/plain' },
    })
  ).json()) as { file_id: string; upload_url: string; headers?: Record<string, string> };
  expect((await page.request.put(pre.upload_url, { headers: pre.headers ?? {}, data: bytes })).ok()).toBe(true);
  expect((await page.request.post(`/api/v1/files/${pre.file_id}/complete`, { headers })).status()).toBe(200);
  return pre.file_id;
};

test('file versions: upload, view an older one, make it current, delete one; remove → trash → restore', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = uid();
  const fileName = `חזית-${tag}.txt`;
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `גרסאות ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  const column = (await (
    await page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data: { title: 'קבצים', type: 'file' } })
  ).json()) as { id: string };
  const itemName = `חזית הבית ${tag}`;
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: itemName } })
  ).json()) as { id: string };
  const first = await upload(page, headers, fileName, 'גרסה ראשונה');
  await page.request.post(`/api/v1/items/${item.id}/cells/${column.id}/files`, {
    headers,
    data: { file_ids: [first] },
  });

  await page.goto(`/a/demo/b/${board.id}`);
  const row = page.locator(`[data-testid="item-row"][data-item-name="${itemName}"]`);
  const openViewer = async () => {
    await row.getByTestId('file-cell').click();
    await page.getByTestId('file-cell-open').filter({ hasText: fileName }).click();
    const viewer = page.getByTestId('file-viewer');
    await expect(viewer).toBeVisible();
    return viewer;
  };

  // 1. The viewer's "Versions" button opens the tab: one version, current.
  let viewer = await openViewer();
  await viewer.getByTestId('file-viewer-versions').click();
  await expect(viewer.getByTestId('versions-tab')).toHaveAttribute('aria-selected', 'true');
  await expect(viewer.getByTestId('version-row-1').getByTestId('version-current')).toHaveText('נוכחית');
  await expect(viewer.getByText('כל הגרסאות נספרות במכסת האחסון של החשבון.')).toBeVisible();

  // 2. Upload a new version: two versions, v2 current, the header says so.
  await viewer.getByTestId('versions-upload-input').setInputFiles({
    name: fileName,
    mimeType: 'text/plain',
    buffer: Buffer.from('גרסה שנייה', 'utf8'),
  });
  await expect(viewer.locator('[data-testid^="version-row-"]')).toHaveCount(2);
  await expect(viewer.getByTestId('version-row-2').getByTestId('version-current')).toBeVisible();
  await expect(viewer.getByTestId('version-row-1').getByTestId('version-current')).toHaveCount(0);
  await expect(viewer.getByTestId('file-viewer-version')).toHaveText('גרסה 2');
  await expect(viewer.getByTestId('file-viewer-versions')).toContainText('2');
  await expect(viewer.getByTestId('file-viewer-text')).toHaveText('גרסה שנייה');

  // 3. View version 1: the bar over the preview, its text in the preview.
  await viewer.getByTestId('version-row-1').locator('button').first().click();
  const bar = viewer.getByTestId('old-version-bar');
  await expect(bar).toContainText('צופה בגרסה 1 מתוך 2. זו לא הגרסה הנוכחית.');
  await expect(viewer.getByTestId('file-viewer-text')).toHaveText('גרסה ראשונה');
  await expect(viewer.getByTestId('file-viewer-version')).toHaveText('גרסה 1 מתוך 2');

  // 4. Make it current: a new version 3 (a copy of v1), current; the bar is gone.
  await bar.getByTestId('old-version-make-current').click();
  await expect(bar).toHaveCount(0);
  await expect(viewer.locator('[data-testid^="version-row-"]')).toHaveCount(3);
  await expect(viewer.getByTestId('version-row-3').getByTestId('version-current')).toBeVisible();
  await expect(viewer.getByTestId('file-viewer-text')).toHaveText('גרסה ראשונה');
  await page.keyboard.press('Escape');

  // 5. The cell still holds one file (its current version).
  await row.getByTestId('file-cell').click();
  await expect(page.getByTestId('file-cell-open')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // 6. Delete version 2 (after the confirm): v1 and v3 are left.
  viewer = await openViewer();
  await viewer.getByTestId('file-viewer-versions').click();
  await viewer.getByTestId('version-row-2').getByTestId('version-menu').click();
  await page.getByTestId('version-delete').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('למחוק את גרסה 2?');
  await confirm.getByRole('button', { name: 'מחיקה', exact: true }).click();
  await expect(viewer.getByTestId('version-row-2')).toHaveCount(0);
  await expect(viewer.locator('[data-testid^="version-row-"]')).toHaveCount(2);
  await expect(viewer.getByTestId('version-row-3')).toBeVisible();
  await expect(viewer.getByTestId('version-row-1')).toBeVisible();
  // The current version's menu offers only the download.
  await viewer.getByTestId('version-row-3').getByTestId('version-menu').click();
  await expect(page.getByTestId('version-download')).toBeVisible();
  await expect(page.getByTestId('version-make-current')).toHaveCount(0);
  await expect(page.getByTestId('version-delete')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // 7. Remove the file from the cell: to the trash (the confirm says so); the viewer closes.
  await viewer.getByTestId('file-viewer-remove').click();
  const removeConfirm = page.getByRole('alertdialog');
  await expect(removeConfirm).toContainText('הקובץ יעבור לסל המחזור עם כל הגרסאות שלו.');
  await removeConfirm.getByRole('button', { name: 'הסרת הקובץ', exact: true }).click();
  await expect(page.getByTestId('file-viewer')).toHaveCount(0);

  // 8. The trash lists it as a file, with its item and board; restoring puts it back into the cell.
  await page.goto('/a/demo/trash');
  await page.getByLabel('חיפוש בסל').fill(fileName);
  const entry = page.locator(`[data-testid="trash-row"][data-name="${fileName}"]`);
  await expect(entry).toContainText('קובץ');
  await expect(entry.getByTestId('trash-file-versions')).toHaveText('· 2 גרסאות'); // v1 and v3 are left
  await expect(entry).toContainText(itemName);
  await expect(entry).toContainText(`גרסאות ${tag}`);
  await entry.getByTestId('trash-restore').click();
  await expect(entry).toHaveCount(0);
  await expect(page.getByTestId('toast').filter({ hasText: 'שוחזר' })).toBeVisible();

  await page.goto(`/a/demo/b/${board.id}`);
  await row.getByTestId('file-cell').click();
  await expect(page.getByTestId('file-cell-open').filter({ hasText: fileName })).toHaveCount(1);
});
