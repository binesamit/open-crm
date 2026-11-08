// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * the calendar by the hour (the approved canvas). A timeline "with hours" and a date with start / end
 * hour columns; drag to move, drag the bottom edge to change the end, drag an empty stretch to make an item; the
 * settings make the hour column they need from the column picker.
 */
const HOUR = 48; // px per hour at the "normal" height

const setup = async (page: Page, name: string) => {
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `${name} ${Date.now()}`, workspace_id: ws } })
  ).json()) as { id: string };
  const column = (data: Record<string, unknown>) =>
    page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data });
  const item = async (n: string, cells: Record<string, unknown>) =>
    (await (
      await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: n, cells } })
    ).json()) as { id: string };
  const view = async (calendar: Record<string, unknown>) =>
    (await (
      await page.request.post(`/api/v1/boards/${board.id}/views`, {
        headers,
        data: { type: 'calendar', name: 'יומן', settings: { calendar } },
      })
    ).json()) as { id: string };
  const cells = async (id: string) =>
    (
      (await (await page.request.get(`/api/v1/items/${id}`, { headers })).json()) as {
        cells: Record<string, { value?: Record<string, unknown> } | undefined>;
      }
    ).cells;
  return { headers, board, column, item, view, cells };
};

/** Today in the account's calendar, as the grid marks it. */
const todayOf = async (page: Page) =>
  (await page.locator('[data-testid="calendar-hours"]').evaluateAll((els) => {
    const now = document.querySelector('[data-testid="calendar-now"]')?.parentElement;
    return now?.getAttribute('data-day') ?? els[0]?.getAttribute('data-day');
  }))!;

test('timeline with hours: blocks sized by their hours, overlaps side by side, move, resize and create', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  const { board, column, item, view, cells } = await setup(page, 'יומן שעות');
  await column({ id: 'tl', title: 'מועד', type: 'timeline', settings: { show_time: true } });
  // Today's date as the server's account calendar sees it: an item made for a far day, then read back.
  const today = new Date().toISOString().slice(0, 10);
  const a = await item('פגישה א', { tl: { from: today, to: today, from_time: '09:00', to_time: '10:00' } });
  const b = await item('פגישה ב', { tl: { from: today, to: today, from_time: '09:30', to_time: '10:30' } });
  const v = await view({ date_column_id: 'tl', show_hours: true, time_source: 'timeline', default: 'day' });
  await page.goto(`/a/demo/b/${board.id}?view=${v.id}`);
  const grid = page.getByTestId('calendar-time-grid');
  await expect(grid).toBeVisible();
  const day = await todayOf(page);
  test.skip(day !== today, 'the account day differs from UTC right now');

  const blockA = grid.locator('[data-testid="calendar-item"][data-item-name="פגישה א"]');
  const blockB = grid.locator('[data-testid="calendar-item"][data-item-name="פגישה ב"]');
  await expect(blockA).toBeVisible();
  // An hour tall, half the day wide (they overlap).
  const boxA = (await blockA.boundingBox())!;
  const boxB = (await blockB.boundingBox())!;
  const col = (await grid.locator(`[data-testid="calendar-hours"][data-day="${today}"]`).boundingBox())!;
  expect(Math.round(boxA.height)).toBeGreaterThanOrEqual(HOUR - 4);
  expect(boxA.width).toBeLessThan(col.width / 2 + 2);
  expect(Math.abs(boxB.y - boxA.y - HOUR / 2)).toBeLessThan(3);

  // Move A an hour later: 10:00–11:00.
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + 10);
  await page.mouse.down();
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + 10 + HOUR / 2, { steps: 4 });
  await page.mouse.move(boxA.x + boxA.width / 2, boxA.y + 10 + HOUR, { steps: 4 });
  await expect(page.getByTestId('calendar-drag-preview')).toBeVisible();
  await page.mouse.up();
  await expect.poll(async () => (await cells(a.id)).tl?.value).toMatchObject({ from_time: '10:00', to_time: '11:00' });
  // Its toast offers "undo".
  await expect(page.getByRole('button', { name: 'ביטול' }).first()).toBeVisible();

  // Stretch B's end by half an hour: 09:30–11:00.
  const handle = blockB.getByTestId('calendar-item-resize');
  const h = (await handle.boundingBox())!;
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2);
  await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + HOUR / 4, { steps: 3 });
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2 + HOUR / 2, { steps: 3 });
  await page.mouse.up();
  await expect.poll(async () => (await cells(b.id)).tl?.value).toMatchObject({ from_time: '09:30', to_time: '11:00' });

  // Draw 14:00–15:30 on the empty day and name it.
  const top = col.y; // the column starts at midnight
  await page.mouse.move(col.x + col.width / 2, top + 14 * HOUR + 4);
  await page.mouse.down();
  await page.mouse.move(col.x + col.width / 2, top + 15 * HOUR, { steps: 4 });
  await page.mouse.move(col.x + col.width / 2, top + 15.5 * HOUR, { steps: 4 });
  await page.mouse.up();
  await expect(page.getByTestId('calendar-day-panel')).toBeVisible();
  await page.getByTestId('calendar-day-name').fill('סדנה');
  await page.getByTestId('calendar-day-create').click();
  await expect(grid.locator('[data-testid="calendar-item"][data-item-name="סדנה"]')).toBeVisible();
  const made = grid.locator('[data-testid="calendar-item"][data-item-name="סדנה"]');
  await expect(made).toHaveAttribute('data-start', String(14 * 60));
  await expect(made).toHaveAttribute('data-end', String(15 * 60 + 30));

  // A click opens the quick card; "open item" opens the item.
  await blockB.click();
  await expect(page.getByTestId('calendar-quick-card')).toBeVisible();
  await expect(page.getByTestId('calendar-quick-when')).toContainText('09:30–11:00');
  await page.getByTestId('calendar-quick-open').click();
  await expect(page).toHaveURL(/\/i\//);
});

