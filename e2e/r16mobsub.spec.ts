// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Round 16 (r16mobsub, product decision): on a phone the board shows subitems inline — not only through the item's panel.
 * A row with subitems has a count + chevron; a tap opens them under it (the sub-board's own header row, indented
 * rows, "+ add subitem"), sub-subitems open too, the view's filter applies, and the cards layout has a count chip.
 * Measured at 390×844.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const encode = (q: unknown) => Buffer.from(JSON.stringify(q)).toString('base64url');
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `סאב מובייל ${tag}`, workspace_id: ws.id });
  const parent = await api<{ id: string }>('post', `/boards/${board.id}/items`, { name: `Parent ${tag}` });
  await api('post', `/boards/${board.id}/items`, { name: `Lonely ${tag}` });
  const open = await api<{ id: string }>('post', `/items/${parent.id}/subitems`, {
    name: `Open sub ${tag}`,
    cells: { status: { index: 0 } },
  });
  await api('post', `/items/${parent.id}/subitems`, { name: `Done sub ${tag}`, cells: { status: { index: 1 } } });
  await api('post', `/items/${open.id}/subitems`, { name: `Deep ${tag}` });
  return { board, tag, headers };
};

const expand = async (page: Page, name: string) => {
  const toggle = row(page, name).getByTestId('subitems-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
};

test.beforeEach(async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
});

test('phone table: expand subitems inline, nested levels, edit a cell, add a subitem', async ({ page }) => {
  const { board, tag } = await setup(page);
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(page.getByTestId('mobile-table')).toHaveAttribute('data-layout', 'table');

  // The count on the parent; no toggle on an item without subitems; closed on entry.
  const toggle = row(page, `Parent ${tag}`).getByTestId('subitems-toggle');
  await expect(toggle.getByTestId('subitems-count')).toHaveText('2');
  await expect(row(page, `Lonely ${tag}`).getByTestId('subitems-toggle')).toHaveCount(0);
  await expect(row(page, `Open sub ${tag}`)).toHaveCount(0);

  // Open: the sub-board's header row, then the subitems, indented, under the parent.
  await toggle.click();
  const subtree = page.getByTestId('mobile-subitems');
  await expect(subtree.getByTestId('mobile-subhead')).toBeVisible();
  await expect(row(page, `Open sub ${tag}`)).toHaveAttribute('data-depth', '1');
  await expect(row(page, `Done sub ${tag}`)).toBeVisible();
  const parentBox = (await row(page, `Parent ${tag}`).boundingBox())!;
  expect((await row(page, `Open sub ${tag}`).boundingBox())!.y).toBeGreaterThan(parentBox.y);
  const parentName = (await row(page, `Parent ${tag}`).getByText(`Parent ${tag}`).boundingBox())!;
  const subName = (await row(page, `Open sub ${tag}`).getByText(`Open sub ${tag}`).boundingBox())!;
  // Indented along the reading direction (RTL: the subitem's name ends further from the right edge).
  expect(Math.abs(parentName.x + parentName.width - (subName.x + subName.width))).toBeGreaterThan(4);

  // A sub-subitem opens one level further in.
  await row(page, `Open sub ${tag}`).getByTestId('subitems-toggle').click();
  await expect(row(page, `Deep ${tag}`)).toHaveAttribute('data-depth', '2');

  // A tap on a subitem's status cell opens its editor as a bottom sheet; the choice is saved.
  const status = row(page, `Done sub ${tag}`).locator('[data-column-type="status"]');
  await status.click();
  const sheet = page.getByTestId('popover');
  await expect(sheet).toHaveAttribute('data-sheet', 'true');
  await sheet.getByRole('button', { name: 'חסום', exact: true }).click();
  await expect(status).toContainText('חסום');

  // "+ add subitem" under the parent's subitems.
  const add = page.locator(`[data-testid="mobile-subadd"]`).last();
  await add.getByRole('textbox').fill(`New sub ${tag}`);
  await add.getByRole('textbox').press('Enter');
  await expect(row(page, `New sub ${tag}`)).toHaveAttribute('data-depth', '1');
  await expect(toggle.getByTestId('subitems-count')).toHaveText('3');

  // A tap on a subitem's name opens its card.
  await row(page, `Open sub ${tag}`).getByTestId('mobile-item-name').click();
  await expect(page).toHaveURL(/\/i\//);
  await page.getByRole('button', { name: 'סגירה' }).first().click();
  // Still open after the card closes.
  await expect(row(page, `Open sub ${tag}`)).toBeVisible();

  // Closing hides them again.
  await toggle.click();
  await expect(row(page, `Open sub ${tag}`)).toHaveCount(0);
});

test('phone table: a filter on a subitem column hides the done subitem', async ({ page }) => {
  const { board, tag } = await setup(page);
  const q = encode({
    filter: {
      kind: 'group',
      operator: 'and',
      rules: [{ column_id: 'sub:status', operator: 'is_not_done', values: [] }],
    },
  });
  await page.goto(`/a/demo/b/${board.id}?q=${q}`);
  await expect(row(page, `Parent ${tag}`)).toBeVisible();
  await expand(page, `Parent ${tag}`);
  await expect(row(page, `Open sub ${tag}`)).toBeVisible();
  await expect(row(page, `Done sub ${tag}`)).toHaveCount(0);
  await expect(row(page, `Parent ${tag}`).getByTestId('subitems-count')).toHaveText('1');
});

test('phone cards layout: a count chip opens a compact list of the subitems', async ({ page }) => {
  const { board, tag, headers } = await setup(page);
  const view = (await (
    await page.request.post(`/api/v1/boards/${board.id}/views`, {
      headers,
      data: { name: 'Cards', type: 'table', settings: { mobile_layout: 'cards' } },
    })
  ).json()) as { id: string };
  await page.goto(`/a/demo/b/${board.id}?view=${view.id}`);
  await expect(page.getByTestId('mobile-table')).toHaveAttribute('data-layout', 'cards');
  const chip = page.getByTestId('card-subitems-chip');
  await expect(chip).toHaveCount(1); // only the parent has subitems
  await chip.click();
  const list = page.getByTestId('card-subitems');
  await expect(list.locator(`[data-testid="card-subitem"][data-item-name="Open sub ${tag}"]`)).toBeVisible();
  await expect(list.locator(`[data-testid="card-subitem"][data-item-name="Done sub ${tag}"]`)).toBeVisible();
  // Nested: the open subitem's own subitem.
  await list
    .locator(`[data-testid="card-subitem"][data-item-name="Open sub ${tag}"]`)
    .getByTestId('subitems-toggle')
    .click();
  await expect(list.locator(`[data-testid="card-subitem"][data-item-name="Deep ${tag}"]`)).toHaveAttribute(
    'data-depth',
    '2',
  );
  // A tap on a subitem opens its card.
  await list
    .locator(`[data-testid="card-subitem"][data-item-name="Done sub ${tag}"]`)
    .getByTestId('mobile-item-name')
    .click();
  await expect(page).toHaveURL(/\/i\//);
});
