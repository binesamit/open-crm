// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn, pickGroupColumn } from './helpers';

/**
 * Product decision: in a view grouped by a column, an item added inside a section gets that section's value —
 * grouped by "שלב", the "+ add item" of section "פיתוח" creates an item whose שלב is פיתוח, shown in that section
 * right away. The empty section leaves it empty; the row menu's "add item below" does the same.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const nameCell = (page: Page, name: string) => row(page, name).first().locator('[data-cell="-1"]');

type ApiItem = {
  id: string;
  name: string;
  group_id: string | null;
  cells: Record<string, { value: unknown } | undefined>;
};
type ApiBoard = { columns: { id: string; settings: { labels?: { id: number; label: string }[] } }[] };

const api = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const get = async <T>(path: string) => (await (await page.request.get(`/api/v1${path}`, { headers })).json()) as T;
  const post = async <T>(path: string, data: unknown) =>
    (await (await page.request.post(`/api/v1${path}`, { headers, data })).json()) as T;
  const put = async (path: string, data: unknown) => {
    const res = await page.request.put(`/api/v1${path}`, { headers, data });
    expect(res.ok()).toBe(true);
  };
  return { get, post, put };
};

const newBoard = async (page: Page, items: string[]) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `grpfill ${Date.now().toString(36)}`;
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

const groupBy = async (page: Page, title: string) => {
  await page.getByTestId('toolbar-group').click();
  await pickGroupColumn(page, title);
  await page.keyboard.press('Escape');
};

/** The section key each row is shown under, in screen order. */
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

test('grouped by status: "+ add item" in a section sets its value; the empty section leaves it empty', async ({
  page,
}) => {
  const boardId = await newBoard(page, ['Alpha', 'Beta', 'Gamma']);
  const a = await api(page);
  const stage = await a.post<{ id: string }>(`/boards/${boardId}/columns`, { title: 'שלב', type: 'status' });
  const board = await a.get<ApiBoard>(`/boards/${boardId}`);
  const [l1, l2] = board.columns.find((c) => c.id === stage.id)!.settings.labels!;
  const items = async () => (await a.get<{ data: ApiItem[] }>(`/boards/${boardId}/items`)).data;
  const id = async (name: string) => (await items()).find((i) => i.name === name)!.id;
  const value = async (name: string) => (await items()).find((i) => i.name === name)?.cells[stage.id]?.value;
  await a.put(`/items/${await id('Alpha')}/cells/${stage.id}`, { value: { index: l1!.id } });
  await a.put(`/items/${await id('Beta')}/cells/${stage.id}`, { value: { index: l2!.id } });
  await page.reload();
  await expect(row(page, 'Gamma')).toBeVisible();

  await groupBy(page, 'שלב');
  await expect(page.getByTestId('board-section')).toHaveCount(3);
  const adds = page.getByPlaceholder(/\+ הוספת/);
  await expect(adds).toHaveCount(3);

  // Section 2 (Beta's label): the new item gets that label and shows in that section at once.
  await adds.nth(1).fill('Delta');
  await adds.nth(1).press('Enter');
  await expect(row(page, 'Delta')).toBeVisible();
  await expect.poll(() => value('Delta')).toMatchObject({ index: l2!.id });
  expect(await sectionOf(page, 'Delta')).toBe(await sectionOf(page, 'Beta'));

  // The empty section: no value.
  await adds.nth(2).fill('Epsilon');
  await adds.nth(2).press('Enter');
  await expect(row(page, 'Epsilon')).toBeVisible();
  expect(await sectionOf(page, 'Epsilon')).toBe(await sectionOf(page, 'Gamma'));
  expect(await value('Epsilon')).toBeFalsy();

  // The row menu's "add item below" in section 1: the new item gets Alpha's label.
  const before = (await items()).length;
  await expect(async () => {
    await nameCell(page, 'Alpha').click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: /מתחת/ }).first()).toBeVisible({ timeout: 1000 });
  }).toPass();
  await page.getByRole('menuitem', { name: /מתחת/ }).first().click();
  await expect.poll(async () => (await items()).length).toBe(before + 1);
  const added = (await items()).find((i) => !['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].includes(i.name))!;
  expect(added.cells[stage.id]?.value).toMatchObject({ index: l1!.id });

  // After a reload the value is still there (server side).
  await page.reload();
  await expect(row(page, 'Delta')).toBeVisible();
  expect(await value('Delta')).toMatchObject({ index: l2!.id });
  // One board group for all of them: the grouping is the view's, not the board's groups.
  expect(new Set((await items()).map((i) => i.group_id)).size).toBe(1);
});

test('grouped by a text column: the new item copies the section text (casing kept)', async ({ page }) => {
  const boardId = await newBoard(page, ['One', 'Two']);
  const a = await api(page);
  const txt = await a.post<{ id: string }>(`/boards/${boardId}/columns`, { title: 'צוות', type: 'text' });
  const items = async () => (await a.get<{ data: ApiItem[] }>(`/boards/${boardId}/items`)).data;
  const id = async (name: string) => (await items()).find((i) => i.name === name)!.id;
  await a.put(`/items/${await id('One')}/cells/${txt.id}`, { value: 'Team Red' });
  await page.reload();
  await expect(row(page, 'Two')).toBeVisible();

  await groupBy(page, 'צוות');
  await expect(page.getByTestId('board-section')).toHaveCount(2);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Three');
  await add.press('Enter');
  await expect(row(page, 'Three')).toBeVisible();
  await expect.poll(async () => (await items()).find((i) => i.name === 'Three')?.cells[txt.id]?.value).toBe('Team Red');
  expect(await sectionOf(page, 'Three')).toBe(await sectionOf(page, 'One'));
});
