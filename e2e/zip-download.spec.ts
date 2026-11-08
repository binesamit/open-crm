// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * "Download all" as one ZIP: the files cell's button and an update's button download a real ZIP
 * whose Hebrew names open as written (equal names get " (2)"); a file that cannot be included is counted (a toast
 * and a note in the ZIP) but never named; the account's setting turned off hides the button.
 */
const uid = () => Date.now().toString(36);

/** The entries of a ZIP: name → text (reads the central directory; stored or deflated entries). */
const readZip = (buf: Buffer) => {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const packed = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const skip = nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString('utf8');
    const local = buf.readUInt32LE(at + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + packed);
    out[name] = (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    at += 46 + skip;
  }
  return out;
};

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

const downloadZip = async (page: Page, click: () => Promise<void>) => {
  const pending = page.waitForEvent('download');
  await click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  return { name: download.suggestedFilename(), files: readZip(await readFile((await download.path())!)) };
};

test('download all: a files cell and an update as one ZIP; skipped files counted; off hides the button', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = uid();
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `הורדת הכול ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  const column = (await (
    await page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data: { title: 'קבצים', type: 'file' } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: `חוזה ${tag}` } })
  ).json()) as { id: string };
  const ids = [
    await upload(page, headers, 'חוזה.txt', 'גרסה ראשונה'),
    await upload(page, headers, 'חוזה.txt', 'גרסה שנייה'),
    await upload(page, headers, 'נספח.txt', 'נספח'),
  ];
  await page.request.post(`/api/v1/items/${item.id}/cells/${column.id}/files`, { headers, data: { file_ids: ids } });

  // 1. The files cell: its popup offers "download all"; the ZIP holds every file, Hebrew names as written.
  await page.goto(`/a/demo/b/${board.id}`);
  const row = page.locator(`[data-testid="item-row"][data-item-name="חוזה ${tag}"]`);
  await row.getByTestId('file-cell').click();
  const cellZip = await downloadZip(page, () => page.getByTestId('file-cell-download-all').click());
  expect(cellZip.name).toContain('.zip');
  expect(cellZip.files).toEqual({ 'חוזה.txt': 'גרסה ראשונה', 'חוזה (2).txt': 'גרסה שנייה', 'נספח.txt': 'נספח' });
  await expect(page.getByText('ההורדה מתחילה…')).toBeVisible();
  await page.keyboard.press('Escape');

  // 2. An update with two files: the same button under the update.
  const files = [await upload(page, headers, 'סיכום.txt', 'סיכום'), await upload(page, headers, 'דוח.txt', 'דוח')];
  await page.request.post(`/api/v1/items/${item.id}/updates`, {
    headers,
    data: { body: `שני קבצים ${tag}`, file_ids: files },
  });
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  const entry = page.locator('[data-testid="update-entry"]', { hasText: `שני קבצים ${tag}` }).first();
  const updateZip = await downloadZip(page, () => entry.getByTestId('update-download-all').click());
  expect(updateZip.files).toEqual({ 'סיכום.txt': 'סיכום', 'דוח.txt': 'דוח' });
  await page.keyboard.press('Escape');

  // 3. A file that cannot be included: counted in the toast and in a note — never named.
  execFileSync('pnpm', ['--filter', '@bines/api', 'exec', 'tsx', 'scripts/e2e-asset-pending.ts', ids[2]!], {
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  await page.goto(`/a/demo/b/${board.id}`);
  await row.getByTestId('file-cell').click();
  const partial = await downloadZip(page, () => page.getByTestId('file-cell-download-all').click());
  await expect(page.getByText('1 קבצים שאין לך גישה אליהם לא נכללו')).toBeVisible();
  expect(Object.keys(partial.files)).toEqual(['חוזה.txt', 'חוזה (2).txt', 'קבצים שלא נכללו.txt']);
  expect(partial.files['קבצים שלא נכללו.txt']).toContain('1');
  expect(JSON.stringify(partial.files)).not.toContain('נספח');
  await page.keyboard.press('Escape');

  // 4. The account's setting off: no button (and back on).
  const set = (zip_enabled: boolean) =>
    page.request.patch('/api/v1/accounts/me', { headers, data: { settings: { downloads: { zip_enabled } } } });
  expect((await set(false)).ok()).toBe(true);
  try {
    await page.reload();
    await row.getByTestId('file-cell').click();
    await expect(page.getByTestId('file-cell-open').first()).toBeVisible();
    await expect(page.getByTestId('file-cell-download-all')).toHaveCount(0);
  } finally {
    expect((await set(true)).ok()).toBe(true);
  }
});
