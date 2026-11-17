// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Fix list 3 (shell): a template's working board is a hidden draft (continue / cancel from the templates
 * page); a board's full description (one line in the header, all of it in a dialog); boards inside folders are
 * indented; boards are dragged among boards (before / after, also into another folder).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = async (name: string, folderId?: string) =>
    (await (
      await page.request.post('/api/v1/boards', {
        headers,
        data: { name, workspace_id: ws, ...(folderId ? { folder_id: folderId } : {}) },
      })
    ).json()) as { id: string };
  const folder = async (name: string) =>
    (await (await page.request.post('/api/v1/folders', { headers, data: { workspace_id: ws, name } })).json()) as {
      id: string;
    };
  return { headers, ws, board, folder };
};

test('template edit: a hidden draft — continue later or cancel from the templates page', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { headers, board } = await setup(page);
  const src = await board(`מקור טיוטה ${id}`);
  await page.request.post(`/api/v1/boards/${src.id}/save-as-template`, { headers, data: { name: `טיוטה ${id}` } });
  await page.goto('/a/demo/admin/templates');
  const row = page.locator(`[data-testid="template-row"][data-name="טיוטה ${id}"]`);
  await row.getByRole('button', { name: /^פעולות לתבנית/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'עריכת התבנית', exact: true }).click();

  // The working board opens with its bar; it is not among the boards.
  const banner = page.getByTestId('template-edit-banner');
  await expect(banner).toContainText(`טיוטה ${id}`);
  await expect(page).toHaveURL(/\/b\/[^/]+/);
  const draftUrl = page.url();
  await expect(page.getByTestId('board-row').filter({ hasText: `טיוטה ${id} · עריכת תבנית` })).toHaveCount(0);

  // Leave without saving: the template row says there is an open draft.
  await banner.getByTestId('template-edit-back').click();
  await expect(page).toHaveURL(/\/a\/demo\/admin\/templates$/);
  await expect(row.getByTestId('template-draft')).toContainText('טיוטה פתוחה');

  // Continue: the same working board.
  await row.getByTestId('template-draft-continue').click();
  await expect(banner).toBeVisible();
  expect(page.url()).toBe(draftUrl);

  // Cancel from the bar: the draft is gone, the templates page shows again.
  await banner.getByTestId('template-edit-discard').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ביטול עריכה' }).click();
  await expect(page).toHaveURL(/\/a\/demo\/admin\/templates$/);
  await expect(row.getByTestId('template-draft')).toHaveCount(0);

  // A new draft, cancelled from the row this time.
  await row.getByRole('button', { name: /^פעולות לתבנית/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'עריכת התבנית', exact: true }).click();
  await expect(banner).toBeVisible();
  await page.goto('/a/demo/admin/templates');
  await row.getByTestId('template-draft-cancel').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ביטול עריכה' }).click();
  await expect(row.getByTestId('template-draft')).toHaveCount(0);
  await expect(page.getByTestId('toast').filter({ hasText: 'עריכת התבנית בוטלה' })).toBeVisible();
});

test('board description: one line in the header, the full text in a dialog (editable)', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { board } = await setup(page);
  const b = await board(`תיאור ${id}`);
  await page.goto(`/a/demo/b/${b.id}`);

  // Empty: a muted "הוספת תיאור".
  await page.getByTestId('board-description-add').click();
  const dialog = page.getByTestId('board-description-dialog');
  await expect(dialog).toBeVisible();
  const long = `שורה ראשונה ${id} ${'טקסט ארוך מאוד '.repeat(20)}\nשורה שנייה\nשורה שלישית`;
  await dialog.getByTestId('board-description-input').fill(long);
  await page.getByTestId('board-description-save').click();
  await expect(dialog).toBeHidden();

  // One line in the header.
  const line = page.getByTestId('board-description');
  await expect(line).toContainText(`שורה ראשונה ${id}`);
  const box = (await line.boundingBox())!;
  expect(box.height).toBeLessThan(30);

  // A click shows all of it, and it is edited there.
  await line.click();
  await expect(dialog.getByTestId('board-description-input')).toHaveValue(long);
  await dialog.getByTestId('board-description-input').fill(`קצר ${id}`);
  await page.getByTestId('board-description-save').click();
  await expect(line).toHaveText(`קצר ${id}`);
  await page.reload();
  await expect(page.getByTestId('board-description')).toHaveText(`קצר ${id}`);
});

