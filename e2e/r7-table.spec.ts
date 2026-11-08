// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn } from './helpers';

/**
 * Fix: (table): subitems and sub-subitems reorder inside the same parent (handle and long press, saved,
 * Ctrl+Z undoes); a long press on the name cell drags items, subitems and sub-subitems — with real mouse events —
 * while a quick click still renames; every group has its own header row under its name (sticky while its rows
 * scroll); a collapsed group is one framed box with its count and column summaries.
 */
const SCRATCH = process.env.R7_SCRATCH ?? 'e2e/.scratch';

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const nameCell = (page: Page, name: string) => row(page, name).locator('[data-cell="-1"]');

const newBoard = async (page: Page, items: string[]) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `סבב7 ${Date.now().toString(36)}`;
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

/** Opens `parent`'s subitems and adds `names` (the first open "+ add subitem" field is the deepest one opened). */
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

/** Top-to-bottom order of rows by name, as shown. */
const order = async (page: Page, names: string[]) => {
  const ys = await Promise.all(names.map(async (n) => [n, (await row(page, n).boundingBox())!.y] as const));
  return ys.sort((a, b) => a[1] - b[1]).map(([n]) => n);
};

/** The saved order of a parent's subitems (the API, by position). */
const savedOrder = async (page: Page, boardId: string, parent: string) => {
  const { headers } = await ownerContext(page);
  type Row = { id: string; name: string; parent_item_id: string | null; position: string };
  const get = async <T>(path: string) => (await (await page.request.get(`/api/v1${path}`, { headers })).json()) as T;
  const board = await get<{ subitems_board_id: string }>(`/boards/${boardId}`);
  const subs = (await get<{ data: Row[] }>(`/boards/${board.subitems_board_id}/items`)).data;
  const main = (await get<{ data: Row[] }>(`/boards/${boardId}/items`)).data;
  const parentId = [...main, ...subs].find((i) => i.name === parent)!.id;
  return subs
    .filter((s) => s.parent_item_id === parentId)
    .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
    .map((s) => s.name);
};

const centre = (b: { x: number; y: number; width: number; height: number }, fy = 0.5) => ({
  x: b.x + Math.min(b.width / 2, 80),
  y: b.y + b.height * fy,
});

/** Real mouse: press `from`, optionally hold, move in steps onto `target` (fy = fraction of its height), let go. */
const mouseDrag = async (page: Page, from: Locator, target: Locator, fy: number, hold: number) => {
  const a = centre((await from.boundingBox())!);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  if (hold) await page.waitForTimeout(hold);
  await page.mouse.move(a.x + 3, a.y + 5, { steps: 3 });
  const b = centre((await target.boundingBox())!, fy);
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(150);
};

/** Long press on the row's name text (the row lifts — checked), then drop on `target`'s name cell. */
const longPressDrag = async (page: Page, name: string, target: string, fy: number) => {
  const cell = nameCell(page, name);
  const text = cell.getByText(name, { exact: true });
  const a = centre((await text.boundingBox())!);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.waitForTimeout(500);
  // Armed: the row is lifted (a copy follows the pointer) before it moves at all.
  await expect(cell).toHaveAttribute('data-armed', 'true');
  await expect(page.getByTestId('row-drag-overlay')).toBeVisible();
  await page.mouse.move(a.x + 3, a.y + 5, { steps: 3 });
  const b = centre((await nameCell(page, target).boundingBox())!, fy);
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  await page.waitForTimeout(150);
  await expect(page.getByTestId('row-drag-overlay')).toHaveCount(0);
};

/** By the ⋮⋮ handle (no hold). */
const handleDrag = async (page: Page, name: string, target: string, fy: number) => {
  await row(page, name).hover();
  const handle = row(page, name).locator('[data-drag-handle]');
  await mouseDrag(page, handle, nameCell(page, target), fy, 0);
};

