// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn, pickGroupColumn } from './helpers';

/**
 * Fix: (table):
 * E — a subitem goes one level up: a sub-subitem under its grandparent (right after its old parent) from the item
 *     menu, a checked subitem to an item with Shift+Tab; undo puts it back.
 * F — in a view grouped by a column, dragging a row (real mouse) to another section sets that column's value
 *     (status, people), the empty section clears it, and a date grouping refuses the drop.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const nameCell = (page: Page, name: string) => row(page, name).first().locator('[data-cell="-1"]');

type ApiItem = {
  id: string;
  name: string;
  parent_item_id: string | null;
  group_id: string | null;
  depth: number;
  position: string;
  cells: Record<string, { value: unknown } | undefined>;
};
type ApiBoard = {
  subitems_board_id: string | null;
  groups: { id: string }[];
  columns: { id: string; type: string; settings: { labels?: { id: number; label: string }[] } }[];
};

const api = async (page: Page) => {
  const { headers, meId } = await ownerContext(page);
  const get = async <T>(path: string) => (await (await page.request.get(`/api/v1${path}`, { headers })).json()) as T;
  const post = async <T>(path: string, data: unknown) =>
    (await (await page.request.post(`/api/v1${path}`, { headers, data })).json()) as T;
  const put = async (path: string, data: unknown) => {
    const res = await page.request.put(`/api/v1${path}`, { headers, data });
    expect(res.ok()).toBe(true);
  };
  return { get, post, put, meId };
};

const newBoard = async (page: Page, items: string[]) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `סבב8 ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const item of items) {
    await add.fill(item);
    await add.press('Enter');
    await expect(row(page, item)).toBeVisible();
  }
  return /\/b\/([^/?]+)/.exec(page.url())![1]!;
};

const addSubitems = async (page: Page, parent: string, names: string[]) => {
  await row(page, parent).hover();
  await row(page, parent).getByTestId('subitems-toggle').click();
  const field = page.getByLabel('+ הוספת תת-פריט').first();
  for (const n of names) {
    await field.fill(n);
    await field.press('Enter');
    await expect(row(page, n)).toBeVisible();
  }
};

const byPosition = (a: ApiItem, b: ApiItem) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0);

const centre = (b: { x: number; y: number; width: number; height: number }, fy = 0.5) => ({
  x: b.x + Math.min(b.width / 2, 80),
  y: b.y + b.height * fy,
});

/** By the ⋮⋮ handle with the real mouse, onto `target` (fy = fraction of its height); `check` runs before letting go. */
const handleDrag = async (page: Page, from: Locator, target: Locator, fy: number, check?: () => Promise<void>) => {
  // The handle shows on hover once the row can be dragged (the board's rights loaded); a row that re-renders
  // meanwhile (a refetch) has no box for a moment — retry until both ends are on screen.
  const box = async (l: Locator) => {
    const got: { box: Awaited<ReturnType<Locator['boundingBox']>> } = { box: null };
    await expect(async () => {
      got.box = await l.boundingBox({ timeout: 1000 });
      expect(got.box).not.toBeNull();
    }).toPass();
    return got.box!;
  };
  await expect(async () => {
    await from.hover({ timeout: 1000 });
    await expect(from.locator('[data-drag-handle]')).toBeVisible({ timeout: 1000 });
  }).toPass();
  const a = centre(await box(from.locator('[data-drag-handle]')));
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 3, a.y + 5, { steps: 3 });
  const b = centre(await box(target), fy);
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.waitForTimeout(80);
  await check?.();
  await page.mouse.up();
  await page.waitForTimeout(150);
};

/** The section key a row is shown under (sections and rows are siblings, in screen order). */
const sectionOf = async (page: Page, name: string) => {
  const names = await page.locator('[data-testid="item-row"], [data-testid="board-section"]').evaluateAll((els) => {
    let section = '';
    const out: Record<string, string> = {};
    for (const el of els) {
      if (el.getAttribute('data-testid') === 'board-section') section = el.getAttribute('data-section') ?? '';
      else out[el.getAttribute('data-item-name') ?? ''] = section;
    }
    return out;
  });
  return names[name];
};

