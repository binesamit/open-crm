// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod — deleting a folder that holds boards: the person chooses. "Move the boards to the root" (the
 * default) leaves them active at the root, where the sidebar shows them; "delete with the folder" sends them to
 * trash with it, and restoring the folder brings them back into it. Runs in a fresh workspace, deleted at the end.
 */
const choose = (page: Page, item: string | RegExp) => {
  const menu = page.getByRole('menu');
  return menu
    .getByRole('menuitem', { name: item })
    .or(menu.getByRole('menuitemradio', { name: item }))
    .click();
};
const menuOf = async (row: Locator, name: string) => {
  await row.hover();
  await row.getByRole('button', { name: `פעולות ל${name}` }).click();
};

test('a folder with boards: to the root, or to trash with it and back', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const stamp = Date.now().toString(36);
  const sidebar = page.locator('aside').first();

  // A fresh workspace, two folders with boards (one in a sub-folder).
  const wsName = `מחיקת תיקייה ${stamp}`;
  const ws = (await (await page.request.post('/api/v1/workspaces', { headers, data: { name: wsName } })).json()) as {
    id: string;
  };
  const folder = async (name: string, parent?: string) =>
    (
      (await (
        await page.request.post('/api/v1/folders', {
          headers,
          data: { workspace_id: ws.id, name, ...(parent ? { parent_folder_id: parent } : {}) },
        })
      ).json()) as { id: string }
    ).id;
  const board = async (name: string, folderId: string) => {
    const res = await page.request.post('/api/v1/boards', {
      headers,
      data: { name, workspace_id: ws.id, folder_id: folderId },
    });
    expect(res.ok(), await res.text()).toBe(true);
  };
  const keep = await folder(`נשמר ${stamp}`);
  await board(`לשורש ${stamp}`, keep);
  const gone = await folder(`נמחק ${stamp}`);
  const inner = await folder(`פנימית ${stamp}`, gone);
  await board(`יחד א ${stamp}`, gone);
  await board(`יחד ב ${stamp}`, inner);

  try {
    await page.goto('/');
    await sidebar.getByRole('button', { name: 'החלפת מרחב עבודה' }).click();
    await choose(page, wsName);
    const boardRow = (name: string) => sidebar.getByText(name, { exact: true });

    // 1. The default: the board moves to the root and stays in the sidebar.
    const keepRow = sidebar.getByTestId('folder-row').filter({ hasText: `נשמר ${stamp}` });
    await menuOf(keepRow, `נשמר ${stamp}`);
    await choose(page, 'מחיקה');
    const dialog = page.getByTestId('choice-dialog');
    await expect(dialog).toContainText('בורד אחד');
    await expect(page.getByTestId('folder-delete-root').locator('input')).toBeChecked();
    await page.getByTestId('choice-dialog-confirm').click();
    await expect(keepRow).toHaveCount(0);
    await expect(boardRow(`לשורש ${stamp}`)).toBeVisible();
    await page.reload();
    await expect(boardRow(`לשורש ${stamp}`)).toBeVisible();

    // 2. With the folder: both boards (one in the sub-folder) go to trash with it.
    const goneRow = sidebar.getByTestId('folder-row').filter({ hasText: `נמחק ${stamp}` });
    await menuOf(goneRow, `נמחק ${stamp}`);
    await choose(page, 'מחיקה');
    await expect(dialog).toContainText('2 בורדים');
    await page.getByTestId('folder-delete-trash').click();
    await page.getByTestId('choice-dialog-confirm').click();
    await expect(goneRow).toHaveCount(0);
    await expect(boardRow(`יחד א ${stamp}`)).toHaveCount(0);
    await expect(boardRow(`יחד ב ${stamp}`)).toHaveCount(0);

    // 3. Restoring the folder brings them back into it.
    const entries = (await (await page.request.get('/api/v1/trash', { headers })).json()) as {
      data: { id: string; name: string }[];
    };
    const entry = entries.data.find((e) => e.name === `נמחק ${stamp}`)!;
    expect((await page.request.post(`/api/v1/trash/${entry.id}/restore`, { headers })).ok()).toBe(true);
    await page.reload();
    await expect(goneRow).toBeVisible();
    const tree = (await (await page.request.get(`/api/v1/workspaces/${ws.id}/tree`, { headers })).json()) as {
      boards: { name: string; folder_id: string | null }[];
    };
    expect(tree.boards.find((b) => b.name === `יחד א ${stamp}`)?.folder_id).toBe(gone);
    expect(tree.boards.find((b) => b.name === `יחד ב ${stamp}`)?.folder_id).toBe(inner);
  } finally {
    const tree = (await (await page.request.get(`/api/v1/workspaces/${ws.id}/tree`, { headers })).json()) as {
      boards?: { id: string }[];
    };
    for (const b of tree.boards ?? []) await page.request.delete(`/api/v1/boards/${b.id}`, { headers });
    await page.request.delete(`/api/v1/workspaces/${ws.id}`, { headers });
  }
});
