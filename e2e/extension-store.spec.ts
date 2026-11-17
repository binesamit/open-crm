// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Round 13 (product decisions):
 * 1. Esc closes the open item card / subitem card — after an open menu and a field being edited (each takes one Esc).
 * 2. The toolbar's "hide" panel lists the sub-board's columns too; hidden per view, saved with it, count included.
 * 3. Text size + table density per user (profile → appearance): live, the whole app scales, the table's rows too.
 * 4. Administration → תוספות is a store: catalogue cards → consent → installed; URL / paste under "למפתחים";
 *    "save as pack" can copy to another account the user administers (through that account's consent screen).
 */
const api = (path: string) => `/api/v1${path}`;
const tag = () => Date.now().toString(36);
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

type Ctx = Awaited<ReturnType<typeof ownerContext>>;
const newBoard = async (page: Page, headers: Ctx['headers'], name: string) => {
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  return (await (await page.request.post(api('/boards'), { headers, data: { name, workspace_id: ws } })).json()) as {
    id: string;
  };
};
const newItem = async (page: Page, headers: Ctx['headers'], boardId: string, name: string) =>
  (await (await page.request.post(api(`/boards/${boardId}/items`), { headers, data: { name } })).json()) as {
    id: string;
  };

test('Esc closes the item card and the subitem card — a menu and an edit first', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const t = tag();
  const board = await newBoard(page, headers, `Esc ${t}`);
  const item = await newItem(page, headers, board.id, `Card ${t}`);
  const sub = (await (
    await page.request.post(api(`/items/${item.id}/subitems`), { headers, data: { name: `Sub ${t}` } })
  ).json()) as { id: string };

  // Plain Esc: the card closes, back on the board.
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  const card = page.getByRole('dialog', { name: `Card ${t}` });
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/b/${board.id}(\\?|$)`));

  // Renaming in the title: the first Esc cancels the edit, the second closes the card.
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  await expect(card).toBeVisible();
  await card.getByTestId('card-title-edit').click();
  await page.getByTestId('card-title-input').fill('changed');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('card-title-input')).toBeHidden();
  await expect(card).toBeVisible();
  await expect(card.getByTestId('card-title')).toHaveText(`Card ${t}`);
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();

  // The item's ⋯ menu: Esc closes the menu only; the next one closes the card.
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  await expect(card).toBeVisible();
  await card
    .getByRole('button', { name: /^פעולות ל/ })
    .first()
    .click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(card).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();

  // Typing an update: the first Esc only leaves the editor (the draft stays), the second closes the card.
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
  await expect(card).toBeVisible();
  const editor = card.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type('draft text');
  await page.keyboard.press('Escape');
  await expect(card).toBeVisible();
  await expect(editor).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();

  // A subitem's card closes the same way.
  await page.goto(`/a/demo/b/${board.id}/i/${sub.id}`);
  const subCard = page.getByRole('dialog', { name: `Sub ${t}` });
  await expect(subCard).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(subCard).toBeHidden();
});

test('the hide panel hides subitem columns per view, saved with the view', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const t = tag();
  const board = await newBoard(page, headers, `Hide subs ${t}`);
  const parent = await newItem(page, headers, board.id, `Parent ${t}`);
  await page.request.post(api(`/items/${parent.id}/subitems`), { headers, data: { name: `Child ${t}` } });
  const detail = (await (await page.request.get(api(`/boards/${board.id}`), { headers })).json()) as {
    subitems_board_id: string;
  };
  const col = (await (
    await page.request.post(api(`/boards/${detail.subitems_board_id}/columns`), {
      headers,
      data: { type: 'text', title: `Sub note ${t}` },
    })
  ).json()) as { id: string };
  const view = (await (
    await page.request.post(api(`/boards/${board.id}/views`), { headers, data: { name: `V ${t}`, type: 'table' } })
  ).json()) as { id: string };

  await page.goto(`/a/demo/b/${board.id}?view=${view.id}`);
  await row(page, `Parent ${t}`).hover();
  await row(page, `Parent ${t}`).getByTestId('subitems-toggle').click();
  const subHeader = page.getByTestId('subhead').locator(`[data-header="${col.id}"]`);
  await expect(subHeader).toBeVisible();

  await page.getByTestId('toolbar-hide').click();
  const section = page.getByTestId('hide-sub-section');
  await expect(section).toBeVisible();
  await section.locator(`[data-testid="hide-sub-row"][data-column="${col.id}"]`).getByRole('checkbox').click();
  await expect(subHeader).toBeHidden();
  await expect(page.getByTestId('hide-sub-count')).toBeVisible();
  await page.keyboard.press('Escape');
  // The count on the button includes the subitem column.
  await expect(page.getByTestId('toolbar-hide')).toContainText('1');

  // Saved with the view: after a reload the column stays hidden under the item.
  await page.getByTestId('view-save').click();
  await expect
    .poll(async () => {
      const v = (await (await page.request.get(api(`/boards/${board.id}/views`), { headers })).json()) as {
        data: { id: string; settings: { subitems_hidden_columns?: string[] } }[];
      };
      return v.data.find((x) => x.id === view.id)?.settings.subitems_hidden_columns ?? [];
    })
    .toEqual([col.id]);
  await page.reload();
  await row(page, `Parent ${t}`).hover();
  await row(page, `Parent ${t}`).getByTestId('subitems-toggle').click();
  await expect(page.getByTestId('subhead')).toBeVisible();
  await expect(page.getByTestId('subhead').locator(`[data-header="${col.id}"]`)).toHaveCount(0);
});

test('text size and table density per user: live, everything scales, saved for the user', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const t = tag();
  const board = await newBoard(page, headers, `Size ${t}`);
  await newItem(page, headers, board.id, `Row ${t}`);
  try {
    await page.goto('/a/demo/profile?tab=appearance');
    await expect(page.getByTestId('appearance-settings')).toBeVisible();
    const rootPx = () => page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    const base = await rootPx();

    await page.getByTestId('text-size-xlarge').click();
    await expect(page.locator('html')).toHaveAttribute('data-text-size', 'xlarge');
    await expect.poll(rootPx).toBeCloseTo(base * 1.25, 0);
    // Saved for the user on the server (every device).
    await expect
      .poll(
        async () => ((await (await page.request.get(api('/me/appearance'))).json()) as { text_size: string }).text_size,
      )
      .toBe('xlarge');

    await page.getByTestId('density-compact').click();
    await expect(page.locator('html')).toHaveAttribute('data-density', 'compact');
    // The preview's rows: 38px × 1.25 × 0.84 ≈ 40.
    await expect(page.getByTestId('appearance-preview-row').first()).toHaveCSS('height', '40px');

    // The board's rows follow (text size × density) and the text is not clipped.
    await page.goto(`/a/demo/b/${board.id}`);
    const r = row(page, `Row ${t}`);
    await expect(r).toBeVisible();
    const box = (await r.boundingBox())!;
    expect(Math.round(box.height)).toBeGreaterThanOrEqual(38);
    const name = r.locator('[data-cell="-1"]');
    const clipped = await name.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    expect(clipped).toBe(false);

    // Another device (a fresh context of the same user): the server value applies after sign-in.
    const fresh = (await (await page.request.get(api('/me/appearance'))).json()) as { density: string };
    expect(fresh.density).toBe('compact');
  } finally {
    await page.request.put(api('/me/appearance'), {
      headers: { origin: headers.origin },
      data: { text_size: null, density: null },
    });
    await page.evaluate(() => localStorage.removeItem('bines:appearance'));
  }
});

const PORT = 3997;
const ORIGIN = `http://127.0.0.1:${PORT}`;
let samples: ChildProcess | null = null;
test.describe('the extension store', () => {
  test.beforeAll(async () => {
    const script = fileURLToPath(new URL('../extensions/catalog/serve.mjs', import.meta.url));
    samples = spawn(process.execPath, [script, String(PORT)], { stdio: 'ignore' });
    for (let i = 0; i < 50; i++) {
      const ok = await fetch(`${ORIGIN}/health`)
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('the catalogue sample server did not start');
  });
  test.afterAll(() => {
    samples?.kill();
  });

  test('store cards → consent → installed; the sample board view runs; URL install under "למפתחים"', async ({
    page,
  }) => {
    forbidNativeDialogs(page);
    await signIn(page);
    const { headers } = await ownerContext(page);
    const t = tag();
    const key = 'board-summary';
    type List = {
      installed: { id: string; key: string }[];
      catalog: { key: string }[];
    };
    const list = async () => (await (await page.request.get(api('/extensions'), { headers })).json()) as List;
    // A clean start; the sample enters the catalogue as the platform owner publishes it (unless seeded already).
    for (const i of (await list()).installed.filter((x) => x.key === key))
      await page.request.delete(api(`/extensions/installations/${i.id}`), { headers });
    const seeded = (await list()).catalog.some((c) => c.key === key);
    if (!seeded) {
      const review = {
        checks: Object.fromEntries(
          [
            'https_only',
            'least_scopes',
            'no_token_storage',
            'verifies_signatures',
            'no_eval',
            'privacy_policy',
            'platform_limits',
          ].map((k) => [k, true]),
        ),
        notes: 'E2E r13',
      };
      const res = await page.request.post(api('/platform/extensions/catalog'), {
        headers: { origin: headers.origin },
        data: { source: { manifest_url: `${ORIGIN}/${key}/manifest.json` }, review },
      });
      expect(res.ok()).toBe(true);
    }
    const board = await newBoard(page, headers, `Store ${t}`);
    await newItem(page, headers, board.id, `A ${t}`);
    await newItem(page, headers, board.id, `B ${t}`);
    let installationId: string | null = null;
    try {
      await page.goto('/a/demo/admin/extensions');
      await page.getByTestId('ext-tab-store').click();
      const card = page.getByTestId(`ext-catalog-${key}`);
      await expect(card).toBeVisible();
      await expect(card.getByTestId('ext-card-feature')).toBeVisible();
      await card.getByTestId(`ext-install-${key}`).click();
      await expect(page.getByTestId('ext-consent')).toBeVisible();
      await expect(page.getByTestId('ext-consent').getByTestId('ext-scope-boards:read')).toBeVisible();
      await page.getByTestId('ext-consent-accept').click();
      await expect(page.getByTestId('ext-admin')).toHaveAttribute('data-tab', 'installed');
      await expect(page.getByTestId(`ext-installed-${key}`)).toBeVisible();
      installationId = (await list()).installed.find((x) => x.key === key)!.id;
      // Back in the store the card says "installed".
      await page.getByTestId('ext-tab-store').click();
      await expect(card).toHaveAttribute('data-installed', 'true');

      // The board view: a tab with the sandboxed frame on the samples' origin, reading the board.
      await page.goto(`/a/demo/b/${board.id}`);
      await page.getByTestId('view-add').click();
      await page.getByTestId(`view-add-ext-${key}-summary`).click();
      await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
      const frame = page.frameLocator(`iframe[src^="${ORIGIN}"]`);
      await expect(frame.getByTestId('bs-items')).toHaveText('2');

      // "למפתחים": the manifest URL / paste area.
      await page.goto('/a/demo/admin/extensions');
      await page.getByTestId('ext-tab-dev').click();
      await expect(page.getByTestId('ext-url-input')).toBeVisible();
      await page.getByTestId('ext-mode-json').click();
      await expect(page.getByTestId('ext-json-input')).toBeVisible();
    } finally {
      if (installationId) await page.request.delete(api(`/extensions/installations/${installationId}`), { headers });
      if (!seeded)
        await page.request.delete(api(`/platform/extensions/catalog/${key}`), { headers: { origin: headers.origin } });
    }
  });

  test('save as pack → copy to another account goes through that account’s consent screen', async ({ page }) => {
    forbidNativeDialogs(page);
    await signIn(page);
    const { headers, accountId } = await ownerContext(page);
    const t = tag();
    const board = await newBoard(page, headers, `Pack ${t}`);
    const accounts = (await (await page.request.get(api('/me/accounts'))).json()) as {
      data: { id: string; slug: string; name: string; role: string; status: string }[];
    };
    const other = accounts.data.find((a) => a.id !== accountId && a.role === 'admin' && a.status === 'active');

    await page.goto('/a/demo/admin/extensions');
    await page.getByTestId('ext-export-open').click();
    await page.getByTestId('ext-export-name').fill(`Pack ${t}`);
    await page.getByTestId('ext-export-add-board').click();
    await page.getByTestId('board-picker-board').click();
    // Long lists get a search field in the menu.
    const search = page.getByRole('menu').getByRole('textbox');
    if (await search.count()) await search.fill(`Pack ${t}`);
    await page
      .getByRole('menu')
      .getByRole('menuitemradio', { name: `Pack ${t}` })
      .click();
    await page.getByTestId('board-picker-confirm').click();
    await page.getByTestId('ext-export-dest-account').click();
    if (!other) {
      // Nobody to copy to: the dialog says so (download stays available).
      await expect(page.getByTestId('ext-export-no-accounts')).toBeVisible();
      return;
    }
    await page.getByTestId('ext-export-target').click();
    await page.getByTestId(`ext-export-target-${other.slug}`).click();
    await page.getByTestId('ext-export-save').click();
    // The OTHER account's consent screen — nothing installed there until it is confirmed.
    await expect(page.getByTestId('ext-consent')).toBeVisible();
    await expect(page.getByTestId('ext-consent-note')).toContainText(other.name);
    await page.getByRole('dialog').getByRole('button', { name: 'ביטול' }).click();
    const theirs = (await (
      await page.request.get(api('/extensions'), { headers: { ...headers, 'x-account-id': other.id } })
    ).json()) as { installed: { key: string }[] };
    expect(theirs.installed.some((i) => i.key === `pack-${t}`)).toBe(false);
    void board;
  });
});
