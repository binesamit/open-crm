// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod (product owner: "the top bar sits over the open document — make sure everything is right, not only the
 * document"): with every place in the top bar, each surface — the item card, a document's side panel, the files
 * viewer, a dialog, a menu, the AI panel, the quick search, the bell — is checked against the shell's bars: where
 * their boxes meet, the surface is the one on top (`elementFromPoint`). Desktop and a 390px phone, RTL and LTR.
 * The owner's own nav layout and language change for the test (serial) and are put back.
 */
const api = (path: string) => `/api/v1${path}`;
/** The nav's places (NAV_SLOTS in @bines/shared). */
const NAV_SLOTS = [
  'account',
  'home',
  'my_work',
  'inbox',
  'automations',
  'flows',
  'agents',
  'search',
  'assistant',
  'help',
  'bell',
];
const uid = () => Date.now().toString(36);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Where a shell bar and the surface overlap, the surface is on top (five points across the overlap). */
const notCovered = async (page: Page, surface: Locator, what: string) => {
  await expect(surface, what).toBeVisible();
  // Let an opening animation settle before measuring.
  await page.waitForTimeout(350);
  const box = (await surface.boundingBox())!;
  const bars = page.locator('[data-shell-bar]');
  for (let i = 0; i < (await bars.count()); i++) {
    const bar = await bars.nth(i).boundingBox();
    if (!bar) continue;
    const x0 = Math.max(box.x, bar.x);
    const x1 = Math.min(box.x + box.width, bar.x + bar.width);
    const y0 = Math.max(box.y, bar.y);
    const y1 = Math.min(box.y + box.height, bar.y + bar.height);
    if (x1 - x0 < 2 || y1 - y0 < 2) continue;
    const covered = await surface.evaluate(
      (el, { x0, x1, y }) =>
        [0.1, 0.3, 0.5, 0.7, 0.9]
          .map((f) => x0 + (x1 - x0) * f)
          .filter((x) => {
            const hit = document.elementFromPoint(x, y);
            return !hit || !el.contains(hit);
          }).length,
      { x0, x1, y: (y0 + y1) / 2 },
    );
    expect(covered, `${what}: a shell bar is drawn over it`).toBe(0);
  }
};

const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  // Every place in the top bar (the owner's own layout).
  const placement = Object.fromEntries(NAV_SLOTS.map((s) => [s, 'top']));
  expect((await page.request.put(api('/me/nav'), { headers, data: { placement } })).status()).toBeLessThan(300);
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `שכבות ${uid()}`, workspace_id: ws } })
  ).json()) as { id: string };
  await page.request.post(api(`/boards/${board.id}/columns`), { headers, data: { title: 'אפיון', type: 'doc' } });
  const files = (await (
    await page.request.post(api(`/boards/${board.id}/columns`), { headers, data: { title: 'קבצים', type: 'file' } })
  ).json()) as { id: string };
  const itemName = `פריט ${uid()}`;
  const item = (await (
    await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: itemName } })
  ).json()) as { id: string };
  const pre = (await (
    await page.request.post(api('/files/presign'), {
      headers,
      data: { name: 'layer.png', size: PNG.length, mime: 'image/png' },
    })
  ).json()) as { file_id: string; upload_url: string; headers?: Record<string, string> };
  await page.request.put(pre.upload_url, { headers: pre.headers ?? {}, data: PNG });
  await page.request.post(api(`/files/${pre.file_id}/complete`), { headers });
  await page.request.post(api(`/items/${item.id}/cells/${files.id}/files`), {
    headers,
    data: { file_ids: [pre.file_id] },
  });
  const restore = async () => {
    await page.request.put(api('/me/nav'), { headers, data: { placement: null } });
    await page.request.patch(api('/users/me'), { headers, data: { locale: 'he' } });
    await page.request.delete(api(`/boards/${board.id}`), { headers });
  };
  return { board: board.id, item: item.id, itemName, restore };
};

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

