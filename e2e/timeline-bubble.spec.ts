// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn } from './helpers';

/**
 * Owner fixes (fix6-table): the timeline's days bubble is never covered (a portal on top of everything, also on
 * the first row); the folded board search shows the magnifier and the Ctrl F hint side by side; every battery
 * segment has its "<label> · n (pct%)" tooltip; columns have an optional description (column menu "עריכת תיאור",
 * an (i) in the header — subitem tables too); subitems drag to another parent (into an item / subitem, or beside a
 * subitem of another parent); a long press on the name cell drags like the ⋮⋮ handle (items and subitems).
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, items: string[]) => {
  const name = `תיקון6 ${Date.now().toString(36)}`;
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

/** The hint of an element: its `title`, or `data-tip` once the system tooltip took it over. */
const hint = (el: Locator) => el.evaluate((e) => e.getAttribute('title') ?? e.getAttribute('data-tip'));

/** Top-to-bottom order of rows by name. */
const order = async (page: Page, names: string[]) => {
  const ys = await Promise.all(names.map(async (n) => [n, (await row(page, n).boundingBox())!.y] as const));
  return ys.sort((a, b) => a[1] - b[1]).map(([n]) => n);
};

/** The sub-board's items by name → "<parent name>@<depth>" (the API is the truth for where a subitem hangs). */
const parents = async (page: Page, boardId: string) => {
  const { headers } = await ownerContext(page);
  type Row = { id: string; name: string; parent_item_id: string | null; depth: number };
  const get = async <T>(path: string) => (await (await page.request.get(`/api/v1${path}`, { headers })).json()) as T;
  const board = await get<{ subitems_board_id: string }>(`/boards/${boardId}`);
  const subs = (await get<{ data: Row[] }>(`/boards/${board.subitems_board_id}/items`)).data;
  const main = (await get<{ data: Row[] }>(`/boards/${boardId}/items`)).data;
  const nameOf = new Map([...main, ...subs].map((i) => [i.id, i.name]));
  return Object.fromEntries(subs.map((i) => [i.name, `${nameOf.get(i.parent_item_id ?? '')}@${i.depth}`]));
};

/** Press and hold the row's name (the text itself), then move to `target` (y = fraction of its height), let go. */
const longPressDrag = async (page: Page, name: string, target: Locator, y: number) => {
  const cell = row(page, name).locator('[data-cell="-1"]');
  const from = (await cell.getByText(name, { exact: true }).boundingBox())!;
  const at = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await expect(cell).toHaveAttribute('data-armed', 'true');
  const to = (await target.boundingBox())!;
  await page.mouse.move(at.x + 4, at.y + 6, { steps: 3 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height * y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(100);
};

test('timeline: the days bubble sits on top of everything, also on the first row', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['First']);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'ציר זמן', exact: true }).click();
  const now = new Date();
  // Next month's days: a range that never ends before today (on the 13th, the 3rd–12th of this month was already
  // overdue — a red pill and "באיחור").
  const day = (n: number) => new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, n)).toISOString().slice(0, 10);
  const label = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  const cell = row(page, 'First').locator('[data-column-type="timeline"]');
  await cell.click();
  await page.getByRole('button', { name: 'החודש הבא' }).click();
  await page.getByRole('button', { name: label(day(3)), exact: true }).click();
  await page.getByRole('button', { name: label(day(12)), exact: true }).click();
  await page.keyboard.press('Escape');

  const days = page.getByTestId('timeline-days');
  await expect(days).toHaveCount(0);
  await cell.getByTestId('timeline-pill').hover();
  await expect(days).toBeVisible();
  await expect(days).toHaveText('10 ימים');
  // In a portal on body (fixed, above the sticky header), right by the pill and inside the window.
  expect(await days.evaluate((el) => el.parentElement === document.body)).toBe(true);
  expect(await days.evaluate((el) => getComputedStyle(el).position)).toBe('fixed');
  const bubble = (await days.boundingBox())!;
  const pill = (await cell.getByTestId('timeline-pill').boundingBox())!;
  expect(bubble.y).toBeGreaterThanOrEqual(0);
  expect(Math.abs(bubble.x + bubble.width / 2 - (pill.x + pill.width / 2))).toBeLessThan(4);
  expect(bubble.y + bubble.height <= pill.y + 1 || bubble.y >= pill.y + pill.height - 1).toBe(true);
  // Nothing of the header row paints over it: it is the topmost layer.
  const z = await days.evaluate((el) => Number(getComputedStyle(el).zIndex));
  expect(z).toBeGreaterThanOrEqual(60);

  await page.mouse.move(1, 1);
  await expect(days).toHaveCount(0);
});