test('date + start / end hour columns: a move writes the date and both hours; settings make an hour column', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  const { board, column, item, view, cells } = await setup(page, 'יומן תאריך ושעות');
  await column({ id: 'd', title: 'תאריך', type: 'date' });
  await column({ id: 's', title: 'התחלה', type: 'hour' });
  await column({ id: 'e', title: 'סיום', type: 'hour' });
  const today = new Date().toISOString().slice(0, 10);
  const it = await item('שיחה', { d: { date: today }, s: { hour: 11, minute: 0 }, e: { hour: 12, minute: 0 } });
  const v = await view({
    date_column_id: 'd',
    show_hours: true,
    time_source: 'date_hours',
    start_hour_column_id: 's',
    end_hour_column_id: 'e',
    default: 'week',
  });
  await page.goto(`/a/demo/b/${board.id}?view=${v.id}`);
  const grid = page.getByTestId('calendar-time-grid');
  await expect(grid).toHaveAttribute('data-days', '7');
  test.skip((await todayOf(page)) !== today, 'the account day differs from UTC right now');
  const block = grid.locator('[data-testid="calendar-item"][data-item-name="שיחה"]');
  await expect(block).toHaveAttribute('data-start', String(11 * 60));
  await expect(block).toHaveAttribute('data-end', String(12 * 60));

  // To the neighbouring day (the next one, or the one before on the week's last day), 30 minutes earlier.
  const cols = grid.getByTestId('calendar-hours');
  const days = await cols.evaluateAll((els) => els.map((e) => e.getAttribute('data-day')!));
  const index = days.indexOf(today);
  const toIndex = index < days.length - 1 ? index + 1 : index - 1;
  const target = (await cols.nth(toIndex).boundingBox())!;
  const box = (await block.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, box.y + 8 - HOUR / 4, { steps: 6 });
  await page.mouse.move(target.x + target.width / 2, box.y + 8 - HOUR / 2, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => {
      const c = await cells(it.id);
      return [c.d?.value?.date, c.s?.value, c.e?.value];
    })
    .toEqual([days[toIndex], { hour: 10, minute: 30 }, { hour: 11, minute: 30 }]);

  // Settings: the end hour picker makes a new hour column right there.
  await page.getByTestId('toolbar-view-settings').click();
  await expect(page.getByTestId('calendar-show-hours')).toBeVisible();
  await page.getByTestId('calendar-end-hour').click();
  await page.getByTestId('calendar-end-hour-create-hour').click();
  await expect
    .poll(
      async () =>
        (
          (await (
            await page.request.get(`/api/v1/boards/${board.id}`, { headers: (await ownerContext(page)).headers })
          ).json()) as {
            columns: { type: string }[];
          }
        ).columns.filter((c) => c.type === 'hour').length,
    )
    .toBe(3);
});