test('subitems and sub-subitems reorder inside their parent (handle and long press), saved, undoable', async ({
  page,
}) => {
  const boardId = await newBoard(page, ['P']);
  await addSubitems(page, 'P', ['S1', 'S2', 'S3']);
  await addSubitems(page, 'S1', ['T1', 'T2', 'T3']);

  // Subitems: S3 by its handle onto the top half of S1 → first.
  await handleDrag(page, 'S3', 'S1', 0.2);
  await expect.poll(() => savedOrder(page, boardId, 'P')).toEqual(['S3', 'S1', 'S2']);
  await expect.poll(() => order(page, ['S1', 'S2', 'S3'])).toEqual(['S3', 'S1', 'S2']);

  // Ctrl+Z puts it back.
  await page.mouse.move(1, 1);
  await page.keyboard.press('Control+z');
  await expect.poll(() => savedOrder(page, boardId, 'P')).toEqual(['S1', 'S2', 'S3']);

  // Sub-subitems: T1 by its handle onto the bottom half of T3 → last.
  await handleDrag(page, 'T1', 'T3', 0.8);
  await expect.poll(() => savedOrder(page, boardId, 'S1')).toEqual(['T2', 'T3', 'T1']);
  await expect.poll(() => order(page, ['T1', 'T2', 'T3'])).toEqual(['T2', 'T3', 'T1']);

  // Long press works the same inside the parent: S2 onto the top half of S1, T1 onto the top half of T2.
  await longPressDrag(page, 'S2', 'S1', 0.2);
  await expect.poll(() => savedOrder(page, boardId, 'P')).toEqual(['S2', 'S1', 'S3']);
  await longPressDrag(page, 'T1', 'T2', 0.2);
  await expect.poll(() => savedOrder(page, boardId, 'S1')).toEqual(['T1', 'T2', 'T3']);

  // Kept after a reload.
  await page.reload();
  await row(page, 'P').getByTestId('subitems-toggle').click();
  await row(page, 'S1').getByTestId('subitems-toggle').click();
  await expect(row(page, 'T3')).toBeVisible();
  expect(await order(page, ['S1', 'S2', 'S3'])).toEqual(['S2', 'S1', 'S3']);
  expect(await order(page, ['T1', 'T2', 'T3'])).toEqual(['T1', 'T2', 'T3']);
});

test('a long press on the name drags items, subitems and sub-subitems; a quick click still renames', async ({
  page,
}) => {
  const boardId = await newBoard(page, ['I1', 'I2', 'I3']);

  // Items: I3 held on its name and dropped on the top half of I1 → first.
  await longPressDrag(page, 'I3', 'I1', 0.2);
  await expect.poll(() => order(page, ['I1', 'I2', 'I3'])).toEqual(['I3', 'I1', 'I2']);

  // A quick click on the name still renames (no drag).
  await row(page, 'I2').getByText('I2', { exact: true }).click();
  const field = row(page, 'I2').getByRole('textbox');
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('row-drag-overlay')).toHaveCount(0);

  // A hold that ends without moving neither renames nor drops anything.
  const cell = nameCell(page, 'I1');
  const b = centre((await cell.getByText('I1', { exact: true }).boundingBox())!);
  await page.mouse.move(b.x, b.y);
  await page.mouse.down();
  await page.waitForTimeout(500);
  await expect(cell).toHaveAttribute('data-armed', 'true');
  await page.mouse.up();
  await expect(cell).not.toHaveAttribute('data-armed', 'true');
  await expect(row(page, 'I1').getByRole('textbox')).toHaveCount(0);
  expect(await order(page, ['I1', 'I2', 'I3'])).toEqual(['I3', 'I1', 'I2']);

  // Subitems: S2 held and dropped on the top half of S1 (same parent) → first.
  await addSubitems(page, 'I2', ['S1', 'S2']);
  await longPressDrag(page, 'S2', 'S1', 0.2);
  await expect.poll(() => savedOrder(page, boardId, 'I2')).toEqual(['S2', 'S1']);

  // Sub-subitems: under S1, U2 onto the top half of U1 → first.
  await addSubitems(page, 'S1', ['U1', 'U2']);
  await longPressDrag(page, 'U2', 'U1', 0.2);
  await expect.poll(() => savedOrder(page, boardId, 'S1')).toEqual(['U2', 'U1']);

  // A quick click on a subitem's name renames it too.
  await row(page, 'U1').getByText('U1', { exact: true }).click();
  await expect(row(page, 'U1').getByRole('textbox')).toBeFocused();
  await page.keyboard.press('Escape');
});

