// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod fixes, round 18 (board):
 * 1. (option א): a subitem that fails the filter stays as the path to a matching sub-subitem — dimmed
 *    with a tooltip saying why.
 * 2.: the table looks continuous — the subitems table runs to the full width when it has fewer columns
 *    and the items' rows run to the subitems' width when those are wider.
 * 3.: on a phone the views show under the bar (f9 views: as one dropdown) and still open the views sheet.
 * 4.: the quick filter is ONE row that scrolls sideways instead of wrapping.
 * 5.: automations show subitem columns in their pickers and names (not raw keys / `{variables}`).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const encode = (q: unknown) => Buffer.from(JSON.stringify(q)).toString('base64url');
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

type Json = { id: string; [k: string]: unknown };

const setup = async (page: Page, name: string) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const api = async <T = Json>(method: 'get' | 'post' | 'patch' | 'delete', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api('post', '/boards', { name: `${name} ${tag}`, workspace_id: ws.id });
  return { api, board, tag, headers };
};

const expand = async (page: Page, name: string) => {
  const r = row(page, name);
  const toggle = r.getByTestId('subitems-toggle');
  if ((await toggle.getAttribute('aria-expanded')) === 'true') return;
  await r.hover();
  await toggle.click();
};

test('1: a subitem kept only as the path to a match is dimmed, with a tooltip', async ({ page }) => {
  const { api, board, tag } = await setup(page, 'r18 נתיב');
  const fixes = await api('post', `/boards/${board.id}/items`, { name: `Fixes ${tag}` });
  // s1 (Done) → s11 (Working); s2 (Working); s3 (Done).
  const s1 = await api('post', `/items/${fixes.id}/subitems`, { name: `S1 ${tag}`, cells: { status: { index: 1 } } });
  await api('post', `/items/${s1.id}/subitems`, { name: `S11 ${tag}`, cells: { status: { index: 0 } } });
  await api('post', `/items/${fixes.id}/subitems`, { name: `S2 ${tag}`, cells: { status: { index: 0 } } });
  await api('post', `/items/${fixes.id}/subitems`, { name: `S3 ${tag}`, cells: { status: { index: 1 } } });
  const q = encode({
    filter: {
      kind: 'group',
      operator: 'and',
      rules: [{ column_id: 'sub:status', operator: 'is_not_done', values: [] }],
    },
  });
  await page.goto(`/a/demo/b/${board.id}?q=${q}`);
  await expect(row(page, `Fixes ${tag}`)).toBeVisible();
  await expand(page, `Fixes ${tag}`);
  // The Done S1 stays (its child is open), dimmed; S2 matches by itself; S3 (Done, nothing under it) is hidden.
  await expect(row(page, `S1 ${tag}`)).toBeVisible();
  await expect(row(page, `S2 ${tag}`)).toBeVisible();
  await expect(row(page, `S3 ${tag}`)).toHaveCount(0);
  const dim = page.locator(`[data-testid="subitem-path-only"]`);
  await expect(dim).toHaveCount(1);
  await expect(dim).toHaveAttribute('data-path-only', s1.id);
  await expect(dim).toHaveAttribute('data-tip', /.+/);
  const opacity = await dim.evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(opacity).toBeLessThan(1);
  // Its matching child is full strength.
  await expand(page, `S1 ${tag}`);
  await expect(row(page, `S11 ${tag}`)).toBeVisible();
  const childOpacity = await row(page, `S11 ${tag}`).evaluate((el) => {
    let o = 1;
    for (let n: Element | null = el; n; n = n.parentElement) o *= Number(getComputedStyle(n).opacity);
    return o;
  });
  expect(childOpacity).toBe(1);
  // S2 is not dimmed.
  await expect(row(page, `S2 ${tag}`).locator('xpath=ancestor::*[@data-testid="subitem-path-only"]')).toHaveCount(0);
});

