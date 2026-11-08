// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * r15misc (prod items): the doc's code block (highlighted by language, a language picker, copy, LTR), the profile
 * photo's panel + round crop dialog (zoom, save), and the item card's "fields per row" setting. Test ids only.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const LIVE_MS = 5000;

test('docs: a code block — language picker, highlighting, copy, LTR, kept after reload', async ({ page, context }) => {
  forbidNativeDialogs(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] };
  const doc = (await (
    await page.request.post(`/api/v1/workspaces/${ws.data[0]!.id}/docs`, {
      headers,
      data: { name: `קוד ${uid()}`, kind: 'main' },
    })
  ).json()) as { id: string };
  await page.goto(`/a/demo/d/${doc.id}`);
  const ready = () =>
    expect(page.getByTestId('doc-status').first()).toHaveAttribute('data-state', 'saved', { timeout: LIVE_MS });
  await ready();
  const editor = page.getByTestId('doc-view').locator('.ProseMirror').first();

  await editor.click();
  await page.keyboard.type('/code');
  await page.getByTestId('doc-slash-code').click();
  const block = editor.getByTestId('doc-code-block');
  await expect(block).toBeVisible();
  await expect(block).toHaveAttribute('dir', 'ltr');
  await page.keyboard.type('const answer = 42;');

  // Pick TypeScript: the block says so and the keyword / number are coloured.
  await block.getByTestId('doc-code-lang').click();
  await page.getByTestId('doc-code-lang-typescript').click();
  await expect(block).toHaveAttribute('data-language', 'typescript');
  await expect(block.locator('code .hljs-keyword').first()).toHaveText('const');
  await expect(block.locator('code .hljs-number').first()).toHaveText('42');

  // Copy puts the code on the clipboard.
  await block.getByTestId('doc-code-copy').click();
  await expect(block.getByTestId('doc-code-copy')).toHaveAttribute('data-copied', 'true');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('const answer = 42;');

  // Back to auto-detect, then Python; the language survives a reload (a Yjs attribute).
  await block.getByTestId('doc-code-lang').click();
  await page.getByTestId('doc-code-lang-python').click();
  await expect(block).toHaveAttribute('data-language', 'python');
  await ready();
  await page.reload();
  await expect(editor.getByTestId('doc-code-block')).toHaveAttribute('data-language', 'python');
  await expect(editor.getByTestId('doc-code-block').locator('code')).toHaveText('const answer = 42;');
});

/** A non-square PNG drawn in the page. */
const widePng = async (page: Page) =>
  Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 300;
      c.height = 120;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#2f6fe0';
      ctx.fillRect(0, 0, 300, 120);
      ctx.fillStyle = '#c2410c';
      ctx.fillRect(110, 0, 80, 120);
      return c.toDataURL('image/png').split(',')[1]!;
    }),
    'base64',
  );

test('profile photo: the avatar opens the photo panel; a new photo goes through the round crop dialog', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const mate = await newTeammate(page, browser, `חיתוך ${uid()}`);
  forbidNativeDialogs(mate);
  const png = await widePng(mate);
  await mate.goto('/a/demo/profile');
  await expect(mate.getByTestId('profile-page')).toBeVisible();

  // The upload / remove buttons and the hint live in the panel only.
  await expect(mate.getByTestId('profile-photo-upload')).toHaveCount(0);
  await mate.getByTestId('profile-avatar').click();
  await expect(mate.getByTestId('profile-photo-menu')).toBeVisible();
  const chooser = mate.waitForEvent('filechooser');
  await mate.getByTestId('profile-photo-upload').click();
  await (await chooser).setFiles({ name: 'wide.png', mimeType: 'image/png', buffer: png });

  // The crop dialog: zoom in with the button, then save.
  const crop = mate.getByTestId('photo-crop');
  await expect(crop).toBeVisible();
  await expect(crop.locator('img')).toBeVisible();
  await expect(crop).toHaveAttribute('data-zoom', '1.00');
  await mate.getByTestId('photo-crop-zoom-in').click();
  await expect(crop).toHaveAttribute('data-zoom', '1.25');
  await mate.getByTestId('photo-crop-save').click();
  await expect(crop).toHaveCount(0);

  const img = mate.getByTestId('profile-avatar').locator('img');
  await expect(img).toBeVisible();
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth > 0 && el.naturalWidth === el.naturalHeight))
    .toBe(true);

  // Cancel leaves the photo as it was; remove from the panel → initials.
  await mate.getByTestId('profile-avatar').click();
  const chooser2 = mate.waitForEvent('filechooser');
  await mate.getByTestId('profile-photo-upload').click();
  await (await chooser2).setFiles({ name: 'wide.png', mimeType: 'image/png', buffer: png });
  await mate.getByTestId('photo-crop-cancel').click();
  await expect(mate.getByTestId('photo-crop')).toHaveCount(0);
  await expect(img).toBeVisible();
  await mate.getByTestId('profile-avatar').click();
  await mate.getByTestId('profile-photo-remove').click();
  await expect(mate.getByTestId('profile-avatar').locator('img')).toHaveCount(0);
  await mate.context().close();
});

