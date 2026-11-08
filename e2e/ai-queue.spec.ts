// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * The AI images queue ("the system doesn't create all my images"): an image column's run answers at
 * once (`running`, `unit: "image"`, `total` = photos × variations) and the API's job runner makes the designs one
 * after the other (`ai.image_unit`), each saved as soon as it is made; the cell then lists them all as made. A busy
 * provider is tried again: the scripted image maker (`AI_FAKE=scripted`) answers a prompt with `RATE_LIMIT_ONCE` in it
 * with HTTP 429 + `Retry-After: 1` the first time and with an image the next — the design is made and charged once.
 */
const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;
type Run = { id: string; status: string; unit: string; total: number; done: number; failed: number };
/** A 1×1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Upload through the real presign → PUT → complete flow; returns the file id. */
const upload = async (page: Page, headers: Headers, name: string) => {
  const pre = (await (
    await page.request.post(api('/files/presign'), {
      headers,
      data: { name, size: PNG.length, mime: 'image/png' },
    })
  ).json()) as { file_id: string; upload_url: string; headers?: Record<string, string> };
  expect((await page.request.put(pre.upload_url, { headers: pre.headers ?? {}, data: PNG })).ok()).toBe(true);
  expect((await page.request.post(api(`/files/${pre.file_id}/complete`), { headers })).status()).toBe(200);
  return pre.file_id;
};

const setup = async (page: Page, headers: Headers, tag: string, settings: Record<string, unknown>) => {
  const post = async <T = { id: string }>(path: string, data: unknown) =>
    (await (await page.request.post(api(path), { headers, data })).json()) as T;
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as { enabled: boolean };
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = await post('/ai/connections', {
    name: `E2E queue ${tag}`,
    provider: 'openai',
    api_key: 'sk-e2e-not-a-real-key-0000',
  });
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = await post('/boards', { name: `AI queue ${tag}`, workspace_id: ws });
  const photos = await post(`/boards/${board.id}/columns`, { title: 'תמונות', type: 'file' });
  const designs = await post(`/boards/${board.id}/columns`, { title: 'עיצובים', type: 'file' });
  const item = await post(`/boards/${board.id}/items`, { name: `פריט ${tag}` });
  const col = await post(`/boards/${board.id}/columns`, {
    title: 'עיצוב AI',
    type: 'ai',
    settings: {
      output: 'image',
      connection_id: connection.id,
      model: 'gpt-image-e2e',
      image_column: designs.id,
      source_image_columns: [photos.id],
      photo_mode: 'each',
      instructions: 'A sketch of {Name}',
      ...settings,
    },
  });
  const cleanup = async () => {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), { headers, data: { enabled: original.enabled } });
  };
  const runOf = async (id: string) =>
    (await (await page.request.get(api(`/ai-columns/runs/${id}`), { headers })).json()) as Run;
  const filesNow = async () => {
    const it = (await (await page.request.get(api(`/items/${item.id}`), { headers })).json()) as {
      cells: Record<string, { value?: { files?: { asset_id: string }[] } } | undefined>;
    };
    return (it.cells[designs.id]?.value?.files ?? []).map((f) => f.asset_id);
  };
  return { post, connection, board, photos, designs, item, col, cleanup, runOf, filesNow };
};

test('photos × variations: queued, made one after the other, all four shown as made', async ({ page }) => {
  test.setTimeout(150_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const s = await setup(page, headers, tag, { variations: 2 });
  try {
    for (const name of ['a', 'b']) {
      const fileId = await upload(page, headers, `photo-${name}-${tag}.png`);
      await page.request.post(api(`/items/${s.item.id}/cells/${s.photos.id}/files`), {
        headers,
        data: { file_ids: [fileId] },
      });
    }
    const run = await s.post<Run>(`/boards/${s.board.id}/ai-columns/${s.col.id}/run`, {
      mode: 'items',
      item_ids: [s.item.id],
    });
    // Answered at once: planned, made in the background.
    expect(run).toMatchObject({ unit: 'image', status: 'running', total: 4 });
    await expect.poll(async () => (await s.runOf(run.id)).done, { timeout: 60_000 }).toBe(4);
    expect(await s.runOf(run.id)).toMatchObject({ status: 'done', done: 4, failed: 0 });
    expect(await s.filesNow()).toHaveLength(4);

    await page.goto(`/a/demo/b/${s.board.id}`);
    const cell = page.locator(`[data-testid="item-row"][data-item-name="פריט ${tag}"]`).getByTestId('ai-cell');
    await expect(cell).toHaveAttribute('data-ai', 'generated');
    await expect(cell.getByTestId('ai-cell-progress')).toHaveCount(0);
    await cell.click();
    const panel = page.getByTestId('ai-cell-panel');
    await expect(panel.getByTestId('ai-cell-design')).toHaveCount(4);
    await expect(panel.locator('[data-testid="ai-cell-design"][data-status="done"]')).toHaveCount(4);
    await expect(panel.getByTestId('ai-cell-retry-missing')).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    await s.cleanup();
  }
});

test('a busy provider (429, Retry-After 1 s) is tried again: the design is made and charged once', async ({ page }) => {
  test.setTimeout(150_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  // The marker in the description makes the scripted provider answer 429 the first time.
  const s = await setup(page, headers, tag, { instructions: 'A sketch of {Name} RATE_LIMIT_ONCE' });
  try {
    const run = await s.post<Run>(`/boards/${s.board.id}/ai-columns/${s.col.id}/run`, {
      mode: 'items',
      item_ids: [s.item.id],
    });
    expect(run).toMatchObject({ unit: 'image', total: 1 });
    await expect.poll(async () => (await s.runOf(run.id)).status, { timeout: 60_000 }).toBe('done');
    expect(await s.runOf(run.id)).toMatchObject({ done: 1, failed: 0 });
    expect(await s.filesNow()).toHaveLength(1);
    // The cell records the second try.
    const it = (await (await page.request.get(api(`/items/${s.item.id}`), { headers })).json()) as {
      cells: Record<string, { value?: { ai?: { outputs?: { status?: string; attempts?: number }[] } } } | undefined>;
    };
    expect(it.cells[s.col.id]?.value?.ai?.outputs).toEqual([expect.objectContaining({ status: 'done', attempts: 2 })]);
    // Charged once: one image call of this connection in the month's usage (the 429 was not charged).
    const usage = (await (await page.request.get(api('/ai/usage'), { headers })).json()) as {
      rows: { connection_id: string; source: string; calls: number }[];
    };
    const rows = usage.rows.filter((r) => r.connection_id === s.connection.id && r.source === 'image');
    expect(rows.reduce((n, r) => n + r.calls, 0)).toBe(1);
  } finally {
    await s.cleanup();
  }
});
