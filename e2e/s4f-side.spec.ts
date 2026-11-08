// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { addNew, forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * s4f-side: the sidebar of a big workspace (~700 lines: folders, boards, docs) in its own workspace (deleted at the
 * end), so demo's main tree stays small for the other specs.
 * - Not windowed (windowing starts above 1,500 lines): every row is in the DOM; rows are memoised, so a new board shows
 *   without a long freeze; favourites, drag & drop and a folder rename still work.
 * - Windowed (the threshold lowered through its localStorage override): only a window of rows is mounted, and what one
 *   just created (a folder far down, a doc) is scrolled into view.
 * Entries are made through the API, 16 at a time (folders and docs are cheap; few boards).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const FOLDERS = 40;
const BOARDS = 40;
const DOCS = 620;
const LINES = FOLDERS + BOARDS + DOCS;
const WINDOW_ROWS_KEY = 'bines:sidebar-window-rows';

/** Runs `jobs` with at most `n` in flight. */
const pool = async <T>(n: number, jobs: (() => Promise<T>)[]) => {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < jobs.length) {
        const i = next++;
        out[i] = await jobs[i]!();
      }
    }),
  );
  return out;
};

const bigWorkspace = async (request: APIRequestContext, headers: Record<string, string>, tag: string) => {
  const post = async <T>(path: string, data: unknown) => {
    const res = await request.post(`/api/v1${path}`, { headers, data });
    expect(res.ok(), `${path}: ${res.status()}`).toBeTruthy();
    return (await res.json()) as T;
  };
  const ws = await post<{ id: string }>('/workspaces', { name: `גדול ${tag}` });
  const folders = await pool(
    16,
    Array.from(
      { length: FOLDERS },
      (_, i) => () => post<{ id: string }>('/folders', { workspace_id: ws.id, name: `תיקייה ${i} ${tag}` }),
    ),
  );
  // Half the boards at the root (drag sources near the bottom), half in folders; the docs in the folders.
  await pool(
    16,
    Array.from(
      { length: BOARDS },
      (_, i) => () =>
        post('/boards', {
          workspace_id: ws.id,
          name: `בורד ${i} ${tag}`,
          ...(i % 2 ? { folder_id: folders[i % FOLDERS]!.id } : {}),
        }),
    ),
  );
  await pool(
    16,
    Array.from(
      { length: DOCS },
      (_, i) => () =>
        post(`/workspaces/${ws.id}/docs`, { folder_id: folders[i % FOLDERS]!.id, name: `מסמך ${i} ${tag}` }),
    ),
  );
  return ws.id;
};

/** Opens demo with `ws` as the sidebar's workspace (the choice the switcher remembers). */
const openWorkspace = async (page: Page, accountId: string, ws: string) => {
  await page.evaluate(([key, id]) => localStorage.setItem(key!, id!), [`bines:workspace:${accountId}`, ws]);
  await page.goto('/a/demo');
};

/** The longest main-thread task while `fn` runs (PerformanceObserver "longtask"; 0 when none). */
const longestTask = async (page: Page, fn: () => Promise<void>) => {
  await page.evaluate(() => {
    const w = window as unknown as { __longest: number; __obs?: PerformanceObserver };
    w.__longest = 0;
    w.__obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__longest = Math.max(w.__longest, e.duration);
    });
    w.__obs.observe({ type: 'longtask', buffered: false });
  });
  await fn();
  return page.evaluate(() => {
    const w = window as unknown as { __longest: number; __obs?: PerformanceObserver };
    w.__obs?.disconnect();
    return w.__longest;
  });
};

const ROWS =
  '[data-testid="board-row"],[data-testid="doc-row"],[data-testid="dashboard-row"],[data-testid="folder-row"]';

