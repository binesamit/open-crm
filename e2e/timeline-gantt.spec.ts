// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * M8 ד6–ד8 (D25): Timeline, Gantt (+ dependency column) and Workload views on the shared time axis — real mouse
 * drags move / resize bars (RTL: dragging left = later), a strict dependency shifts its dependents, one undo puts the
 * whole chain back; Workload counts per person per day and lists a cell's items.
 */
const iso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const plus = (base: string, n: number) => {
  const [y, m, d] = base.split('-').map(Number) as [number, number, number];
  return iso(new Date(y, m - 1, d + n));
};

const newView = async (page: Page, type: string, name: string) => {
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: new RegExp(type) }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('view-tab').filter({ hasText: name })).toHaveAttribute('aria-selected', 'true');
};

/** Presses on `el` (at `x` of its width), moves by `dx` screen px in steps, releases. */
const dragBy = async (page: Page, el: Locator, dx: number, x = 0.5) => {
  await el.scrollIntoViewIfNeeded();
  const box = (await el.boundingBox())!;
  const sx = box.x + box.width * x;
  const sy = box.y + box.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + dx / 4, sy, { steps: 3 });
  await page.mouse.move(sx + dx, sy, { steps: 8 });
  await page.mouse.up();
};

test('timeline, gantt with dependencies, and workload', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers, meId } = await ownerContext(page);
  // A working day (the account weekend is Friday + Saturday by default), so Workload counts it.
  let today = iso(new Date());
  while ([5, 6].includes(new Date(`${today}T12:00:00`).getDay())) today = plus(today, 1);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', {
      headers,
      data: { name: `גאנט ${Date.now().toString(36)}`, workspace_id: ws },
    })
  ).json()) as { id: string };
  const col = (data: Record<string, unknown>) =>
    page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data });
  await col({ id: 'tl', title: 'ציר זמן', type: 'timeline' });
  await col({ id: 'owner', title: 'אחראי', type: 'people' });
  await col({ id: 'deps', title: 'תלוי ב', type: 'dependency', settings: { mode: 'strict', date_column_id: 'tl' } });
  const item = async (name: string, cells: Record<string, unknown>) =>
    (
      (await (
        await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name, cells } })
      ).json()) as { id: string }
    ).id;
  const me = { persons_and_teams: [{ id: meId, kind: 'person' }] };
  const a = await item('Alpha', { tl: { from: today, to: plus(today, 2) }, owner: me });
  await item('Bravo', { tl: { from: plus(today, 5), to: plus(today, 6) }, owner: me, deps: { item_ids: [a] } });
  await item('Charlie', { tl: { from: today, to: today }, owner: me });

  await page.goto(`/a/demo/b/${board.id}`);
  await expect(page.locator('[data-testid="item-row"][data-item-name="Alpha"]')).toBeVisible();

  // Gantt: bars, one arrow (Bravo depends on Alpha).
  await newView(page, 'גאנט', 'גאנט');
  const bar = (name: string) => page.locator(`[data-testid="timeline-bar"][data-item-name="${name}"]`);
  await expect(bar('Alpha')).toHaveAttribute('data-from', today);
  // Product decision: the bar's text is regular weight, never bold.
  await expect(bar('Alpha')).toHaveCSS('font-weight', '400');
  await expect(page.getByTestId('gantt-arrow')).toHaveCount(1);
  // Day zoom: 40px per day.
  await page.getByTestId('timeline-zoom').locator('[data-zoom="day"]').click();
  await expect(page.getByTestId('timeline')).toHaveAttribute('data-zoom', 'day');

  // Move Alpha two days later: in RTL that is a drag to the left. Bravo (strict) follows.
  await dragBy(page, bar('Alpha'), -80);
  await expect(bar('Alpha')).toHaveAttribute('data-from', plus(today, 2));
  await expect(bar('Alpha')).toHaveAttribute('data-to', plus(today, 4));
  await expect(bar('Bravo')).toHaveAttribute('data-from', plus(today, 7));
  // One undo puts both back.
  await page.getByTestId('toast-action').click();
  await expect(bar('Alpha')).toHaveAttribute('data-from', today);
  await expect(bar('Bravo')).toHaveAttribute('data-from', plus(today, 5));

  // Resize: the end edge (the bar's left side in RTL) one day later; the start stays.
  await dragBy(page, bar('Alpha').locator('[data-edge="end"]'), -40);
  await expect(bar('Alpha')).toHaveAttribute('data-to', plus(today, 3));
  await expect(bar('Alpha')).toHaveAttribute('data-from', today);
  // The table agrees (and Bravo moved by the strict dependency).
  await page.getByTestId('view-tab').filter({ hasText: 'טבלה' }).click();
  await expect(page.locator('[data-testid="item-row"][data-item-name="Bravo"]')).toBeVisible();

  // Timeline: rows grouped by the board's groups, today marker, a click opens the item.
  await newView(page, 'ציר זמן', 'ציר');
  await expect(page.getByTestId('timeline-section').first()).toBeVisible();
  await expect(page.getByTestId('timeline-today')).toBeVisible();
  await expect(bar('Charlie')).toHaveAttribute('data-from', today);
  await bar('Charlie').click();
  await expect(page).toHaveURL(/\/i\//);
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/\/i\//);
  // Group by "none" from the view settings: no section headers.
  await page.getByTestId('toolbar-view-settings').click();
  await page.getByTestId('timeline-group-by').click();
  await page.getByRole('menu').getByText('בלי קיבוץ', { exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('timeline-section')).toHaveCount(0);

  // Workload: me, on that day — Alpha and Charlie (counted), within the default capacity (3 a day).
  await newView(page, 'עומס עבודה', 'עומס');
  const cell = page.locator(
    `[data-testid="workload-row"][data-person="${meId}"] [data-testid="workload-cell"][data-bucket="${today}"]`,
  );
  await expect(cell).toHaveAttribute('data-load', '2');
  await expect(cell).toHaveAttribute('data-level', /under|full|none/);
  await cell.click();
  await expect(page.getByTestId('workload-popover').getByTestId('workload-item')).toHaveCount(2);
  await page.getByTestId('workload-popover').getByTestId('workload-item').filter({ hasText: 'Charlie' }).click();
  await expect(page).toHaveURL(/\/i\//);
});
