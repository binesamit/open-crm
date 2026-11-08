// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type APIResponse, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * a time in a date column. "Include time" (show_time) is a column setting, off by default; the cell's
 * picker then adds a time with our own TimeField (never a native input) in the region's zone — saved on an outside
 * click, Esc discards it. Sorting uses the time; a date filter ("today") matches by the local day.
 * The account's zone is set to Asia/Tokyo (+9, no DST) and the member follows it; both are restored in afterEach.
 */
type Detail = { settings: { locale: Record<string, unknown> } };
type Profile = { timezone: string | null };
type Cell = { value: { date: string; time?: string } | null };

const json = async <T>(r: APIResponse): Promise<T> => {
  expect(r.ok(), await r.text()).toBeTruthy();
  return (await r.json()) as T;
};
const uid = () => Date.now().toString(36);
const ZONE = 'Asia/Tokyo';
const OFFSET_H = 9;
/** Today in Tokyo, `YYYY-MM-DD`. */
const tokyoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: ZONE }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** The stored value (UTC) of a Tokyo wall-clock time. */
const stored = (iso: string, hm: string) => {
  const [h, m] = hm.split(':').map(Number) as [number, number];
  const at = new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10), h - OFFSET_H, m));
  return { date: at.toISOString().slice(0, 10), time: at.toISOString().slice(11, 16) };
};
const shown = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
const dateCell = (page: Page, name: string) => row(page, name).locator('[data-column="due"]');
const names = (page: Page, only: string[]) =>
  page
    .getByTestId('item-row')
    .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-item-name')))
    .then((all) => all.filter((n): n is string => !!n && only.includes(n)));

/** What the running test changed (the account's region, the member's zone, its boards) — undone in afterEach. */
let cleanup: (() => Promise<void>) | null = null;
test.afterEach(async () => {
  const run = cleanup;
  cleanup = null;
  await run?.();
});

const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const original = await json<Detail>(await page.request.get('/api/v1/accounts/me', { headers }));
  const profile = await json<Profile>(await page.request.get('/api/v1/users/me', { headers }));
  const ws = (await json<{ data: { id: string }[] }>(await page.request.get('/api/v1/workspaces', { headers })))
    .data[0]!.id;
  const boardIds: string[] = [];
  const board = async (cells: Record<string, Cell['value']>, settings?: Record<string, unknown>) => {
    const b = await json<{ id: string }>(
      await page.request.post('/api/v1/boards', { headers, data: { name: `שעה בתאריך ${uid()}`, workspace_id: ws } }),
    );
    boardIds.push(b.id);
    await json(
      await page.request.post(`/api/v1/boards/${b.id}/columns`, {
        headers,
        data: { id: 'due', title: 'מועד', type: 'date', ...(settings ? { settings } : {}) },
      }),
    );
    const items: Record<string, string> = {};
    for (const [name, value] of Object.entries(cells))
      items[name] = (
        await json<{ id: string }>(
          await page.request.post(`/api/v1/boards/${b.id}/items`, {
            headers,
            data: { name, cells: value ? { due: value } : {} },
          }),
        )
      ).id;
    return { id: b.id, items };
  };
  const cellOf = async (itemId: string) =>
    (await json<{ cells: Record<string, Cell> }>(await page.request.get(`/api/v1/items/${itemId}`, { headers }))).cells
      .due?.value ?? null;
  const columnSettings = async (boardId: string) =>
    (
      await json<{ columns: { id: string; settings: Record<string, unknown> }[] }>(
        await page.request.get(`/api/v1/boards/${boardId}`, { headers }),
      )
    ).columns.find((c) => c.id === 'due')!.settings;
  // Restored in afterEach (its own timeout, after a timed-out test too): cheap API calls, in parallel, each with
  // a short timeout — never through the page's state.
  cleanup = async () => {
    const opts = { headers, timeout: 15_000 };
    await Promise.allSettled([
      page.request.patch('/api/v1/accounts/me', { ...opts, data: { settings: { locale: original.settings.locale } } }),
      page.request.patch('/api/v1/users/me', { ...opts, data: { timezone: profile.timezone } }),
      ...boardIds.map((id) => page.request.delete(`/api/v1/boards/${id}`, opts)),
    ]);
  };
  // The account in Tokyo, 24h, day first; the member without a zone of their own follows it.
  expect(
    (
      await page.request.patch('/api/v1/accounts/me', {
        headers,
        data: { settings: { locale: { timezone: ZONE, date_format: 'DD/MM/YYYY', time_format: '24h' } } },
      })
    ).ok(),
  ).toBe(true);
  expect((await page.request.patch('/api/v1/users/me', { headers, data: { timezone: null } })).ok()).toBe(true);
  return { board, cellOf, columnSettings };
};

const openBoard = async (page: Page, boardId: string) => {
  await page.goto(`/a/demo/b/${boardId}`);
  await expect(page.getByTestId('board-scroll')).toBeVisible();
};

/** The column menu's "הגדרות עמודה" (offered for every type with a settings form — `hasColumnSettings`). */
const openColumnSettings = async (page: Page) => {
  const header = page.locator('[data-header]').filter({ hasText: 'מועד' }).first();
  await header.hover();
  await header.getByRole('button', { name: 'פעולות לעמודה מועד' }).click();
  await page.getByTestId('column-settings').click();
};

/** A press outside the picker that does nothing else (the board's search field). */
const outside = (page: Page) => page.getByTestId('toolbar-search').click();

