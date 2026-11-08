// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { addNew, forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Fix: — shell (product decisions): the workspace "+" opens one "add new" menu; "החלפת חשבון" is one item with a
 * submenu of my accounts; job title / department / phone are per account ("פרטים בחשבון זה"); docs and dashboards
 * can be favourites too (one list, reorderable); AI model pickers read the connection's live model list.
 */
const uid = () => Date.now().toString(36);

test('the workspace "+" opens one menu: board, board from a template, doc, dashboard, folder', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const plus = page.getByTestId('sidebar-add');
  await expect(plus).toHaveAttribute('aria-haspopup', 'menu');
  // The separate per-kind buttons are gone.
  await expect(page.getByTestId('sidebar-new-board')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-new-doc')).toHaveCount(0);
  await expect(page.getByTestId('sidebar-new-dashboard')).toHaveCount(0);

  await plus.click();
  const menu = page.getByRole('menu');
  for (const id of ['add-new-board', 'add-board-template', 'add-new-doc', 'add-new-dashboard', 'add-new-folder'])
    await expect(menu.getByTestId(id)).toBeVisible();
  await page.keyboard.press('Escape');

  // A board from a template: the dialog starts on a template (no "empty board" choice).
  await addNew(page, 'add-board-template');
  const dialog = page.getByTestId('new-board-dialog');
  await expect(dialog).toHaveAttribute('data-mode', 'template');
  await page.getByTestId('new-board-template').click();
  await expect(page.getByTestId('new-board-template-option').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('new-board-cancel').click();

  // A folder: named in the system dialog, shown in the tree.
  const folder = `תיקייה ${uid()}`;
  await addNew(page, 'add-new-folder');
  await page.getByRole('dialog').getByRole('textbox').fill(folder);
  await page.getByRole('dialog').getByRole('button', { name: 'יצירה' }).click();
  await expect(page.getByTestId('folder-row').filter({ hasText: folder })).toBeVisible();

  // A doc and a dashboard open at once.
  await addNew(page, 'add-new-doc');
  await page.waitForURL(/\/a\/demo\/d\/[0-9A-Z]{26}$/);
  await addNew(page, 'add-new-dashboard');
  await page.waitForURL(/\/a\/demo\/dash\/[0-9A-Z]{26}$/);
});

test('"החלפת חשבון" is one item; its submenu lists my accounts with the current one marked', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const accounts = (
    (await (await page.request.get('/api/v1/me/accounts', { headers })).json()) as {
      data: { slug: string; name: string }[];
    }
  ).data;
  await page.getByTestId('profile-menu').first().click();
  const panel = page.getByTestId('profile-menu-panel');
  await expect(panel).toBeVisible();
  // No account rows in the main menu.
  await expect(panel.locator('[data-testid^="menu-account-"]')).toHaveCount(0);
  if (accounts.length < 2) {
    await expect(panel.getByTestId('menu-switch-account')).toHaveCount(0);
    return;
  }
  await panel.getByTestId('menu-switch-account').click();
  for (const a of accounts) await expect(page.getByTestId(`menu-account-${a.slug}`)).toBeVisible();
  await expect(page.getByTestId('menu-account-demo')).toContainText('✓');
});

test('job title, department and phone are "פרטים בחשבון זה"; personal details stay apart', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const before = (await (await page.request.get('/api/v1/users/me', { headers })).json()) as {
    title: string | null;
    account?: { id: string; name: string };
  };
  try {
    await page.goto('/a/demo/profile');
    const section = page.getByTestId('profile-account-section');
    await expect(section).toBeVisible();
    await expect(section).toHaveAttribute('data-account', before.account!.id);
    await expect(section).toContainText(before.account!.name);
    // The per-account fields are inside it; name and birthday are not.
    await expect(section.getByTestId('profile-title')).toBeVisible();
    await expect(section.getByTestId('profile-department')).toBeVisible();
    await expect(section.getByTestId('profile-phone')).toBeVisible();
    await expect(section.getByTestId('profile-name')).toHaveCount(0);
    await expect(section.getByTestId('profile-birthday')).toHaveCount(0);
    const title = `מנהל ${uid()}`;
    await section.getByTestId('profile-title').fill(title);
    await page.getByTestId('profile-save').click();
    await expect
      .poll(
        async () =>
          (
            (await (await page.request.get('/api/v1/users/me', { headers })).json()) as {
              title: string;
            }
          ).title,
      )
      .toBe(title);
  } finally {
    await page.request.patch('/api/v1/users/me', { headers, data: { title: before.title } });
  }
});

