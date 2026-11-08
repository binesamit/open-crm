// SPDX-License-Identifier: AGPL-3.0-only
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Where an extension works: on the consent screen the admin picks a workspace (and / or boards) in
 * the app's own dialogs; the extension's view is offered on that workspace's boards only; the installed list shows
 * the scope and changes it later.
 */
const PORT = 3996;
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

const pick = async (page: Page, testId: string, name: string) => {
  await page.getByTestId(testId).click();
  const search = page.getByRole('menu').getByRole('textbox');
  if (await search.count()) await search.fill(name);
  await page.getByRole('menu').getByRole('menuitemradio', { name }).click();
};

test('install on one workspace, the view shows there only; change it to the whole account', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = (path: string) => `/api/v1${path}`;
  const tag = Date.now().toString(36);

  const before = (await (await page.request.get(api('/extensions'), { headers })).json()) as {
    installed: { id: string; key: string }[];
  };
  for (const i of before.installed.filter((x) => x.key === 'summary-cards'))
    await page.request.delete(api(`/extensions/installations/${i.id}`), { headers });

  const home = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const wsName = `Scope ws ${tag}`;
  const ws = (await (await page.request.post(api('/workspaces'), { headers, data: { name: wsName } })).json()) as {
    id: string;
  };
  const inside = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Inside ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  const outside = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Outside ${tag}`, workspace_id: home } })
  ).json()) as { id: string };

  let installationId: string | null = null;
  try {
    await page.goto('/a/demo/admin/extensions');
    await page.getByTestId('ext-tab-dev').click();
    await page.getByTestId('ext-url-input').fill(`${ORIGIN}/manifest.json`);
    await page.getByTestId('ext-check').click();
    await expect(page.getByTestId('ext-consent')).toBeVisible();
    await page.getByTestId('ext-boards-chosen').click();
    // "Chosen" with nothing chosen can't be accepted.
    await expect(page.getByTestId('ext-consent-accept')).toBeDisabled();
    await page.getByTestId('ext-workspaces-add').click();
    await pick(page, 'ext-workspace-picker', wsName);
    await page.getByTestId('ext-workspace-picker-confirm').click();
    await expect(page.getByTestId(`ext-scope-ws-${ws.id}`)).toContainText(wsName);
    await page.getByTestId('ext-consent-accept').click();
    await expect(page.getByTestId('ext-installed-summary-cards')).toBeVisible();
    await expect(page.getByTestId('ext-scope-summary-summary-cards')).toHaveText('מרחב עבודה אחד');
    const list = (await (await page.request.get(api('/extensions'), { headers })).json()) as {
      installed: { id: string; key: string; workspace_ids: string[] | null; board_ids: string[] | null }[];
    };
    const inst = list.installed.find((x) => x.key === 'summary-cards')!;
    installationId = inst.id;
    expect(inst).toMatchObject({ workspace_ids: [ws.id], board_ids: null });

    // The view is offered on a board of the workspace, not on a board elsewhere.
    await page.goto(`/a/demo/b/${inside.id}`);
    await page.getByTestId('view-add').click();
    await expect(page.getByTestId('view-add-ext-summary-cards-summary')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto(`/a/demo/b/${outside.id}`);
    await page.getByTestId('view-add').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByTestId('view-add-ext-summary-cards-summary')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Changed later from the installed list: the whole account.
    await page.goto('/a/demo/admin/extensions');
    await page.getByTestId('ext-tab-installed').click();
    await page.getByTestId('ext-scope-edit-summary-cards').click();
    await expect(page.getByTestId(`ext-scope-ws-${ws.id}`)).toContainText(wsName);
    await page.getByTestId('ext-boards-all').click();
    await page.getByTestId('ext-scope-save').click();
    await expect(page.getByTestId('ext-scope-summary-summary-cards')).toHaveText('כל החשבון');
    await page.goto(`/a/demo/b/${outside.id}`);
    await page.getByTestId('view-add').click();
    await expect(page.getByTestId('view-add-ext-summary-cards-summary')).toBeVisible();
  } finally {
    if (installationId) await page.request.delete(api(`/extensions/installations/${installationId}`), { headers });
    await page.request.delete(api(`/boards/${inside.id}`), { headers });
    await page.request.delete(api(`/boards/${outside.id}`), { headers });
    await page.request.delete(api(`/workspaces/${ws.id}`), { headers });
  }
});