test('desktop: no shell bar over the item card, a doc panel, the viewer, dialogs, menus, AI, search, bell', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const s = await setup(page);
  try {
    await page.goto(`/a/demo/b/${s.board}`);
    await expect(page.getByTestId('top-bar')).toBeVisible();
    await notCovered(page, page.getByTestId('board-scroll'), 'the board');

    // The item card.
    await page.goto(`/a/demo/b/${s.board}/i/${s.item}`);
    await notCovered(page, page.getByTestId('item-card'), 'the item card');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('item-card')).toHaveCount(0);

    // A document's side panel (the product owner's screenshot).
    await row(page, s.itemName).getByTestId('doc-cell-new').click();
    await notCovered(page, page.getByTestId('doc-panel'), 'the doc panel');
    await page.getByTestId('doc-panel-close').click();

    // The files viewer.
    await row(page, s.itemName).getByTestId('file-cell').click();
    const viewer = page.getByTestId('file-viewer');
    await expect(viewer.or(page.getByTestId('file-cell-open').first())).toBeVisible();
    if (!(await viewer.count())) await page.getByTestId('file-cell-open').first().click();
    await notCovered(page, viewer, 'the files viewer');
    await page.keyboard.press('Escape');
    await expect(viewer).toHaveCount(0);

    // A menu, then a dialog from it.
    await page.getByRole('button', { name: /^פעולות לעמודה אפיון/ }).click();
    await notCovered(page, page.getByRole('menu'), 'a menu');
    await page.getByRole('menu').getByRole('menuitem', { name: 'הגדרות עמודה' }).click();
    await notCovered(page, page.getByRole('dialog').first(), 'a dialog');
    await page.keyboard.press('Escape');

    // The AI panel, the quick search, the bell.
    await page.getByTestId('top-bar').getByTestId('assistant-open').click();
    await notCovered(page, page.getByTestId('assistant-panel'), 'the AI panel');
    await page.getByTestId('assistant-close').click();
    await expect(page.getByTestId('assistant-panel')).toHaveCount(0);
    await page.keyboard.press('Control+b');
    await notCovered(page, page.getByTestId('search-palette'), 'the quick search');
    await page.keyboard.press('Escape');
    await page.getByTestId('top-bar').getByTestId('bell').click();
    await notCovered(page, page.getByTestId('bell-panel'), 'the bell');
    await page.keyboard.press('Escape');
    await page.screenshot({ path: 'test-results/layers-desktop.png' });
  } finally {
    await s.restore();
  }
});

test('phone (390px): no shell bar over the item card, a doc panel from it, the quick search', async ({ page }) => {
  test.setTimeout(150_000);
  const s = await setup(page);
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/a/demo/b/${s.board}/i/${s.item}`);
    const card = page.getByTestId('item-card');
    await notCovered(page, card, 'the item card (phone)');
    // Its fields: the doc cell makes the doc and opens its panel over the card.
    await card.getByRole('button', { name: 'שדות', exact: true }).click();
    await card.getByTestId('doc-cell-new').click();
    await notCovered(page, page.getByTestId('doc-panel'), 'the doc panel (phone)');
    await page.screenshot({ path: 'test-results/layers-phone-doc.png' });
    await page.getByTestId('doc-panel-close').click();

    // On a board the phone's bar holds the board's own search: the quick search is the header's icon elsewhere.
    await page.goto('/a/demo');
    await page.getByTestId('search-open').filter({ visible: true }).first().click();
    await notCovered(page, page.getByTestId('search-palette'), 'the quick search (phone)');
  } finally {
    await s.restore();
  }
});

test('LTR (English): no shell bar over the item card or a doc panel', async ({ page }) => {
  test.setTimeout(150_000);
  const s = await setup(page);
  try {
    const { headers } = await ownerContext(page);
    await page.request.patch(api('/users/me'), { headers, data: { locale: 'en' } });
    await page.goto(`/a/demo/b/${s.board}/i/${s.item}`);
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await notCovered(page, page.getByTestId('item-card'), 'the item card (LTR)');
    await page.keyboard.press('Escape');
    await row(page, s.itemName).getByTestId('doc-cell-new').click();
    await notCovered(page, page.getByTestId('doc-panel'), 'the doc panel (LTR)');
    await page.screenshot({ path: 'test-results/layers-ltr-doc.png' });
  } finally {
    await s.restore();
  }
});