test('right click on a meeting: the item menu with status and colour (a colour column made from the menu)', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  const { board, column, item, view, cells } = await setup(page, 'יומן תפריט');
  await column({ id: 'tl', title: 'מועד', type: 'timeline', settings: { show_time: true } });
  await column({
    id: 'rsvp',
    title: 'אישור הגעה',
    type: 'status',
    settings: {
      labels: [
        { id: 1, label: 'מגיע', color: 'green', index: 0 },
        { id: 2, label: 'לא מגיע', color: 'crimson', index: 1 },
      ],
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  const a = await item('פגישת תפריט', { tl: { from: today, to: today, from_time: '11:00', to_time: '12:00' } });
  // The view paints by the board's first status column until it has a colour column of its own.
  const v = await view({ date_column_id: 'tl', show_hours: true, time_source: 'timeline', default: 'day' });
  await page.goto(`/a/demo/b/${board.id}?view=${v.id}`);
  const ev = page.locator('[data-testid="calendar-item"][data-item-name="פגישת תפריט"]');
  await expect(ev).toBeVisible();

  // Status ▸ מגיע
  await ev.click({ button: 'right' });
  await expect(page.getByTestId('calendar-menu-edit')).toBeVisible();
  const row = (name: string) => page.locator('[role^="menuitem"]', { has: page.getByText(name, { exact: true }) });
  await page.getByTestId('calendar-menu-status-rsvp').click();
  await row('מגיע').click();
  await expect.poll(async () => (await cells(a.id)).rsvp?.value).toEqual({ index: 1 });

  // Colour ▸ (no colour column on the view yet) → a new colour column, the item painted blue.
  await ev.click({ button: 'right' });
  await page.getByTestId('calendar-menu-color').click();
  await row('כחול').click();
  await expect
    .poll(async () => {
      const c = await cells(a.id);
      return Object.entries(c).some(([k, x]) => k !== 'rsvp' && (x?.value as { index?: number })?.index === 5);
    })
    .toBe(true);

  // Keyboard: Shift+F10 on the focused meeting opens the same menu; "quick edit" opens the quick card.
  await ev.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByTestId('calendar-menu-edit').click();
  await expect(page.getByTestId('calendar-quick-card')).toBeVisible();
});

test('the quick card edits its fields with the board’s own cells', async ({ page }) => {
  forbidNativeDialogs(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  const { board, column, item, view, cells } = await setup(page, 'יומן כרטיס');
  await column({ id: 'tl', title: 'מועד', type: 'timeline', settings: { show_time: true } });
  await column({ id: 'note', title: 'הערה', type: 'text' });
  const today = new Date().toISOString().slice(0, 10);
  const a = await item('פגישה', { tl: { from: today, to: today, from_time: '09:00', to_time: '10:00' } });
  const v = await view({
    date_column_id: 'tl',
    show_hours: true,
    time_source: 'timeline',
    default: 'day',
    card_fields: ['note'],
  });
  await page.goto(`/a/demo/b/${board.id}?view=${v.id}`);
  const grid = page.getByTestId('calendar-time-grid');
  await expect(grid).toBeVisible();
  test.skip((await todayOf(page)) !== today, 'the account day differs from UTC right now');

  await grid.locator('[data-testid="calendar-item"][data-item-name="פגישה"]').click();
  const card = page.getByTestId('calendar-quick-card');
  await expect(card).toBeVisible();
  await card.locator('[data-column="note"]').click();
  await page.keyboard.type('נערך מהיומן');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await cells(a.id)).note?.value).toBe('נערך מהיומן');
  // The card stays open and shows the new value.
  await expect(card.locator('[data-column="note"]')).toHaveText('נערך מהיומן');
  await card.screenshot({ path: test.info().outputPath('quick-card.png') });
});
