// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Extensions — "תוספות" (D27, ת0–ת2): an admin installs the sample board view (extensions/summary-cards, served on
 * its own origin by its dev server) by URL through the consent screen, adds it as a board tab, the sandboxed page
 * reads the board's items with its short-lived token — and a write outside its scope (it has boards:read only) is
 * refused by the API.
 */
const PORT = 3998;
const ORIGIN = `http://127.0.0.1:${PORT}`;
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

test('install the sample by URL, open its view, it reads items; a write outside its scope is refused', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = (path: string) => `/api/v1${path}`;
  const tag = Date.now().toString(36);

  // A clean start: no earlier install of the sample in this account.
  const before = (await (await page.request.get(api('/extensions'), { headers })).json()) as {
    installed: { id: string; key: string }[];
  };
  for (const i of before.installed.filter((x) => x.key === 'summary-cards'))
    await page.request.delete(api(`/extensions/installations/${i.id}`), { headers });

  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Ext e2e ${tag}`, workspace_id: ws } })
  ).json()) as { id: string };
  for (const name of [`Alpha ${tag}`, `Beta ${tag}`])
    await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name } });

  let installationId: string | null = null;
  try {
    // 1. Administration → תוספות → add by URL → the consent screen → install.
    await page.goto('/a/demo/admin/extensions');
    await expect(page.getByTestId('ext-admin')).toBeVisible();
    // Round 13: installing by URL lives under the store's "למפתחים" tab.
    await page.getByTestId('ext-tab-dev').click();
    await page.getByTestId('ext-url-input').fill(`${ORIGIN}/manifest.json`);
    await page.getByTestId('ext-check').click();
    const consent = page.getByTestId('ext-consent');
    await expect(consent).toBeVisible();
    await expect(consent.getByTestId('ext-scope-boards:read')).toBeVisible();
    await expect(consent.getByTestId('ext-consent-origins')).toContainText(ORIGIN);
    await page.getByTestId('ext-consent-accept').click();
    await expect(page.getByTestId('ext-installed-summary-cards')).toBeVisible();
    const list = (await (await page.request.get(api('/extensions'), { headers })).json()) as {
      installed: { id: string; key: string; granted_scopes: string[] }[];
    };
    const inst = list.installed.find((x) => x.key === 'summary-cards')!;
    installationId = inst.id;
    expect(inst.granted_scopes).toEqual(['boards:read']);

    // 2. The board: "+" → the extension's view → a tab with the sandboxed frame on the extension's origin.
    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('view-add').click();
    await page.getByTestId('view-add-ext-summary-cards-summary').click();
    await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
    const frameEl = page.getByTestId('ext-frame');
    await expect(frameEl).toBeVisible();
    await expect(frameEl).toHaveAttribute('data-origin', ORIGIN);
    // Layer 2: sandboxed, no top navigation.
    const sandbox = (await frameEl.getAttribute('sandbox')) ?? '';
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).not.toContain('allow-top-navigation');
    // The token never travels in the URL.
    expect(await frameEl.getAttribute('src')).toBe(`${ORIGIN}/index.html`);

    // 3. It reads the board's items with its token.
    const frame = page.frameLocator('[data-testid="ext-frame"]');
    await expect(frame.getByTestId('sample-count')).toHaveText('2');
    await expect(frame.getByTestId('sample-names')).toContainText(`Alpha ${tag}`);
    await expect(frame.getByTestId('sample-names')).toContainText(`Beta ${tag}`);

    // 4. A write outside its scope is refused by the API.
    await frame.getByTestId('sample-write').click();
    await expect(frame.getByTestId('sample-write-result')).toHaveText('insufficient_scope');
    const items = (await (await page.request.get(api(`/boards/${board.id}/items`), { headers })).json()) as {
      data: { name: string }[];
    };
    expect(items.data.map((i) => i.name)).not.toContain('from sample');

    // 5. Disabled by the admin → the view no longer loads its data.
    await page.request.patch(api(`/extensions/installations/${installationId}`), {
      headers,
      data: { status: 'disabled' },
    });
    await page.reload();
    await expect(page.getByTestId('ext-view-unavailable')).toBeVisible();
  } finally {
    if (installationId) await page.request.delete(api(`/extensions/installations/${installationId}`), { headers });
    await page.request.delete(api(`/boards/${board.id}`), { headers });
  }
});