test('docs and dashboards are favourites too: starred from their ⋯ menu, one list, reordered', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const id = uid();
  const docName = `מסמך מועדף ${id}`;
  const dashName = `דשבורד מועדף ${id}`;
  await page.request.post(`/api/v1/workspaces/${ws}/docs`, { headers, data: { name: docName } });
  await page.request.post(`/api/v1/workspaces/${ws}/dashboards`, { headers, data: { name: dashName } });
  const saved = (await (await page.request.get('/api/v1/me/favorites', { headers })).json()) as {
    data: { type: string; id: string }[];
  };
  try {
    await page.reload();
    const dashRow = page.getByTestId('dashboard-row').filter({ hasText: dashName });
    await dashRow.hover();
    await dashRow.getByRole('button', { name: /^פעולות ל/ }).click();
    await page.getByTestId('dashboard-menu-favorite').click();
    const docRow = page.getByTestId('doc-row').filter({ hasText: docName });
    await docRow.hover();
    await docRow.getByRole('button', { name: /^פעולות ל/ }).click();
    await page.getByTestId('doc-row-menu-favorite').click();

    const favs = page.getByTestId('favorites-section');
    const favDash = favs.locator(`[data-testid="favorite-dashboard-row"][data-name="${dashName}"]`);
    const favDoc = favs.locator(`[data-testid="favorite-doc-row"][data-name="${docName}"]`);
    await expect(favDash).toHaveAttribute('data-type', 'dashboard');
    await expect(favDoc).toHaveAttribute('data-type', 'doc');
    // One list: the doc (starred last) comes after the dashboard; drag it above.
    const rows = favs.locator('[data-type]');
    const names = async () => rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));
    expect((await names()).indexOf(docName)).toBeGreaterThan((await names()).indexOf(dashName));
    // The local sidebar is long (the doc / dashboard rows starred above sit low in it): bring the list back in view.
    await favDash.scrollIntoViewIfNeeded();
    await favDoc.scrollIntoViewIfNeeded();
    const from = (await favDoc.boundingBox())!;
    const to = (await favDash.boundingBox())!;
    await page.mouse.move(from.x + 40, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(from.x + 40, from.y + from.height / 2 - 8, { steps: 4 });
    await page.mouse.move(to.x + 40, to.y + 4, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await names()).indexOf(docName) < (await names()).indexOf(dashName)).toBe(true);
    // Saved on the server in that order.
    await expect
      .poll(async () => {
        const now = (await (await page.request.get('/api/v1/me/favorites', { headers })).json()) as {
          data: { name: string }[];
        };
        const n = now.data.map((f) => f.name);
        return n.indexOf(docName) < n.indexOf(dashName);
      })
      .toBe(true);
    // A favourite opens its page.
    await favDash.getByRole('link').click();
    await page.waitForURL(/\/dash\/[0-9A-Z]{26}$/);
  } finally {
    await page.request.put('/api/v1/me/favorites', { headers, data: { items: saved.data } });
  }
});

test("AI: a connection's models come from the provider (or the catalogue offline), with prices", async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const conn = (await (
    await page.request.post('/api/v1/ai/connections', {
      headers,
      data: { name: `מודלים ${uid()}`, api_key: 'sk-ant-e2e-not-a-real-key-MODL' },
    })
  ).json()) as { id: string; name: string };
  try {
    await page.goto('/a/demo/admin/ai');
    const row = page.getByTestId('ai-connection-row').filter({ hasText: conn.name });
    await row.getByTestId('ai-connection-models').click();
    const dialog = page.getByTestId('ai-models-dialog');
    await expect(dialog).toBeVisible();
    // A fake key: the provider cannot be read, the catalogue stands in (a real key shows "live").
    await expect(dialog.getByTestId('ai-models-source')).toHaveAttribute('data-source', /live|fallback/);
    const opus = dialog.locator('[data-testid="ai-model-row"][data-model="claude-opus-5-5"]');
    await expect(opus.getByTestId('ai-model-price')).toHaveAttribute('data-known', 'true');
    // An admin's price for a model.
    await opus.getByTestId('ai-model-price-edit').click();
    await opus.getByTestId('ai-model-price-input').fill('5');
    await opus.getByTestId('ai-model-price-output').fill('25');
    await opus.getByTestId('ai-model-price-save').click();
    await expect(opus.getByTestId('ai-model-price')).toContainText('$5/$25');
    await expect(opus.getByTestId('ai-model-price-reset')).toBeVisible();
    await page.keyboard.press('Escape');
    // The connection's default model picker lists the same models.
    await row.getByTestId('ai-connection-edit').click();
    await page.getByTestId('ai-connection-model').click();
    await expect(page.getByTestId('ai-connection-model-option').first()).toBeVisible();
  } finally {
    await page.request.delete(`/api/v1/ai/connections/${conn.id}`, { headers });
  }
});