test('board search folded: magnifier and Ctrl F side by side (RTL and LTR)', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['alpha']);
  const box = page.getByTestId('board-search');
  await expect(box).toHaveAttribute('data-collapsed', 'true');
  const icon = box.getByTestId('search-icon').locator('svg');
  const kbd = page.getByTestId('search-kbd');
  const apart = async () => {
    await expect(icon).toBeVisible();
    await expect(kbd).toBeVisible();
    const a = (await icon.boundingBox())!;
    const b = (await kbd.boundingBox())!;
    // No overlap, a gap between them, both inside the field.
    const gap = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
    const field = (await page.getByTestId('toolbar-search').boundingBox())!;
    return gap >= 2 && b.x >= field.x - 1 && b.x + b.width <= field.x + field.width + 1;
  };
  expect(await apart()).toBe(true);
  await page.evaluate(() => (document.documentElement.dir = 'ltr'));
  expect(await apart()).toBe(true);
  await page.evaluate(() => (document.documentElement.dir = 'rtl'));

  // Opened: the field as before, without the hint.
  await page.getByTestId('toolbar-search').click();
  await expect(kbd).toHaveCount(0);
  await expect(icon).toBeVisible();
});

test('battery: every segment has "<label> · n (pct%)"', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardId = await newBoard(page, ['One', 'Two', 'Three']);
  const { headers } = await ownerContext(page);
  const col = (await (
    await page.request.post(`/api/v1/boards/${boardId}/columns`, { headers, data: { title: 'מצב', type: 'status' } })
  ).json()) as { id: string };
  const items = (await (await page.request.get(`/api/v1/boards/${boardId}/items`, { headers })).json()) as {
    data: { id: string; name: string }[];
  };
  // One labelled, two blank.
  const one = items.data.find((i) => i.name === 'One')!;
  await page.request.put(`/api/v1/items/${one.id}/cells/${col.id}`, { headers, data: { value: { index: 1 } } });
  await page.reload();

  const segments = page
    .getByTestId('summary-row')
    .first()
    .getByRole('button', { name: /חישוב בשורת הסיכום — מצב/ })
    .getByTestId('battery-segment');
  await expect(segments).toHaveCount(2);
  const hints = await Promise.all((await segments.all()).map(hint));
  expect(hints.every((h) => !!h && /^.+ · \d+ \(\d+%\)$/.test(h))).toBe(true);
  expect(hints.some((h) => / · 2 \(67%\)$/.test(h!))).toBe(true); // the blanks ("ריק")
  expect(hints.some((h) => / · 1 \(33%\)$/.test(h!))).toBe(true);
});

test('column description: edited from the column menu, an (i) in the header — subitems too', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardId = await newBoard(page, ['Parent']);
  const { headers } = await ownerContext(page);
  await page.request.post(`/api/v1/boards/${boardId}/columns`, { headers, data: { title: 'הערות', type: 'text' } });
  await page.reload();

  const header = page.locator('[data-header]').filter({ hasText: 'הערות' }).first();
  await expect(header.getByTestId('column-info')).toHaveCount(0);
  await header.hover();
  await header.getByRole('button', { name: 'פעולות לעמודה הערות' }).click();
  await page.getByTestId('column-edit-description').click();
  const input = page.getByTestId('column-description-input');
  await input.fill('מה שהלקוח ביקש');
  await page.getByTestId('column-settings-save').click();
  await expect(input).toHaveCount(0);
  const info = header.getByTestId('column-info');
  await expect(info).toBeVisible();
  expect(await hint(info)).toBe('מה שהלקוח ביקש');

  // Cleared → the (i) goes away.
  await header.hover();
  await header.getByRole('button', { name: 'פעולות לעמודה הערות' }).click();
  await page.getByTestId('column-edit-description').click();
  await page.getByTestId('column-description-input').fill('');
  await page.getByTestId('column-settings-save').click();
  await expect(header.getByTestId('column-info')).toHaveCount(0);

  // A subitem table's column.
  await addSubitems(page, 'Parent', ['Child']);
  const subHeader = page.getByTestId('subhead').locator('[data-header]').filter({ hasText: 'סטטוס' }).first();
  await subHeader.hover();
  await subHeader.getByRole('button', { name: 'פעולות לעמודה סטטוס' }).click();
  await page.getByTestId('column-edit-description').click();
  await page.getByTestId('column-description-input').fill('איפה הסאב עומד');
  await page.getByTestId('column-settings-save').click();
  await expect(subHeader.getByTestId('column-info')).toBeVisible();
  expect(await hint(subHeader.getByTestId('column-info'))).toBe('איפה הסאב עומד');
});

