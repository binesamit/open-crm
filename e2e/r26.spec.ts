// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * r26 —
 * 1.: on a phone, a board / sub-board whose item name is computed (name source) adds with one tap — no name
 *    field, no keyboard; the server names it (r27: the card no longer opens — e2e/r27.spec.ts).
 * 2.: a timeline whose end date has passed is red (the overdue red), unless its linked status column
 *    (column settings) is on a done label; the setting can turn the red off.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * 86_400_000));

const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const call = async (method: 'get' | 'post' | 'put' | 'patch', path: string, data?: unknown) => {
    const res = await page.request[method](`/api/v1${path}`, { headers, data });
    expect(res.ok(), `${method} ${path}: ${await res.text()}`).toBeTruthy();
    return (await res.json()) as Json;
  };
  const ws = ((await call('get', '/workspaces')) as { data: Json[] }).data[0]!;
  return { call, ws, tag: uid() };
};

test('phone: a computed-name board adds an item and a subitem without a name field', async ({ page }) => {
  test.setTimeout(120_000);
  const { call, ws, tag } = await setup(page);
  const board = await call('post', '/boards', { name: `שם מחושב ${tag}`, workspace_id: ws.id });
  const text = await call('post', `/boards/${board.id}/columns`, { title: `מקור ${tag}`, type: 'text' });
  await call('put', `/boards/${board.id}/name-source`, { mode: 'column', column_id: text.id });
  const parent = await call('post', `/boards/${board.id}/items`, {});
  // A sub-board that computes names too.
  await call('post', `/items/${parent.id}/subitems`, { name: `first ${tag}` });
  const detail = await call('get', `/boards/${board.id}`);
  const subId = detail.subitems_board_id as string;
  const subText = await call('post', `/boards/${subId}/columns`, { title: `מקור תת ${tag}`, type: 'text' });
  await call('put', `/boards/${subId}/name-source`, { mode: 'column', column_id: subText.id });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(page.getByTestId('mobile-table')).toBeVisible();
  const before = await page.getByTestId('item-row').count();

  // "+ new item" is a button, not a field — no keyboard; a tap creates the item (r27: without opening it).
  const add = page.getByTestId('mobile-add-computed-item').first();
  await expect(add).toBeVisible();
  await expect(page.getByTestId('mobile-table').locator('input[placeholder]')).toHaveCount(0);
  await add.click();
  await expect(page.locator('input:focus, textarea:focus')).toHaveCount(0);
  await expect(page.getByTestId('item-row')).toHaveCount(before + 1);

  // Subitems: expand the parent; "+ add subitem" is a button too.
  const parentRow = page.locator(`[data-testid="item-row"][data-item-id="${parent.id}"]`);
  const toggle = parentRow.getByTestId('subitems-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const subAdd = page.getByTestId('mobile-add-computed-subitem').first();
  await expect(subAdd).toBeVisible();
  await expect(page.getByTestId('mobile-subadd').locator('input')).toHaveCount(0);
  await subAdd.click();
  await expect(page).not.toHaveURL(/\/i\//);

  // The cards layout: the same one-tap add.
  // The main table's settings are fixed for the API (main_table_is_fixed): the layout is switched in the view
  // settings (the tools sheet), as a phone user does.
  await page.getByTestId('mobile-filter-open').click();
  await page.getByTestId('mobile-filter-sheet').getByTestId('toolbar-view-settings').click();
  await page.getByTestId('view-mobile-layout').click();
  await page.getByRole('menuitemradio', { name: 'כרטיסים' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('mobile-table')).toHaveAttribute('data-layout', 'cards');
  await expect(page.getByTestId('mobile-add-computed-item').first()).toBeVisible();
});

test('timeline: overdue is red; a linked status on a done label is not; the setting turns it off', async ({ page }) => {
  test.setTimeout(120_000);
  const { call, ws, tag } = await setup(page);
  const board = await call('post', '/boards', { name: `ציר באיחור ${tag}`, workspace_id: ws.id });
  const status = await call('post', `/boards/${board.id}/columns`, { title: `סטטוס ${tag}`, type: 'status' });
  const tl = await call('post', `/boards/${board.id}/columns`, { title: `ציר ${tag}`, type: 'timeline' });
  const late = await call('post', `/boards/${board.id}/items`, { name: `Late ${tag}` });
  const done = await call('post', `/boards/${board.id}/items`, { name: `Done ${tag}` });
  const future = await call('post', `/boards/${board.id}/items`, { name: `Future ${tag}` });
  const past = { from: daysAgo(10), to: daysAgo(3) };
  await call('put', `/items/${late.id}/cells/${tl.id}`, { value: past });
  await call('put', `/items/${done.id}/cells/${tl.id}`, { value: past });
  await call('put', `/items/${future.id}/cells/${tl.id}`, { value: { from: daysAgo(1), to: daysAgo(-5) } });
  // The default labels: 1 = done (is_done).
  await call('put', `/items/${done.id}/cells/${status.id}`, { value: { index: 1 } });

  const pill = (itemId: string) => page.locator(`[data-item-id="${itemId}"]`).getByTestId('timeline-pill').first();
  await page.goto(`/a/demo/b/${board.id}`);
  // No linked status: overdue = the end date passed (done too).
  await expect(pill(late.id)).toHaveAttribute('data-overdue', 'true');
  await expect(pill(done.id)).toHaveAttribute('data-overdue', 'true');
  await expect(pill(future.id)).not.toHaveAttribute('data-overdue', 'true');
  const bg = await pill(late.id).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).toBe('rgb(255, 26, 53)'); // our "blocked" colour (crimson)
  // Product decision: the timeline cell's text is regular weight, never bold.
  await expect(pill(late.id)).toHaveCSS('font-weight', '400');

  // Column settings: link the status column (its done labels pre-chosen) → the done item is no longer red.
  await page.locator(`[data-header="${tl.id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /הגדרות|settings/i }).click();
  await expect(page.getByTestId('timeline-overdue-red')).toBeVisible();
  await page.getByTestId('timeline-status-column').click();
  await page.getByTestId(`timeline-status-${status.id}`).click();
  await expect(page.getByTestId('timeline-done-1')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('timeline-done-0')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('column-settings-save').click();
  await expect(page.getByTestId('column-settings-save')).toHaveCount(0);
  await expect(pill(done.id)).not.toHaveAttribute('data-overdue', 'true');
  await expect(pill(late.id)).toHaveAttribute('data-overdue', 'true');

  // The red can be turned off.
  await call('patch', `/boards/${board.id}/columns/${tl.id}`, { settings: { overdue_red: false } });
  await page.reload();
  await expect(pill(late.id)).not.toHaveAttribute('data-overdue', 'true');
});
