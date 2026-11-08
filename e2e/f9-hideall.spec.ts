// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod bug: "hide all" in the toolbar's hide-columns panel did nothing on a board with subitems — the
 * panel set the board's and the subitems' hidden columns in one click and the second change dropped the first.
 * "Hide all" hides every column but the item name (board + subitem columns), the button counts them, "show all"
 * reverses it; both are unsaved view edits (the tab's dot + save bar), and the phone's tools sheet does the same.
 */
const api = (path: string) => `/api/v1${path}`;
const tag = () => Date.now().toString(36);
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
type Ctx = Awaited<ReturnType<typeof ownerContext>>;

const setup = async (page: Page, headers: Ctx['headers'], t: string) => {
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Hide all ${t}`, workspace_id: ws } })
  ).json()) as { id: string };
  const cols: string[] = [];
  for (const [type, title] of [
    ['text', `Note ${t}`],
    ['numbers', `Amount ${t}`],
  ] as const) {
    const c = (await (
      await page.request.post(api(`/boards/${board.id}/columns`), { headers, data: { type, title } })
    ).json()) as { id: string };
    cols.push(c.id);
  }
  const parent = (await (
    await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: `Parent ${t}` } })
  ).json()) as { id: string };
  await page.request.post(api(`/items/${parent.id}/subitems`), { headers, data: { name: `Child ${t}` } });
  const detail = (await (await page.request.get(api(`/boards/${board.id}`), { headers })).json()) as {
    subitems_board_id: string;
    columns: { id: string; type: string }[];
  };
  const sub = (await (
    await page.request.post(api(`/boards/${detail.subitems_board_id}/columns`), {
      headers,
      data: { type: 'text', title: `Sub note ${t}` },
    })
  ).json()) as { id: string };
  const all = ((await (await page.request.get(api(`/boards/${board.id}`), { headers })).json()) as typeof detail)
    .columns;
  const view = (await (
    await page.request.post(api(`/boards/${board.id}/views`), { headers, data: { name: `V ${t}`, type: 'table' } })
  ).json()) as { id: string };
  const subCols = (
    (await (await page.request.get(api(`/boards/${detail.subitems_board_id}`), { headers })).json()) as typeof detail
  ).columns;
  const nonName = (cs: typeof all) => cs.filter((c) => c.type !== 'name').map((c) => c.id);
  return { board, view, cols, sub: sub.id, hideable: nonName(all), subHideable: nonName(subCols) };
};

test('hide all hides every column but the name (subitem columns too), counts them; show all reverses', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const t = tag();
  const s = await setup(page, headers, t);

  await page.goto(`/a/demo/b/${s.board.id}?view=${s.view.id}`);
  await expect(row(page, `Parent ${t}`)).toBeVisible();
  await row(page, `Parent ${t}`).hover();
  await row(page, `Parent ${t}`).getByTestId('subitems-toggle').click();
  const subHeader = page.getByTestId('subhead').locator(`[data-header="${s.sub}"]`);
  await expect(subHeader).toBeVisible();
  for (const id of s.cols) await expect(page.locator(`[data-header="${id}"]`).first()).toBeVisible();
  await expect(page.getByTestId('save-bar')).toHaveCount(0);

  await page.getByTestId('toolbar-hide').click();
  await page.getByTestId('hide-hide-all').click();
  // Every row in the panel is unchecked, the subitem section counts its column.
  for (const box of await page.getByTestId('hide-panel').getByRole('checkbox').all())
    await expect(box).not.toBeChecked();
  await expect(page.getByTestId('hide-sub-count')).toBeVisible();
  await page.keyboard.press('Escape');

  for (const id of s.cols) await expect(page.locator(`[data-header="${id}"]`)).toHaveCount(0);
  await expect(subHeader).toHaveCount(0);
  // The name column stays.
  await expect(row(page, `Parent ${t}`)).toBeVisible();
  await expect(page.getByTestId('toolbar-hide')).toContainText(String(s.hideable.length + s.subHideable.length));
  // An unsaved view edit: the save bar shows.
  await expect(page.getByTestId('save-bar')).toBeVisible();

  await page.getByTestId('toolbar-hide').click();
  await page.getByTestId('hide-show-all').click();
  await page.keyboard.press('Escape');
  for (const id of s.cols) await expect(page.locator(`[data-header="${id}"]`).first()).toBeVisible();
  await expect(subHeader).toBeVisible();
  await expect(page.getByTestId('toolbar-hide')).not.toContainText(/\d/);
  // Back to the saved view: no unsaved change.
  await expect(page.getByTestId('save-bar')).toHaveCount(0);

  // Hide all again and save: both lists are saved with the view.
  await page.getByTestId('toolbar-hide').click();
  await page.getByTestId('hide-hide-all').click();
  await page.keyboard.press('Escape');
  await page.getByTestId('view-save').click();
  await expect
    .poll(async () => {
      const v = (await (await page.request.get(api(`/boards/${s.board.id}/views`), { headers })).json()) as {
        data: { id: string; settings: { hidden_columns?: string[]; subitems_hidden_columns?: string[] } }[];
      };
      const mine = v.data.find((x) => x.id === s.view.id)?.settings;
      return [(mine?.hidden_columns ?? []).length, (mine?.subitems_hidden_columns ?? []).length];
    })
    .toEqual([s.hideable.length, s.subHideable.length]);
});

test('phone: hide all / show all from the tools sheet', async ({ page }) => {
  forbidNativeDialogs(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  const { headers } = await ownerContext(page);
  const t = tag();
  const s = await setup(page, headers, t);

  await page.goto(`/a/demo/b/${s.board.id}?view=${s.view.id}`);
  await expect(page.getByTestId('mobile-table')).toBeVisible();
  for (const id of s.cols) await expect(page.locator(`[data-header="${id}"]`).first()).toBeAttached();

  await page.getByTestId('mobile-filter-open').click();
  await page.getByTestId('mobile-filter-sheet').getByTestId('toolbar-hide').click();
  await page.getByTestId('hide-hide-all').click();
  for (const id of s.cols) await expect(page.locator(`[data-header="${id}"]`)).toHaveCount(0);
  await page.getByTestId('hide-show-all').click();
  for (const id of s.cols) await expect(page.locator(`[data-header="${id}"]`).first()).toBeAttached();
});