test('subitems drag to another parent: into an item, into a subitem, beside another parent’s subitem', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardId = await newBoard(page, ['P1', 'P2']);
  // P2 first: `addSubitems` types in the first open "+ add subitem" field, and P1's (above) would be first.
  await addSubitems(page, 'P2', ['X']);
  await addSubitems(page, 'P1', ['A', 'B']);
  expect(await parents(page, boardId)).toMatchObject({ A: 'P1@1', B: 'P1@1', X: 'P2@1' });
  const drag = async (name: string, target: string, y: number) => {
    const box = (await row(page, target).boundingBox())!;
    await row(page, name).hover();
    await row(page, name)
      .getByTestId('subitem-drag')
      .dragTo(row(page, target), { targetPosition: { x: box.width / 2, y: box.height * y } });
    await page.waitForTimeout(100);
  };

  // A into the middle of X → A is X's subitem (one level deeper).
  await drag('A', 'X', 0.5);
  await expect.poll(async () => (await parents(page, boardId)).A).toBe('X@2');
  await expect(row(page, 'A')).toBeVisible(); // X opened to show it

  // B onto the top edge of X → beside X, under P2.
  await drag('B', 'X', 0.1);
  await expect.poll(async () => (await parents(page, boardId)).B).toBe('P2@1');
  await expect.poll(() => order(page, ['B', 'X'])).toEqual(['B', 'X']);

  // X (with A under it) into P1 (a top-level item) → X goes back under P1, A comes along.
  await drag('X', 'P1', 0.5);
  await expect.poll(async () => parents(page, boardId)).toMatchObject({ X: 'P1@1', A: 'X@2' });

  // Never into its own branch: X cannot go into A (its subitem) — no drop there, nothing changes.
  await drag('X', 'A', 0.5);
  await page.waitForTimeout(300);
  expect(await parents(page, boardId)).toMatchObject({ X: 'P1@1', A: 'X@2' });
});

test('long press on the name drags the row (items and subitems); a click still renames', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardId = await newBoard(page, ['I1', 'I2', 'I3']);

  // Items: I3 held on its name and dropped on the top half of I1 → first.
  await longPressDrag(page, 'I3', row(page, 'I1'), 0.15);
  await expect.poll(() => order(page, ['I1', 'I2', 'I3'])).toEqual(['I3', 'I1', 'I2']);

  // A press that ends without moving neither renames nor opens anything.
  const name = row(page, 'I2').locator('[data-cell="-1"]');
  const b = (await name.getByText('I2', { exact: true }).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await expect(name).toHaveAttribute('data-armed', 'true');
  await page.mouse.up();
  await expect(name).not.toHaveAttribute('data-armed', 'true');
  await expect(row(page, 'I2').getByRole('textbox')).toHaveCount(0);

  // A plain click on the name still renames (dnd-kit swallows clicks for 50ms after a drag ends).
  await page.waitForTimeout(100);
  await row(page, 'I2').getByText('I2', { exact: true }).click();
  const field = row(page, 'I2').getByRole('textbox');
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');

  // Subitems: S2 held and dropped into I1 → I1's subitem.
  await addSubitems(page, 'I2', ['S1', 'S2']);
  await longPressDrag(page, 'S2', row(page, 'I1'), 0.5);
  await expect.poll(async () => (await parents(page, boardId)).S2).toBe('I1@1');
});