const groupBy = async (page: Page, title: string) => {
  await page.getByTestId('toolbar-group').click();
  await pickGroupColumn(page, title);
  await page.keyboard.press('Escape');
};

test('E: a sub-subitem goes one level up from the menu, a checked subitem with Shift+Tab; undo', async ({ page }) => {
  const boardId = await newBoard(page, ['P', 'Q']);
  await addSubitems(page, 'P', ['S', 'S2']);
  await addSubitems(page, 'S', ['T']);
  const a = await api(page);
  const board = await a.get<ApiBoard>(`/boards/${boardId}`);
  const subs = async () => (await a.get<{ data: ApiItem[] }>(`/boards/${board.subitems_board_id}/items`)).data;
  const mains = async () => (await a.get<{ data: ApiItem[] }>(`/boards/${boardId}/items`)).data;
  const find = async (name: string) => [...(await mains()), ...(await subs())].find((i) => i.name === name)!;
  const under = async (name: string) => {
    const parent = await find(name);
    return (await subs())
      .filter((i) => i.parent_item_id === parent.id)
      .sort(byPosition)
      .map((i) => i.name);
  };

  // T (under S under P) → menu "move to item ▸ one level up": under P, right after S.
  await expect(async () => {
    await nameCell(page, 'T').click({ button: 'right' });
    await expect(page.getByTestId('menu-tree')).toBeVisible({ timeout: 1000 });
  }).toPass();
  await page.getByTestId('menu-tree').click();
  await page.getByTestId('menu-tree-up').click();
  await expect.poll(() => under('P')).toEqual(['S', 'T', 'S2']);
  expect(await under('S')).toEqual([]);

  // Ctrl+Z puts it back under S.
  await page.mouse.move(1, 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => under('S')).toEqual(['T']);

  // S checked + Shift+Tab → an item of P's group right after P (T comes along under it).
  await expect(row(page, 'S')).toBeVisible();
  await row(page, 'S').getByTestId('row-select').click();
  await page.mouse.move(1, 1);
  await page.keyboard.press('Shift+Tab');
  await expect.poll(async () => (await find('S')).depth).toBe(0);
  const p = await find('P');
  const s = await find('S');
  expect(s).toMatchObject({ parent_item_id: null, group_id: p.group_id });
  expect(
    (await mains())
      .filter((i) => !i.parent_item_id)
      .sort(byPosition)
      .map((i) => i.name),
  ).toEqual(['P', 'S', 'Q']);
  expect(await under('S')).toEqual(['T']);
  expect((await find('T')).depth).toBe(1);
  await expect(row(page, 'S')).toBeVisible();
});