const sidebarOf = (page: Page) => page.locator('aside').first();
const namesIn = (folderRow: Locator) =>
  folderRow
    .locator('xpath=..')
    .getByTestId('board-row')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-name')));

test('boards inside a folder are indented; root boards are not', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { board, folder } = await setup(page);
  const f = await folder(`תיקייה ${id}`);
  await board(`בתוך ${id}`, f.id);
  await board(`בשורש ${id}`);
  await page.goto('/a/demo');
  const sidebar = sidebarOf(page);
  const inside = sidebar.locator(`[data-testid="board-row"][data-name="בתוך ${id}"]`);
  const root = sidebar.locator(`[data-testid="board-row"][data-name="בשורש ${id}"]`);
  await inside.scrollIntoViewIfNeeded();
  await expect(inside).toBeVisible();
  await expect(root).toBeVisible();
  const a = (await inside.boundingBox())!;
  const b = (await root.boundingBox())!;
  // RTL: the inline start is on the right — an indented row ends further left.
  expect(a.x + a.width).toBeLessThan(b.x + b.width - 16);
  await expect(inside.locator('xpath=..')).toHaveAttribute('data-testid', 'folder-children');
});

/** Drags `from` (by its name, not the inline-end buttons) onto the upper / lower half of `to`. */
const dragBoard = async (page: Page, from: Locator, to: Locator, side: 'before' | 'after') => {
  const a = (await from.boundingBox())!;
  const x = a.x + a.width - 50;
  await page.mouse.move(x, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, a.y + a.height / 2 + 12, { steps: 5 });
  const b = (await to.boundingBox())!;
  const y = side === 'before' ? b.y + b.height * 0.25 : b.y + b.height * 0.75;
  await page.mouse.move(b.x + b.width - 50, y, { steps: 10 });
  await expect(to.getByTestId('board-drop-indicator')).toHaveAttribute('data-side', side);
  await page.mouse.up();
};

test('boards are dragged among boards: reorder in a folder and into another folder', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { board, folder } = await setup(page);
  const f = await folder(`סדר ${id}`);
  const g = await folder(`יעד ${id}`);
  for (const n of ['א', 'ב', 'ג']) await board(`${n}-${id}`, f.id);
  await board(`ד-${id}`, g.id);
  await page.goto('/a/demo');
  const sidebar = sidebarOf(page);
  const folderRow = (name: string) => sidebar.getByTestId('folder-row').filter({ hasText: name });
  const rowOf = (name: string) => sidebar.locator(`[data-testid="board-row"][data-name="${name}"]`);
  await expect(rowOf(`ג-${id}`)).toBeVisible();
  // Both folders in view (the account has many boards; the sidebar scrolls).
  await rowOf(`ד-${id}`).evaluate((e) => e.scrollIntoView({ block: 'center' }));
  expect(await namesIn(folderRow(`סדר ${id}`))).toEqual([`א-${id}`, `ב-${id}`, `ג-${id}`]);

  // ג above א.
  await dragBoard(page, rowOf(`ג-${id}`), rowOf(`א-${id}`), 'before');
  await expect.poll(() => namesIn(folderRow(`סדר ${id}`))).toEqual([`ג-${id}`, `א-${id}`, `ב-${id}`]);

  // א into the other folder, below ד.
  await dragBoard(page, rowOf(`א-${id}`), rowOf(`ד-${id}`), 'after');
  await expect.poll(() => namesIn(folderRow(`יעד ${id}`))).toEqual([`ד-${id}`, `א-${id}`]);
  await expect.poll(() => namesIn(folderRow(`סדר ${id}`))).toEqual([`ג-${id}`, `ב-${id}`]);

  // Kept on the server.
  await page.reload();
  await expect(rowOf(`ד-${id}`)).toBeVisible();
  expect(await namesIn(folderRow(`סדר ${id}`))).toEqual([`ג-${id}`, `ב-${id}`]);
  expect(await namesIn(folderRow(`יעד ${id}`))).toEqual([`ד-${id}`, `א-${id}`]);
});
