// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * r27 —
 * A. (sent back): on a phone, the one-tap add of a computed-name board / sub-board only creates — the card
 *    does not open; the new row shows (scrolled to, lit) with a small toast. A tap on its name opens it.
 * 1. The automation action menu names "generate image" (no raw `auto.kind.generate_image`).
 * 5. "Run a test" previews group names, "בעלי הבורד" and column titles — not group ids, `@board_owners`,
 *    `column:<key>`.
 * 7. A numbers widget with a ₪ prefix over a column with the ₪ unit shows ₪ once.
 */
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

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

test('A: phone one-tap add creates the item and subitem without opening the card', async ({ page }) => {
  test.setTimeout(120_000);
  const { call, ws, tag } = await setup(page);
  const board = await call('post', '/boards', { name: `r27 מחושב ${tag}`, workspace_id: ws.id });
  const text = await call('post', `/boards/${board.id}/columns`, { title: `מקור ${tag}`, type: 'text' });
  await call('put', `/boards/${board.id}/name-source`, { mode: 'column', column_id: text.id });
  const parent = await call('post', `/boards/${board.id}/items`, {});
  await call('post', `/items/${parent.id}/subitems`, { name: `first ${tag}` });
  const detail = await call('get', `/boards/${board.id}`);
  const subId = detail.subitems_board_id as string;
  const subText = await call('post', `/boards/${subId}/columns`, { title: `מקור תת ${tag}`, type: 'text' });
  await call('put', `/boards/${subId}/name-source`, { mode: 'column', column_id: subText.id });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(page.getByTestId('mobile-table')).toBeVisible();
  const url = page.url();
  const before = await page.getByTestId('item-row').count();

  // One tap: a new row, a toast — the card stays closed and the URL does not change.
  await page.getByTestId('mobile-add-computed-item').first().click();
  await expect(page.getByTestId('item-row')).toHaveCount(before + 1);
  await expect(page.getByTestId('toast').first()).toBeVisible();
  await expect(page.getByTestId('item-card')).toHaveCount(0);
  expect(page.url()).toBe(url);

  // Subitems: the same — created, not opened.
  const parentRow = page.locator(`[data-testid="item-row"][data-item-id="${parent.id}"]`);
  const toggle = parentRow.getByTestId('subitems-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const subRows = page.getByTestId('mobile-subitems').getByTestId('item-row');
  const subBefore = await subRows.count();
  await page.getByTestId('mobile-add-computed-subitem').first().click();
  await expect(subRows).toHaveCount(subBefore + 1);
  await expect(page.getByTestId('item-card')).toHaveCount(0);
  expect(page.url()).toBe(url);

  // A tap on a name still opens the card.
  await page.getByTestId('mobile-item-name').first().click();
  await expect(page).toHaveURL(/\/i\//);
});

test('1: the action menu names "generate image"', async ({ page }) => {
  const { call, ws, tag } = await setup(page);
  const board = await call('post', '/boards', { name: `r27 פעולות ${tag}`, workspace_id: ws.id });
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  await page.getByTestId('auto-custom').click();
  const builder = page.getByTestId('automation-builder');
  await builder.getByTestId('auto-add-action').click();
  const entry = page.getByTestId('auto-action-generate_image');
  await expect(entry).toBeVisible();
  await expect(entry).not.toContainText('auto.kind');
  await expect(entry).toContainText('תמונה');
  await expect(page.getByRole('menu')).not.toContainText('auto.kind.');
});

test('5: "run a test" reads group names, people and columns by name', async ({ page }) => {
  test.setTimeout(90_000);
  const { call, ws, tag } = await setup(page);
  const board = await call('post', '/boards', { name: `r27 בדיקה ${tag}`, workspace_id: ws.id });
  const owner = await call('post', `/boards/${board.id}/columns`, { title: `אחראי ${tag}`, type: 'people' });
  const detail = await call('get', `/boards/${board.id}`);
  const group = (detail.groups as Json[])[0]!;
  await call('post', `/boards/${board.id}/items`, { name: `Alpha ${tag}` });
  await call('post', `/boards/${board.id}/automations`, {
    title: `בדיקה ${tag}`,
    is_active: false,
    recipe: {
      trigger: { type: 'item_created' },
      actions: [
        { type: 'move_to_group', group: group.id },
        { type: 'notify', to: ['@board_owners', `column:${owner.id}`], message: 'hi {item.name}' },
      ],
    },
  });
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('board-automations').click();
  await page
    .locator('[data-testid="automation-row"]', { hasText: `בדיקה ${tag}` })
    .getByTestId('automation-test')
    .click();
  await page.getByTestId('auto-test-search').fill('Alpha');
  await page.locator(`[data-testid="auto-test-hit"][data-name="Alpha ${tag}"]`).click();
  await page.getByTestId('auto-test-preview').click();
  const result = page.getByTestId('auto-test-result');
  await expect(result).toBeVisible();
  const groupField = result.locator('[data-testid="auto-test-rendered"][data-field="group"]');
  await expect(groupField).toHaveText(group.title as string);
  const to = result.locator('[data-testid="auto-test-rendered"][data-field="to"]');
  await expect(to).toContainText('בעלי הבורד');
  await expect(to).toContainText(`אחראי ${tag}`);
  await expect(result).not.toContainText('@board_owners');
  await expect(result).not.toContainText('column:');
  await expect(result).not.toContainText(group.id as string);
  await expect(result.locator('[data-testid="auto-test-rendered"][data-field="message"]')).toHaveText(
    `hi Alpha ${tag}`,
  );
});

test('7: a ₪ prefix over a ₪ column shows the unit once', async ({ page }) => {
  const { call, ws, tag } = await setup(page);
  const board = await call('post', '/boards', { name: `r27 ש"ח ${tag}`, workspace_id: ws.id });
  const amount = await call('post', `/boards/${board.id}/columns`, {
    title: `סכום ${tag}`,
    type: 'numbers',
    settings: { unit: { symbol: '₪', direction: 'left' } },
  });
  await call('post', `/boards/${board.id}/items`, { name: `a ${tag}`, cells: { [amount.id]: 1200 } });
  const dash = await call('post', `/workspaces/${ws.id}/dashboards`, {
    name: `r27 דשבורד ${tag}`,
    kind: 'main',
    board_ids: [board.id],
  });
  await call('post', `/dashboards/${dash.id}/widgets`, {
    type: 'numbers',
    title: 'סך הכול',
    settings: { measure: { fn: 'sum', column: { type: 'numbers', title: `סכום ${tag}` } }, prefix: '₪' },
  });
  await page.goto(`/a/demo/dash/${dash.id}`);
  const number = page.locator('[data-testid="widget"][data-type="numbers"]').first().getByTestId('widget-number');
  await expect(number).toHaveAttribute('data-value', '1200');
  await expect(number).toContainText('₪');
  await expect(number).not.toContainText('₪₪');
  expect(((await number.textContent()) ?? '').split('₪').length - 1).toBe(1);
});