test('2: the subitems table and the items run to the same width, both ways', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  const { api, board, tag } = await setup(page, 'r18 רצף');
  const parent = await api('post', `/boards/${board.id}/items`, { name: `Parent ${tag}` });
  const sub = await api('post', `/items/${parent.id}/subitems`, { name: `Child ${tag}` });
  // The items get more columns than the subitems.
  for (const title of ['A', 'B', 'C', 'D', 'E'])
    await api('post', `/boards/${board.id}/columns`, { title: `${title} ${tag}`, type: 'text' });
  await page.goto(`/a/demo/b/${board.id}`);
  await expand(page, `Parent ${tag}`);
  await expect(row(page, `Child ${tag}`)).toBeVisible();
  const mainHead = page.getByTestId('group-header').first().getByTestId('header-row');
  const subHead = page.getByTestId('subhead').first().getByTestId('header-row');
  const edge = async () => {
    const m = (await mainHead.boundingBox())!;
    const s = (await subHead.boundingBox())!;
    // RTL: the rows' end is their left edge.
    return { main: m.x, sub: s.x, mainRight: m.x + m.width, subRight: s.x + s.width };
  };
  let e = await edge();
  expect(Math.abs(e.main - e.sub)).toBeLessThan(3);
  // The subitem row itself runs to the end too.
  const subRow = (await row(page, `Child ${tag}`).boundingBox())!;
  expect(Math.abs(subRow.x - e.main)).toBeLessThan(3);

  // Now the subitems get many more columns than the items: the items' header runs to their width.
  for (const title of ['P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'])
    await api('post', `/boards/${sub.board_id as string}/columns`, { title: `${title} ${tag}`, type: 'text' });
  await page.reload();
  await expand(page, `Parent ${tag}`);
  await expect(row(page, `Child ${tag}`)).toBeVisible();
  e = await edge();
  expect(Math.abs(e.main - e.sub)).toBeLessThan(3);
});

test('3: on a 360px phone the views are a dropdown under the bar, in every view', async ({ page }) => {
  // f9 views: the chips row became one dropdown (e2e/f9-views.spec.ts covers it in full).
  const { api, board, tag } = await setup(page, 'r18 תצוגות');
  await api('post', `/boards/${board.id}/items`, { name: `Row ${tag}` });
  await api('post', `/boards/${board.id}/views`, { name: `קנבן ${tag}`, type: 'kanban' });
  await api('post', `/boards/${board.id}/views`, { name: `לוח שנה ${tag}`, type: 'calendar' });
  await page.setViewportSize({ width: 360, height: 760 });
  await page.goto(`/a/demo/b/${board.id}`);
  const dropdown = page.getByTestId('mobile-view-dropdown');
  await expect(dropdown).toBeVisible();
  const box = (await dropdown.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(361);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(361);

  // The dropdown switches the view, and stays in the Kanban and Calendar views too.
  const menu = page.getByTestId('mobile-view-menu');
  for (const name of [`קנבן ${tag}`, `לוח שנה ${tag}`]) {
    await dropdown.click();
    await expect(menu.getByTestId('mobile-view-item')).toHaveCount(3);
    await menu.getByTestId('mobile-view-item').filter({ hasText: name }).click();
    await expect(page.getByTestId('mobile-view-switch')).toHaveAttribute('data-view-name', name);
    await expect(dropdown).toBeVisible();
    await expect(dropdown).toHaveAttribute('data-view-name', name);
  }
  // "All views" opens the views sheet (actions, + new view).
  await dropdown.click();
  await menu.getByTestId('mobile-view-manage').click();
  await expect(page.getByTestId('mobile-view-sheet')).toBeVisible();
  await expect(page.getByTestId('mobile-view-option')).toHaveCount(3);
});

test('4: the quick filter is one row that scrolls sideways', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 900 });
  const { api, board, tag } = await setup(page, 'r18 פילטר');
  await api('post', `/boards/${board.id}/items`, { name: `Row ${tag}` });
  for (const title of ['שלב', 'סוג', 'עדיפות', 'תחום', 'מצב', 'שלב 2', 'סוג 2', 'שלב 3'])
    await api('post', `/boards/${board.id}/columns`, { title: `${title} ${tag}`, type: 'status' });
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('toolbar-filter').click();
  // Prod (option B): every column is an entry of the side rail, one under the other, and the middle
  // shows one column's values at a time.
  const rail = page.getByTestId('filter-rail');
  await expect(rail).toBeVisible();
  const entries = rail.locator('[data-testid^="filter-rail-"]:not([data-testid="filter-rail-advanced"])');
  expect(await entries.count()).toBeGreaterThan(6);
  const lefts = await entries.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
  await expect(page.locator('[data-testid^="quick-"]:not([data-testid^="quick-search"])')).toHaveCount(1);
  await entries.nth(3).click();
  await expect(entries.nth(3)).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('[data-testid^="quick-"]:not([data-testid^="quick-search"])')).toHaveCount(1);
  // The advanced conditions are an entry of the same rail.
  await expect(rail.getByTestId('filter-rail-advanced')).toBeVisible();
});