test('include time: on in the column settings, a time from our picker (outside click saves, Esc cancels), off again', async ({
  page,
}) => {
  const s = await setup(page);
  const day = '2026-11-10';
  const b = await s.board({ Meeting: { date: day } });
  await openBoard(page, b.id);

  // Off by default: the picker is a calendar only.
  await expect(dateCell(page, 'Meeting')).toHaveText(shown(day));
  await dateCell(page, 'Meeting').click();
  await expect(page.getByTestId('popover')).toBeVisible();
  await expect(page.getByTestId('date-time-row')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Turn "include time" on.
  await openColumnSettings(page);
  await expect(page.getByTestId('date-include-time')).not.toBeChecked();
  await page.getByTestId('date-include-time').click();
  await expect(page.getByTestId('date-default-time')).toBeVisible();
  await page.getByTestId('column-settings-save').click();
  await expect.poll(() => s.columnSettings(b.id)).toMatchObject({ show_time: true });

  // Add a time: the column's default (09:00), then 14:30 from the hour and minute columns.
  await dateCell(page, 'Meeting').click();
  await page.getByTestId('date-add-time').click();
  const field = page.getByTestId('date-time-field');
  await expect(field).toHaveText('09:00');
  await field.click();
  await page.getByTestId('date-time-field-hours').locator('[data-v="14"]').click();
  await page.getByTestId('date-time-field-minutes').locator('[data-v="30"]').click();
  await expect(field).toHaveText('14:30');
  // Our own controls only — never a native date / time input.
  await expect(page.locator('input[type="time"], input[type="date"], input[type="datetime-local"]')).toHaveCount(0);
  // Saved on an outside click: 14:30 in Tokyo = 05:30 UTC, shown in the account's zone.
  await outside(page);
  await expect(page.getByTestId('date-time-row')).toHaveCount(0);
  await expect(dateCell(page, 'Meeting')).toHaveText(`${shown(day)} 14:30`);
  await expect.poll(() => s.cellOf(b.items.Meeting!)).toEqual({ date: day, time: '05:30' });

  // Esc discards the pending edit.
  await dateCell(page, 'Meeting').click();
  await field.click();
  await page.getByTestId('date-time-field-hours').locator('[data-v="16"]').click();
  await page.getByTestId('date-time-field-minutes').locator('[data-v="45"]').click();
  await expect(field).toHaveText('16:45');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('date-time-row')).toHaveCount(0);
  await expect(dateCell(page, 'Meeting')).toHaveText(`${shown(day)} 14:30`);
  await page.reload();
  await expect(dateCell(page, 'Meeting')).toHaveText(`${shown(day)} 14:30`);
  expect(await s.cellOf(b.items.Meeting!)).toEqual({ date: day, time: '05:30' });

  // Off again: the setting is gone; a stored time stays and is still shown.
  await openColumnSettings(page);
  await expect(page.getByTestId('date-include-time')).toBeChecked();
  await page.getByTestId('date-include-time').click();
  await expect(page.getByTestId('date-default-time')).toHaveCount(0);
  await page.getByTestId('column-settings-save').click();
  await expect.poll(async () => (await s.columnSettings(b.id)).show_time ?? false).toBe(false);
  await expect(dateCell(page, 'Meeting')).toHaveText(`${shown(day)} 14:30`);
});

test('include time: a time is shown in the account timezone, sorts within the day and keeps the date filter', async ({
  page,
}) => {
  const s = await setup(page);
  const today = tokyoToday();
  const yesterday = addDays(today, -1);
  // Same Tokyo day, created late first. "Night" (yesterday 23:30 Tokyo) shares the UTC date of "Early" (00:30
  // today Tokyo = 15:30 UTC yesterday) — only the local day tells them apart.
  const b = await s.board(
    {
      Late: stored(today, '18:00'),
      Early: stored(today, '00:30'),
      Night: stored(yesterday, '23:30'),
    },
    { show_time: true },
  );
  expect(stored(today, '00:30').date).toBe(yesterday);
  await openBoard(page, b.id);
  const all = ['Late', 'Early', 'Night'];

  // Shown in the account's zone (Tokyo), not UTC.
  await expect(dateCell(page, 'Early')).toHaveText(`${shown(today)} 00:30`);
  await expect(dateCell(page, 'Late')).toHaveText(`${shown(today)} 18:00`);
  await expect(dateCell(page, 'Night')).toHaveText(`${shown(yesterday)} 23:30`);

  // Sort by the date: the time orders items of the same day.
  await page.getByTestId('toolbar-sort').click();
  await page.getByTestId('sort-add').click();
  const level = page.getByTestId('sort-row');
  await level.getByTestId('sort-row-column').click();
  await page.getByRole('menu').getByText('מועד', { exact: true }).click();
  await level.getByTestId('sort-row-asc').click();
  await expect.poll(() => names(page, all)).toEqual(['Night', 'Early', 'Late']);
  await level.getByTestId('sort-row-desc').click();
  await expect.poll(() => names(page, all)).toEqual(['Late', 'Early', 'Night']);
  await page.keyboard.press('Escape');

  // The quick date filter "today" matches by the local (Tokyo) day: both of today's items, not last night's.
  await page.getByTestId('toolbar-filter').click();
  await page.getByTestId('filter-rail-due').click();
  const quick = page.getByTestId('quick-due');
  await expect(quick).toBeVisible();
  await quick.getByRole('button', { name: /^היום/ }).click();
  await expect(row(page, 'Early')).toBeVisible();
  await expect(row(page, 'Late')).toBeVisible();
  await expect(row(page, 'Night')).toHaveCount(0);
  await quick.getByRole('button', { name: /^היום/ }).click();
  await expect(row(page, 'Night')).toBeVisible();
});