test('a workspace of ~700 lines: memoised rows (every row in the DOM), then windowed with new entries in view', async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const tag = uid();
  const { headers, accountId } = await ownerContext(page);
  const ws = await bigWorkspace(page.request, headers, tag);
  try {
    await openWorkspace(page, accountId, ws);
    const sidebar = page.locator('[data-sidebar-scroll]').first();
    const rows = sidebar.locator(ROWS);

    // --- Not windowed: every line is in the DOM (find-in-page and the specs reach all of them). ---
    await expect(rows).toHaveCount(LINES, { timeout: 30_000 });

    // A new board from the "+" menu shows at once, without a long freeze (was a 3.8 s task and 9 s to show).
    const name = `חדש ${tag}`;
    const longest = await longestTask(page, async () => {
      await sidebar.getByTestId('sidebar-add').click();
      await page.getByTestId('add-new-board').click();
      await page.getByTestId('new-board-name').fill(name);
      const t0 = Date.now();
      await page.getByTestId('new-board-submit').click();
      await expect(page).toHaveURL(/\/b\/[^/]+/);
      await expect(sidebar.locator(`[data-testid="board-row"][data-name="${name}"]`)).toHaveCount(1);
      expect(Date.now() - t0).toBeLessThan(5_000);
    });
    expect(longest).toBeLessThan(1_500);
    await expect(rows).toHaveCount(LINES + 1);

    // Favourites: star the new board; it joins "מועדפים" and leaves it again.
    const row = sidebar.locator(`[data-testid="board-row"][data-name="${name}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.hover();
    await row.getByTestId('board-favorite-toggle').click();
    await expect(row.getByTestId('board-favorite-toggle')).toHaveAttribute('aria-pressed', 'true');
    const fav = page
      .getByTestId('favorites-section')
      .locator(`[data-testid="favorite-board-row"][data-name="${name}"]`);
    await expect(fav).toBeVisible();
    await row.getByTestId('board-favorite-toggle').click();
    await expect(fav).toHaveCount(0);

    // Collapse all folders: the last folder and the root boards under it are side by side.
    await sidebar.getByTestId('sidebar-folders-toggle').click();
    await expect(rows).toHaveCount(FOLDERS + BOARDS / 2 + 1);

    // A folder renamed from its ⋯ menu shows the new name at once (the cached tree is patched).
    const folder = sidebar.getByTestId('folder-row').last();
    await folder.scrollIntoViewIfNeeded();
    await folder.hover();
    await folder.getByRole('button', { name: /^פעולות ל/ }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'שינוי שם', exact: true }).click();
    const renamed = `שם חדש ${tag}`;
    await sidebar.getByRole('textbox', { name: 'שינוי שם' }).fill(renamed);
    await page.keyboard.press('Enter');
    const renamedRow = sidebar.getByTestId('folder-row').filter({ hasText: renamed });
    await expect(renamedRow).toBeVisible();

    // Drag & drop: the first root board onto that folder; the folder holds it (the API says so too).
    const moved = sidebar.getByTestId('board-row').first();
    const movedName = (await moved.getAttribute('data-name'))!;
    await moved.scrollIntoViewIfNeeded();
    const a = (await moved.boundingBox())!;
    const x = a.x + a.width - 50;
    await page.mouse.move(x, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(x, a.y + a.height / 2 - 12, { steps: 5 });
    const f = (await renamedRow.boundingBox())!;
    await page.mouse.move(f.x + f.width - 50, f.y + f.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect
      .poll(async () => {
        const tree = (await (await page.request.get(`/api/v1/workspaces/${ws}/tree`, { headers })).json()) as {
          boards: { name: string; folder_id: string | null }[];
          folders: { id: string; name: string }[];
        };
        const target = tree.folders.find((t) => t.name === renamed)?.id;
        return !!target && tree.boards.find((b) => b.name === movedName)?.folder_id === target;
      })
      .toBe(true);

    // Open all folders again.
    await sidebar.getByTestId('sidebar-folders-toggle').click();
    await expect(rows).toHaveCount(LINES + 1);

    // --- Windowed (threshold lowered to 100 lines): a window of rows, new entries scrolled into view. ---
    await page.evaluate((key) => localStorage.setItem(key, '100'), WINDOW_ROWS_KEY);
    await page.goto('/a/demo');
    await expect(sidebar.getByTestId('folder-row').first()).toBeVisible();
    expect(await rows.count()).toBeLessThan(250);

    // A new folder lands after the 40 folders (hundreds of lines below): it is scrolled into view.
    const newFolder = `תיקייה חדשה ${tag}`;
    await addNew(page, 'add-new-folder');
    await page.getByRole('dialog').getByRole('textbox').fill(newFolder);
    await page.getByRole('dialog').getByRole('button', { name: 'יצירה' }).click();
    await expect(sidebar.getByTestId('folder-row').filter({ hasText: newFolder })).toBeVisible();

    // A new doc opens at once, and its row (at the root's end) is in view.
    await sidebar.evaluate((el) => el.scrollTo({ top: 0 }));
    await addNew(page, 'add-new-doc');
    await page.waitForURL(/\/a\/demo\/d\/[0-9A-Z]{26}$/);
    const docId = page.url().split('/').at(-1)!;
    await expect(sidebar.locator(`[data-testid="doc-row"] a[href$="/d/${docId}"]`)).toBeVisible();

    // Scrolling mounts the rows coming into view.
    await sidebar.evaluate((el) => el.scrollTo({ top: 0 }));
    await expect(sidebar.getByTestId('folder-row').first()).toBeVisible();
    await sidebar.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(sidebar.locator(`[data-testid="board-row"][data-name="${name}"]`)).toBeVisible();
  } finally {
    await page.evaluate((key) => localStorage.removeItem(key), WINDOW_ROWS_KEY).catch(() => undefined);
    await page.request.delete(`/api/v1/workspaces/${ws}`, { headers });
  }
});
