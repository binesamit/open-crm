// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod (product owner: "drag folders like everything else, and put one wherever I want — between boards too, not
 * always at the top"): a folder is dragged by its header — between boards (in a folder or the root), before
 * another folder (its upper third), or into one (the rest) — with all that is in it; kept on the server.
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
  const folder = async (name: string, parent?: string) =>
    (await (
      await page.request.post('/api/v1/folders', {
        headers,
        data: { workspace_id: ws, name, ...(parent ? { parent_folder_id: parent } : {}) },
      })
    ).json()) as { id: string };
  const tree = async () =>
    (await (await page.request.get(`/api/v1/workspaces/${ws}/tree`, { headers })).json()) as {
      folders: { id: string; parent_folder_id: string | null; position: string }[];
      boards: { id: string; folder_id: string | null; position: string }[];
    };
  return { board, folder, tree };
};

const sidebarOf = (page: Page) => page.locator('aside').first();
/** What a folder holds, in order: board names and sub-folder names. */
const childrenOf = (folderRow: Locator) =>
  folderRow
    .locator('xpath=..')
    .locator(':scope > [data-testid="folder-children"]')
    .evaluate((el) =>
      Array.from(el.children).map(
        (c) =>
          c.getAttribute('data-name') ??
          c.querySelector(':scope > [data-testid="folder-row"]')?.getAttribute('data-name') ??
          '?',
      ),
    );

/** Drags a folder by its header onto `to`: a row's upper / lower half, or a folder's upper third / middle. */
const dragFolder = async (page: Page, from: Locator, to: Locator, at: 'before' | 'after' | 'into') => {
  const a = (await from.boundingBox())!;
  const x = a.x + a.width - 60;
  await page.mouse.move(x, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, a.y + a.height / 2 + 12, { steps: 5 });
  const b = (await to.boundingBox())!;
  const y = at === 'before' ? b.y + b.height * 0.15 : at === 'after' ? b.y + b.height * 0.8 : b.y + b.height * 0.65;
  await page.mouse.move(b.x + b.width - 60, y, { steps: 10 });
  if (at !== 'into') await expect(to.getByTestId('board-drop-indicator')).toHaveAttribute('data-side', at);
  else await expect(to.getByTestId('board-drop-indicator')).toHaveCount(0);
  await page.mouse.up();
};

test('a folder is dragged between boards, before another folder and into one', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { board, folder, tree } = await setup(page);
  const outer = await folder(`חיצונית ${id}`);
  await board(`א-${id}`, outer.id);
  await board(`ב-${id}`, outer.id);
  const moving = await folder(`נגררת ${id}`);
  await board(`בפנים-${id}`, moving.id);
  await page.goto('/a/demo');
  const sidebar = sidebarOf(page);
  const folderRow = (name: string) => sidebar.locator(`[data-testid="folder-row"][data-name="${name}"]`);
  const rowOf = (name: string) => sidebar.locator(`[data-testid="board-row"][data-name="${name}"]`);
  await rowOf(`בפנים-${id}`).evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await expect(rowOf(`ב-${id}`)).toBeVisible();

  // Between the two boards of the other folder (with its board inside it).
  await dragFolder(page, folderRow(`נגררת ${id}`), rowOf(`ב-${id}`), 'before');
  await expect.poll(() => childrenOf(folderRow(`חיצונית ${id}`))).toEqual([`א-${id}`, `נגררת ${id}`, `ב-${id}`]);
  await expect.poll(() => childrenOf(folderRow(`נגררת ${id}`))).toEqual([`בפנים-${id}`]);

  // Before the outer folder (its upper third): out to the root, right above it.
  await dragFolder(page, folderRow(`נגררת ${id}`), folderRow(`חיצונית ${id}`), 'before');
  await expect.poll(() => childrenOf(folderRow(`חיצונית ${id}`))).toEqual([`א-${id}`, `ב-${id}`]);
  await expect
    .poll(async () => {
      const t = await tree();
      const m = t.folders.find((f) => f.id === moving.id)!;
      const o = t.folders.find((f) => f.id === outer.id)!;
      return m.parent_folder_id === null && m.position < o.position;
    })
    .toBe(true);

  // Into it (the middle of its header): after its folders — before its boards.
  await dragFolder(page, folderRow(`נגררת ${id}`), folderRow(`חיצונית ${id}`), 'into');
  await expect.poll(() => childrenOf(folderRow(`חיצונית ${id}`))).toEqual([`נגררת ${id}`, `א-${id}`, `ב-${id}`]);

  // Kept on the server.
  await page.reload();
  await rowOf(`ב-${id}`).evaluate((e) => e.scrollIntoView({ block: 'center' }));
  expect(await childrenOf(folderRow(`חיצונית ${id}`))).toEqual([`נגררת ${id}`, `א-${id}`, `ב-${id}`]);
});
