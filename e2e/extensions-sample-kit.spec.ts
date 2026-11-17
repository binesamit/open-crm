// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Extensions ת3–ת5 (D27): the sample kit (extensions/summary-cards/serve.mjs, `/kit/manifest.json`, its own origin)
 * installed by URL through the consent screen; then its item-card tab writes an update "via app", its board ⋯
 * action and batch action open in a modal frame with the selection, its dashboard widget counts what the viewer
 * sees, its settings page keeps a value in the extension's storage, and its automation action is called (signed)
 * when an item is created and writes back with the call's token.
 */
const PORT = 3998;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const KEY = 'sample-kit';
let sample: ChildProcess | null = null;

test.beforeAll(async () => {
  const script = fileURLToPath(new URL('../extensions/summary-cards/serve.mjs', import.meta.url));
  sample = spawn(process.execPath, [script, String(PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    const ok = await fetch(`${ORIGIN}/health`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('the sample extension server did not start');
});
test.afterAll(() => {
  sample?.kill();
});

const api = (path: string) => `/api/v1${path}`;
const kitFrame = (page: Page, scope = page.locator('body')) => scope.frameLocator('[data-testid="ext-frame"]');

test('the sample kit: item tab, menu and batch actions, widget, settings page and an automation action', async ({
  page,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);

  const before = (await (await page.request.get(api('/extensions'), { headers })).json()) as {
    installed: { id: string; key: string }[];
  };
  for (const i of before.installed.filter((x) => x.key === KEY))
    await page.request.delete(api(`/extensions/installations/${i.id}`), { headers });

  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Kit e2e ${tag}`, workspace_id: ws } })
  ).json()) as { id: string };
  const items: { id: string; name: string }[] = [];
  for (const name of [`Alpha ${tag}`, `Beta ${tag}`])
    items.push(
      (await (await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name } })).json()) as {
        id: string;
        name: string;
      },
    );
  const dash = (await (
    await page.request.post(api(`/workspaces/${ws}/dashboards`), {
      headers,
      data: { name: `Kit dash ${tag}`, board_ids: [board.id] },
    })
  ).json()) as { id: string };

  const updatesOf = async (itemId: string) =>
    (
      (await (await page.request.get(api(`/items/${itemId}/updates`), { headers })).json()) as {
        data: { body_text?: string; body_html?: string }[];
      }
    ).data.map((u) => u.body_text ?? u.body_html ?? '');

  let installationId: string | null = null;
  let automationId: string | null = null;
  try {
    // 1. Install by URL through the consent screen.
    await page.goto('/a/demo/admin/extensions');
    // Round 13: installing by URL lives under the store's "למפתחים" tab.
    await page.getByTestId('ext-tab-dev').click();
    await page.getByTestId('ext-url-input').fill(`${ORIGIN}/kit/manifest.json`);
    await page.getByTestId('ext-check').click();
    const consent = page.getByTestId('ext-consent');
    await expect(consent).toBeVisible();
    await expect(consent.getByTestId('ext-scope-items:write')).toBeVisible();
    // Each feature under its own kind (not every one called a board view).
    await expect(consent).toContainText('לשונית בכרטיס פריט:');
    await expect(consent).toContainText("ווידג'ט בדשבורד:");
    await expect(consent).toContainText('פעולת אוטומציה:');
    await page.getByTestId('ext-consent-accept').click();
    await expect(page.getByTestId(`ext-installed-${KEY}`)).toBeVisible();
    const list = (await (await page.request.get(api('/extensions'), { headers })).json()) as {
      installed: { id: string; key: string }[];
    };
    installationId = list.installed.find((x) => x.key === KEY)!.id;

    // 2. The settings page (admins): a value kept in the extension's storage.
    await page.getByTestId(`ext-settings-open-${KEY}`).click();
    const settings = kitFrame(page, page.getByTestId('ext-settings-page'));
    await settings.getByTestId('kit-greeting').fill(`שלום ${tag}`);
    await settings.getByTestId('kit-save').click();
    await expect(settings.getByTestId('kit-saved')).toHaveText('saved');
    await page.reload();
    await page.getByTestId(`ext-settings-open-${KEY}`).click();
    await expect(kitFrame(page, page.getByTestId('ext-settings-page')).getByTestId('kit-greeting')).toHaveValue(
      `שלום ${tag}`,
    );

    // 3. The item card's extension tab: the item as context; its write is "via app".
    await page.goto(`/a/demo/b/${board.id}/i/${items[0]!.id}`);
    await page.locator(`[data-testid="card-tab"][data-tab-id^="ext:${installationId}:"]`).click();
    const tab = kitFrame(page, page.getByTestId('ext-item-tab'));
    await expect(tab.getByTestId('kit-item-name')).toHaveText(items[0]!.name);
    await tab.getByTestId('kit-item-note').click();
    await expect(tab.getByTestId('kit-item-result')).toHaveText('ok');
    await expect.poll(() => updatesOf(items[0]!.id)).toContainEqual(expect.stringContaining('עדכון מלשונית התוסף'));

    // 4. The board ⋯ menu: a modal frame with no selection.
    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('board-more').click();
    await page.getByTestId(`ext-action-${KEY}-mark`).click();
    const modal = page.getByTestId('ext-modal');
    await expect(modal).toBeVisible();
    await expect(kitFrame(page, modal).getByTestId('kit-selection-count')).toHaveText('0');
    await page.keyboard.press('Escape');
    await expect(modal).toBeHidden();

    // 5. The batch bar: both rows selected → the modal frame gets both; it writes and closes itself.
    for (const it of items)
      await page.locator(`[data-testid="item-row"][data-item-name="${it.name}"]`).getByTestId('row-select').click();
    await page.getByTestId(`batch-ext-${KEY}-bulk`).click();
    const batch = page.getByTestId('ext-modal');
    await expect(kitFrame(page, batch).getByTestId('kit-selection-count')).toHaveText('2');
    await kitFrame(page, batch).getByTestId('kit-apply').click();
    await expect(batch).toBeHidden();
    for (const it of items)
      await expect.poll(() => updatesOf(it.id)).toContainEqual(expect.stringContaining('סומן על ידי התוסף'));

    // 6. The dashboard widget: counts the dashboard's boards this viewer may see.
    await page.goto(`/a/demo/dash/${dash.id}`);
    await page.getByTestId('dashboard-add-widget').click();
    await page.getByTestId(`widget-add-ext-${KEY}-count`).click();
    const widget = page.locator('[data-testid="widget"][data-type="extension"]');
    await expect(kitFrame(page, widget).getByTestId('kit-widget-count')).toHaveText('2');

    // 7. The automation action: a signed call when an item is created; it writes back with the call's token.
    const secret = (
      (await (
        await page.request.get(api(`/extensions/installations/${installationId}/secret`), { headers })
      ).json()) as {
        secret: string;
      }
    ).secret;
    await fetch(`${ORIGIN}/dev/secret`, {
      method: 'POST',
      body: JSON.stringify({ installation_id: installationId, secret }),
    });
    const auto = await page.request.post(api(`/boards/${board.id}/automations`), {
      headers,
      data: {
        recipe: {
          trigger: { type: 'item_created' },
          actions: [{ type: 'run_extension', block: `${KEY}.note`, input: { message: 'נוצר: {item.name}' } }],
        },
      },
    });
    expect(auto.status()).toBe(201);
    automationId = ((await auto.json()) as { id: string }).id;
    const created = (await (
      await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: `Gamma ${tag}` } })
    ).json()) as { id: string };
    await expect
      .poll(() => updatesOf(created.id), { timeout: 30_000 })
      .toContainEqual(expect.stringContaining(`נוצר: Gamma ${tag}`));
    const runs = (await (await fetch(`${ORIGIN}/dev/runs`)).json()) as {
      runs: { check: string; item_id: string | null }[];
    };
    expect(runs.runs.find((r) => r.item_id === created.id)?.check).toBe('ok');
  } finally {
    if (automationId) await page.request.delete(api(`/automations/${automationId}`), { headers });
    if (installationId) await page.request.delete(api(`/extensions/installations/${installationId}`), { headers });
    await page.request.delete(api(`/dashboards/${dash.id}`), { headers });
    await page.request.delete(api(`/boards/${board.id}`), { headers });
  }
});
