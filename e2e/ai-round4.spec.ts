// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * AI photos round 4: the AI column's new settings (several photos each / together, variations, how
 * much may change + the locked base column, a new version / another design on a re-run) saved and read back; the
 * designs in the AI cell's panel with ✕ "remove this design" (the app's confirm dialog → the file to the trash, the
 * design shown as rejected); and the run-time choice when re-running a cell that has designs (the app's menu, never
 * a native picker). Images come from the scripted provider (`AI_FAKE=scripted`: tiny PNGs, no money).
 */
const api = (path: string) => `/api/v1${path}`;
type Headers = Record<string, string>;

const setup = async (page: Page, headers: Headers, tag: string) => {
  const post = async <T = { id: string }>(path: string, data: unknown) =>
    (await (await page.request.post(api(path), { headers, data })).json()) as T;
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as Record<string, unknown>;
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = await post('/ai/connections', {
    name: `E2E round4 ${tag}`,
    provider: 'openai',
    api_key: 'sk-e2e-not-a-real-key-0000',
  });
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = await post('/boards', { name: `AI round 4 ${tag}`, workspace_id: ws });
  const photos = await post(`/boards/${board.id}/columns`, { title: 'תמונות', type: 'file' });
  const designs = await post(`/boards/${board.id}/columns`, { title: 'עיצובים', type: 'file' });
  const base = await post(`/boards/${board.id}/columns`, { title: 'סקיצה מאושרת', type: 'file' });
  const item = await post(`/boards/${board.id}/items`, { name: `פריט ${tag}` });
  const cleanup = async () => {
    await page.request.delete(api(`/boards/${board.id}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), { headers, data: { enabled: original.enabled } });
  };
  return { post, connection, board, photos, designs, base, item, cleanup };
};

const noNativePickers = async (page: Page) => expect(page.locator('select')).toHaveCount(0);

const settingsOf = async (page: Page, headers: Headers, boardId: string, colId: string) => {
  const b = (await (await page.request.get(api(`/boards/${boardId}`), { headers })).json()) as {
    columns: { id: string; settings: Record<string, unknown> }[];
  };
  return b.columns.find((c) => c.id === colId)!.settings;
};

test('AI column form: each / together, variations, locked with a base column, re-run as a new version', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const { post, connection, board, photos, designs, base, cleanup } = await setup(page, headers, tag);
  try {
    const col = await post(`/boards/${board.id}/columns`, {
      title: 'עיצוב AI',
      type: 'ai',
      settings: {
        output: 'image',
        connection_id: connection.id,
        image_column: designs.id,
        source_image_columns: [photos.id],
      },
    });
    const openSettings = async () => {
      await page.locator(`[data-header="${col.id}"]`).click({ button: 'right' });
      await page.getByRole('menuitem', { name: /הגדרות|settings/i }).click();
      await expect(page.getByTestId('ai-column-form')).toBeVisible();
      return page.getByTestId('ai-design-options');
    };
    await page.goto(`/a/demo/b/${board.id}`);
    await expect(page.locator(`[data-header="${col.id}"]`)).toBeVisible();

    let options = await openSettings();
    // A new column: each photo separately, one variation, free, a new version on a re-run.
    await expect(options.getByTestId('ai-photo-mode-each')).toHaveAttribute('aria-checked', 'true');
    await expect(options.getByTestId('ai-variations-1')).toHaveAttribute('aria-checked', 'true');
    await expect(options.getByTestId('ai-fidelity-free')).toHaveAttribute('aria-checked', 'true');
    await expect(options.getByTestId('ai-rerun-version')).toHaveAttribute('aria-checked', 'true');
    await expect(options.getByTestId('ai-fidelity-base')).toHaveCount(0);

    await options.getByTestId('ai-photo-mode-together').click();
    await options.getByTestId('ai-variations-2').click();
    await options.getByTestId('ai-fidelity-locked').click();
    // Locked: the base column picker (the app's menu).
    await options.getByTestId('ai-fidelity-base').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await noNativePickers(page);
    await page.getByRole('menuitemradio', { name: 'סקיצה מאושרת', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(options.getByTestId('ai-fidelity-base')).toContainText('סקיצה מאושרת');
    await options.getByTestId('ai-rerun-add').click();
    await page.getByTestId('column-settings-save').click();
    await expect(page.getByTestId('ai-column-form')).toHaveCount(0);

    expect(await settingsOf(page, headers, board.id, col.id)).toMatchObject({
      photo_mode: 'together',
      variations: 2,
      fidelity: 'locked',
      fidelity_base_column: base.id,
      image_on_rerun: 'add',
    });
    options = await openSettings();
    await expect(options.getByTestId('ai-photo-mode-together')).toHaveAttribute('aria-checked', 'true');
    await expect(options.getByTestId('ai-variations-2')).toHaveAttribute('aria-checked', 'true');
    await expect(options.getByTestId('ai-fidelity-base')).toContainText('סקיצה מאושרת');
    await page.keyboard.press('Escape');
  } finally {
    await cleanup();
  }
});

test('AI cell: ✕ removes a design to the trash (shown as rejected); a re-run asks version / another design', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const { post, connection, board, designs, item, cleanup } = await setup(page, headers, tag);
  try {
    const col = await post(`/boards/${board.id}/columns`, {
      title: 'עיצוב AI',
      type: 'ai',
      settings: {
        output: 'image',
        connection_id: connection.id,
        model: 'gpt-image-e2e',
        image_column: designs.id,
        variations: 2,
        instructions: 'A sketch of {Name}',
      },
    });
    // Two designs, made through the API — by the images queue: the run answers at once and its
    // designs are made one after the other; wait for it to end.
    type Run = { id: string; status: string; unit: string; total: number; done: number };
    const run = await post<Run>(`/boards/${board.id}/ai-columns/${col.id}/run`, {
      mode: 'items',
      item_ids: [item.id],
    });
    expect(run).toMatchObject({ unit: 'image', total: 2 });
    await expect
      .poll(
        async () =>
          ((await (await page.request.get(api(`/ai-columns/runs/${run.id}`), { headers })).json()) as Run).status,
        {
          timeout: 30_000,
        },
      )
      .toBe('done');
    expect(((await (await page.request.get(api(`/ai-columns/runs/${run.id}`), { headers })).json()) as Run).done).toBe(
      2,
    );
    const filesNow = async () => {
      const it = (await (await page.request.get(api(`/items/${item.id}`), { headers })).json()) as {
        cells: Record<string, { value?: { files?: { asset_id: string }[] } } | undefined>;
      };
      return (it.cells[designs.id]?.value?.files ?? []).map((f) => f.asset_id);
    };
    expect(await filesNow()).toHaveLength(2);

    await page.goto(`/a/demo/b/${board.id}`);
    const cell = page.locator(`[data-testid="item-row"][data-item-name="פריט ${tag}"]`).getByTestId('ai-cell');
    await expect(cell).toHaveAttribute('data-ai', 'generated');
    await cell.click();
    const panel = page.getByTestId('ai-cell-panel');
    await expect(panel.getByTestId('ai-cell-design')).toHaveCount(2);

    // ✕ → the app's confirm dialog → to the trash; the design stays listed as rejected.
    await panel.getByTestId('ai-cell-design-reject').first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'להסיר את העיצוב הזה' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(filesNow).toHaveLength(1);
    await cell.click();
    await expect(page.getByTestId('ai-cell-design-rejected')).toHaveCount(1);
    await page.keyboard.press('Escape');

    // Re-run a cell that has designs: the app's menu offers a new version or another design (column setting first).
    await cell.hover();
    await cell.getByTestId('ai-cell-run').click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await noNativePickers(page);
    await expect(page.getByTestId('ai-cell-existing-version')).toBeVisible();
    await page.getByTestId('ai-cell-existing-add').click();
    await expect(menu).toHaveCount(0);
    // Another design for each variation: the kept one + two new files.
    await expect.poll(filesNow).toHaveLength(3);
  } finally {
    await cleanup();
  }
});
