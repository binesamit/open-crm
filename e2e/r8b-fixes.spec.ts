// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn, pickGroupColumn } from './helpers';

/**
 * Fix: b:
 * A — in a view grouped by a column, the row's right-click "move to group" lists the view's sections (status labels,
 *     people, "no value") and sets that column's value like the drag does; Ctrl+Z undoes it. Grouped by a date
 *     column it stays the board's groups.
 * B — "move up one level" is in the shared item menu: the item card's ⋯ shows it for a sub-subitem.
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
  groups: { id: string; title: string }[];
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
  const name = `סבב8ב ${Date.now().toString(36)}`;
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

const groupBy = async (page: Page, title: string) => {
  await page.getByTestId('toolbar-group').click();
  await pickGroupColumn(page, title);
  await page.keyboard.press('Escape');
};

/** Right click (real mouse) on the row's name → "העברה לקבוצה" → the submenu's entries. */
const openMoveMenu = async (page: Page, target: Locator) => {
  await expect(async () => {
    await page.keyboard.press('Escape');
    await target.click({ button: 'right' });
    await page.getByRole('menu').getByRole('menuitem', { name: 'העברה לקבוצה' }).click({ timeout: 1000 });
  }).toPass();
  return page.getByRole('menu');
};

test('A: grouped by a column, the right-click "move to group" sets the section value; undo', async ({ page }) => {
  const boardId = await newBoard(page, ['Alpha', 'Beta', 'Gamma']);
  const a = await api(page);
  const status = await a.post<{ id: string }>(`/boards/${boardId}/columns`, { title: 'מצב', type: 'status' });
  const people = await a.post<{ id: string }>(`/boards/${boardId}/columns`, { title: 'אחראים', type: 'people' });
  const date = await a.post<{ id: string }>(`/boards/${boardId}/columns`, { title: 'מועד', type: 'date' });
  const second = await a.post<{ id: string }>(`/boards/${boardId}/groups`, { title: `קבוצה ב ${Date.now() % 1000}` });
  const board = await a.get<ApiBoard>(`/boards/${boardId}`);
  const labels = board.columns.find((c) => c.id === status.id)!.settings.labels!;
  const named = labels.filter((l) => l.label.trim());
  const [l1, l2] = [named[0]!, named[1]!];
  const secondTitle = board.groups.find((g) => g.id === second.id)!.title;
  const members = (await a.get<{ data: { user_id: string; name: string; status: string }[] }>('/users')).data;
  // Fix: grouped by people, "move to group" lists every active member — the local account has many
  // teammates with the same test name, so pick one whose name is unique (the menu item is found by name).
  const active = members.filter((m) => m.status === 'active' && m.name?.trim());
  const otherMember = active.find(
    (m) => m.user_id !== a.meId && active.filter((x) => x.name.trim() === m.name.trim()).length === 1,
  )!;
  const items = async () => (await a.get<{ data: ApiItem[] }>(`/boards/${boardId}/items`)).data;
  const find = async (name: string) => (await items()).find((i) => i.name === name)!;
  const cell = async (name: string, col: string) => (await find(name)).cells[col]?.value;
  const firstGroup = (await find('Alpha')).group_id;
  await a.put(`/items/${(await find('Alpha')).id}/cells/${status.id}`, { value: { index: l1.id } });
  await a.put(`/items/${(await find('Beta')).id}/cells/${status.id}`, { value: { index: l2.id } });
  await a.put(`/items/${(await find('Alpha')).id}/cells/${people.id}`, {
    value: { persons_and_teams: [{ id: a.meId, kind: 'person' }] },
  });
  await a.put(`/items/${(await find('Beta')).id}/cells/${people.id}`, {
    value: { persons_and_teams: [{ id: otherMember.user_id, kind: 'person' }] },
  });
  await page.reload();
  await expect(row(page, 'Gamma')).toBeVisible();

  // Status: every other value of the column is offered (Fix: all labels, not only the sections shown)
  // and "no value" — not Alpha's own (l1).
  await groupBy(page, 'מצב');
  await expect(page.getByTestId('board-section')).toHaveCount(3);
  let menu = await openMoveMenu(page, nameCell(page, 'Alpha'));
  await expect(menu.getByTestId('move-section')).toHaveCount(named.length);
  await expect(menu.getByRole('menuitem', { name: l1.label, exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: secondTitle })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: l2.label, exact: true }).click();
  await expect.poll(() => cell('Alpha', status.id)).toMatchObject({ index: l2.id });
  // The board groups did not change.
  expect((await find('Alpha')).group_id).toBe(firstGroup);
  // Ctrl+Z undoes it like the drag.
  await page.mouse.move(1, 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => cell('Alpha', status.id)).toMatchObject({ index: l1.id });
  // Into "no value" → cleared; Gamma (no value) → l1.
  menu = await openMoveMenu(page, nameCell(page, 'Beta'));
  await menu.getByRole('menuitem', { name: 'ללא ערך', exact: true }).click();
  await expect.poll(() => cell('Beta', status.id)).toBeFalsy();
  menu = await openMoveMenu(page, nameCell(page, 'Gamma'));
  await menu.getByRole('menuitem', { name: l1.label, exact: true }).click();
  await expect.poll(() => cell('Gamma', status.id)).toMatchObject({ index: l1.id });

  // People: Alpha (me) → the other member's section: Alpha's person is the other one.
  await groupBy(page, 'אחראים');
  await expect(page.getByTestId('board-section')).toHaveCount(3);
  menu = await openMoveMenu(page, nameCell(page, 'Alpha'));
  await menu.getByRole('menuitem', { name: otherMember.name, exact: true }).click();
  await expect
    .poll(async () => ((await cell('Alpha', people.id)) as { persons_and_teams?: { id: string }[] })?.persons_and_teams)
    .toEqual([{ id: otherMember.user_id, kind: 'person' }]);

  // Date sections are ranges: "move to group" is the board's groups again (a real group move).
  await groupBy(page, 'מועד');
  menu = await openMoveMenu(page, nameCell(page, 'Gamma'));
  await expect(menu.getByTestId('move-section')).toHaveCount(0);
  await menu.getByRole('menuitem', { name: secondTitle }).click();
  await expect.poll(async () => (await find('Gamma')).group_id).toBe(second.id);
  expect(await cell('Gamma', date.id)).toBeFalsy();
});

test('B: the item card ⋯ moves a sub-subitem one level up', async ({ page }) => {
  const boardId = await newBoard(page, ['P']);
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
      .sort((x, y) => (x.position < y.position ? -1 : 1))
      .map((i) => i.name);
  };
  const base = page.url().replace(/\?.*$/, '');

  // A first-level subitem: "make it an item" and, since, "move to item ▸" at every level.
  await page.goto(`${base}/i/${(await find('S')).id}`);
  await page.getByTestId('card-more').click();
  await expect(page.getByRole('menu').getByRole('menuitem', { name: 'הפיכה לפריט' })).toBeVisible();
  await expect(page.getByTestId('menu-tree')).toBeVisible();
  await page.keyboard.press('Escape');

  await page.goto(`${base}/i/${(await find('T')).id}`);
  await page.getByTestId('card-more').click();
  await page.getByTestId('menu-tree').click();
  await expect(page.getByTestId('menu-tree-up')).toBeVisible();
  await page.getByTestId('menu-tree-up').click();
  await expect.poll(() => under('P')).toEqual(['S', 'T', 'S2']);
  expect(await under('S')).toEqual([]);
  // The card stays open on it.
  await expect(page.getByTestId('card-more')).toBeVisible();
});