test('5: automations list subitem people columns and read names, not keys', async ({ page }) => {
  const { api, board, tag } = await setup(page, 'r18 אוטומציות');
  const parent = await api('post', `/boards/${board.id}/items`, { name: `Parent ${tag}` });
  const sub = await api('post', `/items/${parent.id}/subitems`, { name: `Child ${tag}` });
  const subBoard = sub.board_id as string;
  const owner = await api('post', `/boards/${subBoard}/columns`, { title: `אחראי סאב ${tag}`, type: 'people' });
  const subDetail = await api<{ columns: { id: string; type: string; title: string }[] }>('get', `/boards/${subBoard}`);
  const subStatus =
    subDetail.columns.find((c) => c.type === 'status') ??
    ((await api('post', `/boards/${subBoard}/columns`, { title: `סטטוס ${tag}`, type: 'status' })) as unknown as {
      id: string;
      title: string;
    });
  await api('post', `/boards/${board.id}/automations`, {
    title: `סאב ${tag}`,
    is_active: false,
    recipe: {
      trigger: { type: 'subitem_status_changed', column: subStatus.id, labels: 'any', all_subitems: false },
      actions: [{ type: 'notify', to: `column:${owner.id}`, message: `{item.name} {item.${subStatus.id}}` }],
    },
  });
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('board-automations').click();
  await page
    .locator('[data-testid="automation-row"]', { hasText: `סאב ${tag}` })
    .getByTestId('automation-edit')
    .click();
  const builder = page.getByTestId('automation-builder');
  // The recipient reads as the subitem column's title, not `column:<key>`.
  const to = builder.locator('[data-slot="actions.0.to"]');
  await expect(to).toContainText(`אחראי סאב ${tag}`);
  await expect(to).not.toContainText(owner.id);
  // The message's variables are chips with names — no `{…}` keys.
  const message = builder.locator('[data-slot="actions.0.message"]');
  await expect(message.getByTestId('slot-var')).toHaveCount(2);
  await expect(message.getByTestId('slot-var').nth(1)).toHaveText(subStatus.title);
  await expect(message).not.toContainText('{');
  // The recipient picker lists the subitem's people column, under its section.
  await to.click();
  const people = page.getByTestId('slot-people');
  await expect(people.getByTestId('slot-col-section')).toBeVisible();
  await expect(people.getByTestId('slot-option').filter({ hasText: `אחראי סאב ${tag}` })).toBeVisible();
  await page.keyboard.press('Escape');
  // The message editor: variables of the subitem's columns, and a preview with chips.
  await message.click();
  await expect(page.locator(`[data-testid="slot-variable"][data-var="{item.${owner.id}}"]`)).toBeVisible();
  await expect(page.getByTestId('slot-text-preview').getByTestId('slot-var')).toHaveCount(2);
});
