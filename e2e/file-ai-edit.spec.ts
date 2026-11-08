// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * "Ask the AI for a change": in the file viewer's "Versions" tab, an image in a files cell gets an
 * instruction; the AI's result becomes the file's next, current version (the list, the header and the cell follow);
 * "make current" on the version before undoes it. No provider is reached: the API runs with `AI_FAKE=scripted`
 * (playwright.config), whose image maker answers every image call — an edit included — with a tiny PNG. The account's
 * image connection + model are set through the API for the test and put back after.
 */
const api = (path: string) => `/api/v1${path}`;
const uid = () => Date.now().toString(36);
/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Upload through the real presign → PUT → complete flow; returns the file id. */
const upload = async (page: Page, headers: Record<string, string>, name: string, bytes: Buffer, mime: string) => {
  const pre = (await (
    await page.request.post(api('/files/presign'), { headers, data: { name, size: bytes.length, mime } })
  ).json()) as { file_id: string; upload_url: string; headers?: Record<string, string> };
  expect((await page.request.put(pre.upload_url, { headers: pre.headers ?? {}, data: bytes })).ok()).toBe(true);
  expect((await page.request.post(api(`/files/${pre.file_id}/complete`), { headers })).status()).toBe(200);
  return pre.file_id;
};

test('ask the AI for a change: the result is a new current version; make current on the one before undoes it', async ({
  page,
}) => {
  // An image edit plus the board's clean-up take longer than the default minute on a loaded machine.
  test.setTimeout(150_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = uid();
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as {
    enabled: boolean;
    images: Record<string, unknown>;
  };
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E images ${tag}`, provider: 'openai', api_key: 'sk-openai-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  const set = await page.request.patch(api('/ai/settings'), {
    headers,
    data: { enabled: true, images: { connection_id: connection.id, model: 'gpt-image-e2e' } },
  });
  expect(set.status()).toBe(200);
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `שינוי AI ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  try {
    const column = (await (
      await page.request.post(api(`/boards/${board.id}/columns`), { headers, data: { title: 'עיצובים', type: 'file' } })
    ).json()) as { id: string };
    const itemName = `פוסטר ${tag}`;
    const item = (await (
      await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: itemName } })
    ).json()) as { id: string };
    const fileName = `poster-${tag}.png`;
    const fileId = await upload(page, headers, fileName, PNG, 'image/png');
    await page.request.post(api(`/items/${item.id}/cells/${column.id}/files`), {
      headers,
      data: { file_ids: [fileId] },
    });

    await page.goto(`/a/demo/b/${board.id}`);
    const row = page.locator(`[data-testid="item-row"][data-item-name="${itemName}"]`);
    await row.getByTestId('file-cell').click();
    const viewer = page.getByTestId('file-viewer');
    // A cell with one image opens it at once; with more it lists them first.
    await expect(viewer.or(page.getByTestId('file-cell-open').first())).toBeVisible();
    if (!(await viewer.count())) await page.getByTestId('file-cell-open').filter({ hasText: fileName }).click();
    await expect(viewer).toBeVisible();
    // A 1×1 test PNG has no visible size: it is enough that the image is there.
    await expect(viewer.getByTestId('file-viewer-image')).toHaveCount(1);

    // The box sits in the "Versions" tab, under the upload zone: the version it changes, and the cost.
    await viewer.getByTestId('file-viewer-versions').click();
    const box = viewer.getByTestId('ai-edit');
    await expect(box).toBeVisible();
    await expect(box.getByTestId('ai-edit-hint')).toContainText('הגרסה הנוכחית (גרסה 1)');
    await expect(box.getByTestId('ai-edit-hint')).toContainText('כל שינוי הוא תמונת AI בתשלום.');
    await expect(box.getByTestId('ai-edit-submit')).toBeDisabled();

    await box.getByTestId('ai-edit-input').fill('להסיר את הרקע');
    await box.getByTestId('ai-edit-submit').click();
    // The new version is current; the header and the list follow; the box is ready for the next change.
    await expect(viewer.getByTestId('version-row-2').getByTestId('version-current')).toBeVisible();
    await expect(viewer.getByTestId('file-viewer-version')).toHaveText('גרסה 2');
    await expect(box.getByTestId('ai-edit-input')).toHaveValue('');
    await expect(box.getByTestId('ai-edit-hint')).toContainText('הגרסה הנוכחית (גרסה 2)');
    await expect(page.getByText('גרסה 2 נוצרה.', { exact: false })).toBeVisible();
    // The focus stayed in the viewer: Esc still reaches it later.
    await expect(viewer).toBeVisible();

    // From the API: two versions, the AI's current.
    const versions = (await (await page.request.get(api(`/files/${fileId}/versions`), { headers })).json()) as {
      data: { version: number; current: boolean }[];
    };
    expect(versions.data.map((v) => [v.version, v.current])).toEqual([
      [2, true],
      [1, false],
    ]);

    // Undo: make version 1 current again (version 3).
    await viewer.getByTestId('version-row-1').getByRole('button').first().click();
    await expect(viewer.getByTestId('old-version-bar')).toBeVisible();
    await expect(box.getByTestId('ai-edit-hint')).toContainText('גרסה 1, שמוצגת עכשיו');
    await viewer.getByTestId('old-version-make-current').click();
    await expect(viewer.getByTestId('old-version-bar')).toHaveCount(0);
    await expect(viewer.getByTestId('version-row-3').getByTestId('version-current')).toBeVisible();
    await expect(viewer.getByTestId('file-viewer-version')).toHaveText('גרסה 3');

    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);
    // The cell keeps one file.
    await expect(row.getByTestId('file-cell')).toBeVisible();
  } finally {
    await page.request.delete(api(`/boards/${board.id}`), { headers, timeout: 15_000 });
    await page.request.patch(api('/ai/settings'), {
      headers,
      data: { enabled: original.enabled, images: original.images },
      timeout: 15_000,
    });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers, timeout: 15_000 });
  }
});