test('groups: a header row per group under its name; sticky while its rows scroll; collapsed = framed box', async ({
  page,
}) => {
  const items = Array.from({ length: 24 }, (_, i) => `R${i + 1}`);
  await newBoard(page, items);
  for (const type of ['סטטוס', 'מספרים']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
    await expect(page.getByTestId('group-header').first().locator('[data-header]', { hasText: type })).toBeVisible();
  }
  for (const [name, n] of [
    ['R1', '5'],
    ['R2', '7'],
  ] as const) {
    await row(page, name).locator('[data-column-type="numbers"] > *').first().click();
    await page.keyboard.type(n);
    await page.keyboard.press('Enter');
    await expect(row(page, name).locator('[data-column-type="numbers"]')).toHaveText(n);
  }
  for (const [name, label] of [
    ['R1', 'בתהליך'],
    ['R2', 'הושלם'],
    ['R3', 'בתהליך'],
  ] as const) {
    await row(page, name).locator('[data-column-type="status"] button').first().click();
    await page.getByTestId('popover').getByRole('button', { name: label, exact: true }).click();
    await expect(row(page, name).locator('[data-column-type="status"]')).toHaveText(label);
  }
  await page.getByTestId('add-group-open').click();
  await page.getByTestId('add-group-name').fill('שנייה');
  await page.getByTestId('add-group-submit').click();
  await expect(page.getByTestId('board-section')).toHaveCount(2);

  // Each open group: name line, then its own header row, then its rows.
  await expect(page.getByTestId('group-header')).toHaveCount(2);
  const title = (await page.getByTestId('board-section').first().boundingBox())!;
  const head = (await page.getByTestId('group-header').first().boundingBox())!;
  expect(head.y).toBeGreaterThan(title.y + title.height - 2);
  expect((await row(page, 'R1').boundingBox())!.y).toBeGreaterThan(head.y);
  // Column menus work from the second group's header too.
  const second = page.getByTestId('group-header').nth(1).locator('[data-header]', { hasText: 'מספרים' });
  await second.hover();
  await second.getByRole('button', { name: /פעולות לעמודה/ }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.keyboard.press('Escape');

  // Scrolled into the first group: its header row sticks to the top, lined up with the cells.
  await page.getByTestId('board-table').evaluate((el) => {
    const scroller = el.parentElement!;
    scroller.scrollTop = 500;
  });
  const stuck = page.getByTestId('sticky-header');
  await expect(stuck).toBeVisible();
  const th = (await stuck.locator('[data-header]', { hasText: 'מספרים' }).boundingBox())!;
  const td = (await row(page, 'R10').locator('[data-column-type="numbers"]').boundingBox())!;
  expect(Math.abs(th.x - td.x)).toBeLessThan(2);
  await page.getByTestId('board-table').evaluate((el) => (el.parentElement!.scrollTop = 0));
  await expect(stuck).toHaveCount(0);

  // Collapse the first group: one framed box with the colour rail, the count and the column summaries.
  // (The new group was added above the first one.)
  const first = page.getByTestId('board-section').filter({ hasNotText: 'שנייה' });
  await first.getByRole('button', { name: 'כיווץ הקבוצה' }).click();
  const folded = page.locator('[data-testid="board-section"][data-folded]');
  await expect(folded).toHaveCount(1);
  await expect(folded.getByTestId('group-count')).toHaveText(/24/);
  // D-PAL: no thick colour rail — a 1px frame and the thin colour bar beside the name.
  await expect(folded).toHaveCSS('border-inline-start-width', '1px');
  await expect(folded.getByTestId('group-bar')).toBeVisible();
  const numbers = folded.locator('[data-folded-column^="numbers"]');
  await expect(numbers).toContainText('מספרים');
  await expect(numbers).toContainText('12');
  await expect(folded.locator('[data-folded-column^="status"]').getByTestId('battery-segment').first()).toBeVisible();
  await expect(page.getByTestId('group-header')).toHaveCount(1);

  // For review: an expanded and a collapsed group side by side with the reported screenshots.
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['B1', 'B2']) {
    await add.fill(name);
    await add.press('Enter');
    await expect(row(page, name)).toBeVisible();
  }
  await page.mouse.move(1, 1);
  await page.screenshot({ path: `${SCRATCH}/r7-table-groups.png` });
});
