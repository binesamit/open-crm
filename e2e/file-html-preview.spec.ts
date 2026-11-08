// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * HTML files in the file viewer: the page itself shows in a sandboxed frame — its styles apply, its
 * scripts do not run — and "Source" shows its code as text.
 */
const uid = () => Date.now().toString(36);

const PAGE = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><title>דוח</title>
<style>h1{color:rgb(20,61,97)}</style></head>
<body><h1 id="title">דוח בדיקה</h1><p id="ran">לא רץ</p>
<script>document.getElementById('ran').textContent = 'רץ'; window.top.document.title = 'hacked';</script>
</body></html>`;

const upload = async (page: Page, headers: Record<string, string>, name: string, text: string) => {
  const bytes = Buffer.from(text, 'utf8');
  const pre = (await (
    await page.request.post('/api/v1/files/presign', {
      headers,
      data: { name, size: bytes.length, mime: 'text/html' },
    })
  ).json()) as { file_id: string; upload_url: string; headers?: Record<string, string> };
  expect((await page.request.put(pre.upload_url, { headers: pre.headers ?? {}, data: bytes })).ok()).toBe(true);
  expect((await page.request.post(`/api/v1/files/${pre.file_id}/complete`, { headers })).status()).toBe(200);
  return pre.file_id;
};

test('an HTML file shows as a page in a sandboxed frame, and as code on "Source"', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = uid();
  const fileName = `report-${tag}.html`;
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `HTML ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  const column = (await (
    await page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data: { title: 'קבצים', type: 'file' } })
  ).json()) as { id: string };
  const itemName = `דוח ${tag}`;
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: itemName } })
  ).json()) as { id: string };
  const file = await upload(page, headers, fileName, PAGE);
  await page.request.post(`/api/v1/items/${item.id}/cells/${column.id}/files`, { headers, data: { file_ids: [file] } });

  await page.goto(`/a/demo/b/${board.id}`);
  const row = page.locator(`[data-testid="item-row"][data-item-name="${itemName}"]`);
  await row.getByTestId('file-cell').click();
  await page.getByTestId('file-cell-open').filter({ hasText: fileName }).click();
  const viewer = page.getByTestId('file-viewer');
  await expect(viewer).toBeVisible();

  // The page, with its own styles; its script did not run and could not reach the app.
  const frameEl = viewer.getByTestId('file-viewer-html');
  await expect(frameEl).toBeVisible();
  await expect(frameEl).not.toHaveAttribute('sandbox', /allow-scripts|allow-same-origin/);
  const frame = page.frameLocator('[data-testid="file-viewer-html"]');
  await expect(frame.locator('#title')).toHaveText('דוח בדיקה');
  await expect(frame.locator('#title')).toHaveCSS('color', 'rgb(20, 61, 97)');
  await expect(frame.locator('#ran')).toHaveText('לא רץ');
  await expect(page).not.toHaveTitle('hacked');
  await expect(viewer.getByTestId('file-viewer-text')).toHaveCount(0);

  // "Source": the code as text; "Page" brings the page back.
  await viewer.getByRole('tab', { name: 'קוד מקור' }).click();
  await expect(viewer.getByTestId('file-viewer-html')).toHaveCount(0);
  await expect(viewer.getByTestId('file-viewer-text')).toContainText('<h1 id="title">דוח בדיקה</h1>');
  await viewer.getByRole('tab', { name: 'תצוגת הדף' }).click();
  await expect(frame.locator('#title')).toHaveText('דוח בדיקה');
});