test('item card: fields per row from the card settings (1 / 2 / 3 / auto); a phone shows one', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'patch' | 'delete', path: string, data?: unknown) => {
    const res = await page.request[method](`/api/v1${path}`, { headers, data });
    expect(res.ok(), `${method} ${path}`).toBe(true);
    return (await res.json()) as T;
  };
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `שדות בשורה ${tag}`, workspace_id: ws.id });
  for (const [id, title] of [
    ['f1', 'שדה 1'],
    ['f2', 'שדה 2'],
    ['f3', 'שדה 3'],
    ['f4', 'שדה 4'],
  ] as const)
    await api('post', `/boards/${board.id}/columns`, { id, title, type: 'text' });
  const item = await api<{ id: string }>('post', `/boards/${board.id}/items`, { name: `פריט ${tag}` });

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  const card = page.getByRole('dialog', { name: `פריט ${tag}` });
  await expect(card).toBeVisible();
  await card.locator('[data-testid="card-tab"][data-tab-id="fields"]').click();
  const fields = card.getByTestId('card-fields');
  await expect(fields).toHaveAttribute('data-per-row', '1');

  // Card settings → 2 per row: two fields share the first row.
  await card.getByTestId('card-tabs-settings').click();
  await page.getByTestId('card-fields-per-row-2').click();
  await page.getByTestId('card-tabs-save').click();
  await expect(page.getByTestId('card-tab-settings-dialog')).toHaveCount(0);
  await expect(fields).toHaveAttribute('data-per-row', '2');
  const top = (id: string) =>
    fields.locator(`[data-testid="card-field"][data-column="${id}"]`).evaluate((el) => el.getBoundingClientRect().top);
  expect(Math.abs((await top('f1')) - (await top('f2')))).toBeLessThan(2);
  expect(await top('f3')).toBeGreaterThan(await top('f1'));

  // The setting is kept with the board (the card's subitems setting is untouched).
  const saved = await api<{ card: { fields_per_row?: number | string } }>('get', `/boards/${board.id}`);
  expect(saved.card.fields_per_row).toBe(2);

  // a subitem's card follows the item's board until the subitems board sets its own (1 too).
  const sub = await api<{ id: string }>('post', `/items/${item.id}/subitems`, { name: `תת ${tag}` });
  const subBoardId = (await api<{ subitems_board_id: string }>('get', `/boards/${board.id}`)).subitems_board_id;
  await api('post', `/boards/${subBoardId}/columns`, { id: 's1', title: 'תת שדה 1', type: 'text' });
  await api('post', `/boards/${subBoardId}/columns`, { id: 's2', title: 'תת שדה 2', type: 'text' });
  await page.goto(`/a/demo/b/${board.id}/i/${sub.id}`);
  const subCard = page.getByRole('dialog', { name: `תת ${tag}` });
  await expect(subCard).toBeVisible();
  await subCard.locator('[data-testid="card-tab"][data-tab-id="fields"]').click();
  const subFields = subCard.getByTestId('card-fields');
  await expect(subFields).toHaveAttribute('data-per-row', '2');
  await subCard.getByTestId('card-tabs-settings').click();
  await expect(page.getByTestId('card-fields-per-row-2')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('card-fields-per-row-1').click();
  await page.getByTestId('card-tabs-save').click();
  await expect(page.getByTestId('card-tab-settings-dialog')).toHaveCount(0);
  await expect(subFields).toHaveAttribute('data-per-row', '1');
  expect((await api<{ card: { fields_per_row?: unknown } }>('get', `/boards/${subBoardId}`)).card.fields_per_row).toBe(
    1,
  );
  expect((await api<{ card: { fields_per_row?: unknown } }>('get', `/boards/${board.id}`)).card.fields_per_row).toBe(2);
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  await card.locator('[data-testid="card-tab"][data-tab-id="fields"]').click();
  await expect(fields).toHaveAttribute('data-per-row', '2');

  // A phone: one per row whatever the setting.
  // (Crossing to the phone layout re-opens the card on its first tab.)
  const fieldsTab = card.locator('[data-testid="card-tab"][data-tab-id="fields"]');
  await page.setViewportSize({ width: 390, height: 844 });
  await fieldsTab.click();
  await expect(fields).toBeVisible();
  expect(await top('f2')).toBeGreaterThan(await top('f1'));

  // Back to 1 → the label sits beside its field again.
  await page.setViewportSize({ width: 1600, height: 1000 });
  await fieldsTab.click();
  await card.getByTestId('card-tabs-settings').click();
  await page.getByTestId('card-fields-per-row-1').click();
  await page.getByTestId('card-tabs-save').click();
  await expect(fields).toHaveAttribute('data-per-row', '1');
  await api('delete', `/boards/${board.id}`);
});