test('F: grouped by status / people, a dragged row takes the section value; date sections refuse', async ({ page }) => {
  // Three groupings with a reload each: about a minute on a loaded machine (a trace showed no single stalled step).
  test.setTimeout(120_000);
  const boardId = await newBoard(page, ['Alpha', 'Beta', 'Gamma']);
  const a = await api(page);
  const status = await a.post<{ id: string }>(`/boards/${boardId}/columns`, { title: 'מצב', type: 'status' });
  const people = await a.post<{ id: string }>(`/boards/${boardId}/columns`, { title: 'אחראים', type: 'people' });
  const date = await a.post<{ id: string }>(`/boards/${boardId}/columns`, { title: 'מועד', type: 'date' });
  const board = await a.get<ApiBoard>(`/boards/${boardId}`);
  const labels = board.columns.find((c) => c.id === status.id)!.settings.labels!;
  const [l1, l2] = [labels[0]!, labels[1]!];
  const members = (await a.get<{ data: { user_id: string; status: string }[] }>('/users')).data;
  const other = members.find((m) => m.user_id !== a.meId && m.status === 'active')!.user_id;
  const items = async () => (await a.get<{ data: ApiItem[] }>(`/boards/${boardId}/items`)).data;
  const id = async (name: string) => (await items()).find((i) => i.name === name)!.id;
  const cell = async (name: string, col: string) => (await items()).find((i) => i.name === name)!.cells[col]?.value;
  await a.put(`/items/${await id('Alpha')}/cells/${status.id}`, { value: { index: l1.id } });
  await a.put(`/items/${await id('Beta')}/cells/${status.id}`, { value: { index: l2.id } });
  await a.put(`/items/${await id('Alpha')}/cells/${people.id}`, {
    value: { persons_and_teams: [{ id: a.meId, kind: 'person' }] },
  });
  await a.put(`/items/${await id('Beta')}/cells/${people.id}`, {
    value: { persons_and_teams: [{ id: other, kind: 'person' }] },
  });
  await a.put(`/items/${await id('Alpha')}/cells/${date.id}`, { value: { date: '2020-01-01' } });
  await page.reload();
  await expect(row(page, 'Gamma')).toBeVisible();

  // Status: Alpha (l1) dragged onto Beta's row (l2) → Alpha is l2.
  await groupBy(page, 'מצב');
  await expect(page.getByTestId('board-section')).toHaveCount(3);
  await handleDrag(page, row(page, 'Alpha'), nameCell(page, 'Beta'), 0.8);
  await expect.poll(() => cell('Alpha', status.id)).toMatchObject({ index: l2.id });
  // Gamma (no status) onto Alpha (now l2) → l2.
  await expect.poll(() => sectionOf(page, 'Alpha')).toBe(await sectionOf(page, 'Beta'));
  const written = page.waitForResponse((r) => r.request().method() === 'PUT' && r.url().includes('/cells/'));
  await handleDrag(page, row(page, 'Gamma'), nameCell(page, 'Alpha'), 0.2);
  await expect.poll(() => cell('Gamma', status.id)).toMatchObject({ index: l2.id });
  // The app has the write's answer (the event Ctrl+Z undoes) — the API poll alone can be ahead of it.
  await written;
  // The board groups did not change: everything is still in the first group.
  expect(new Set((await items()).map((i) => i.group_id)).size).toBe(1);
  // Ctrl+Z undoes the last value change.
  await page.mouse.move(1, 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => cell('Gamma', status.id)).toBeFalsy();
  // The undo refetches the board after the API answered: wait until Gamma is shown in the empty section again
  // (dropped beside it while it still shows under l2, Beta would just move within its own section).
  await expect.poll(() => sectionOf(page, 'Gamma')).toMatch(/__empty__$/);
  // Into the empty section (Gamma's again) → the value is cleared.
  await handleDrag(page, row(page, 'Beta'), nameCell(page, 'Gamma'), 0.8);
  await expect.poll(() => cell('Beta', status.id)).toBeFalsy();
  // After a reload the API values hold.
  await page.reload();
  await expect(row(page, 'Alpha')).toBeVisible();
  expect(await cell('Alpha', status.id)).toMatchObject({ index: l2.id });
  expect(await cell('Beta', status.id)).toBeFalsy();

  // People: Alpha (me) onto Beta (other) → Alpha's person is the other one.
  await groupBy(page, 'אחראים');
  await expect(page.getByTestId('board-section')).toHaveCount(3);
  await handleDrag(page, row(page, 'Alpha'), nameCell(page, 'Beta'), 0.8);
  await expect
    .poll(async () => ((await cell('Alpha', people.id)) as { persons_and_teams?: { id: string }[] })?.persons_and_teams)
    .toEqual([{ id: other, kind: 'person' }]);
  await page.reload();
  await expect(row(page, 'Alpha')).toBeVisible();
  expect(((await cell('Alpha', people.id)) as { persons_and_teams: { id: string }[] }).persons_and_teams).toEqual([
    { id: other, kind: 'person' },
  ]);

  // Date sections are ranges: the drop is refused (a "no entry" mark), nothing changes.
  await groupBy(page, 'מועד');
  await expect(page.getByTestId('board-section')).toHaveCount(2);
  await handleDrag(page, row(page, 'Beta'), nameCell(page, 'Alpha'), 0.8, async () => {
    await expect(page.getByTestId('row-drag-overlay')).toHaveAttribute('data-blocked', 'true');
  });
  await page.waitForTimeout(300);
  expect(await cell('Beta', date.id)).toBeFalsy();
});
