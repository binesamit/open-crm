// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * A3 — the account's region settings apply everywhere: change them through the API, and the dates in the table,
 * the item card and the calendars (first day of week, weekend shading) follow. The account is restored in `finally`.
 */
type Detail = { settings: { locale: Record<string, unknown> } };
const uid = () => Date.now().toString(36);

test('region settings: date format, time format, first day and weekend follow the account', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const original = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
  const setRegion = (locale: Record<string, unknown>) =>
    page.request.patch('/api/v1/accounts/me', { headers, data: { settings: { locale } } });
  // The Israeli defaults this suite expects. Restored whatever the stored value was: a run that stopped half way
  // (timeout) leaves the US region behind, and "original" would then be it.
  const israeli = { date_format: 'DD/MM/YYYY', time_format: '24h', first_day: 0, weekend: 'fri_sat' };
  let boardId: string | null = null;
  try {
    // A board with a date (with a UTC time), a timeline and a calendar view.
    const ws = (
      (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] }
    ).data[0]!.id;
    const board = (await (
      await page.request.post('/api/v1/boards', { headers, data: { name: `אזור ${uid()}`, workspace_id: ws } })
    ).json()) as { id: string };
    boardId = board.id;
    const column = async (title: string, type: string) =>
      (
        (await (
          await page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data: { title, type } })
        ).json()) as { id: string }
      ).id;
    const date = await column('תאריך יעד', 'date');
    const timeline = await column('תקופה', 'timeline');
    const name = `משימה ${uid()}`;
    await page.request.post(`/api/v1/boards/${board.id}/items`, {
      headers,
      data: {
        name,
        cells: {
          // 22:30 UTC on 2026-10-05 = 01:30 on 2026-10-06 in Jerusalem.
          [date]: { date: '2026-10-05', time: '22:30' },
          [timeline]: { from: '2027-03-01', to: '2027-03-05' },
        },
      },
    });
    await page.request.post(`/api/v1/boards/${board.id}/views`, { headers, data: { type: 'calendar', name: 'cal' } });
    // Creating a view makes it my current one — the table is opened by its id.
    const views = (
      (await (await page.request.get(`/api/v1/boards/${board.id}/views`, { headers })).json()) as {
        data: { id: string; type: string }[];
      }
    ).data;
    const tableUrl = `/a/demo/b/${board.id}?view=${views.find((v) => v.type === 'table')!.id}`;
    const calendarUrl = `/a/demo/b/${board.id}?view=${views.find((v) => v.type === 'calendar')!.id}`;

    // US-style region: month first, 12h, weeks from Monday, Saturday–Sunday weekend.
    expect(
      (
        await setRegion({
          date_format: 'MM/DD/YYYY',
          time_format: '12h',
          first_day: 1,
          weekend: 'sat_sun',
          timezone: 'Asia/Jerusalem',
        })
      ).status(),
    ).toBe(200);

    await page.goto(tableUrl);
    const row = page.locator('div.grid', { hasText: name }).first();
    await expect(row.locator('[data-column-type="date"]')).toHaveText('10/06/2026 1:30 AM');
    // Another year → the timeline shows two-digit years, month first.
    await expect(row.getByTestId('timeline-pill')).toContainText('03/01/27 – 03/05/27');

    // The date picker: weeks start on Monday, Saturday and Sunday are shaded, labels in the format.
    await row.locator('[data-column-type="date"]').click();
    const days = page.locator('[role="grid"] button[data-iso]');
    await expect(days.first()).toBeVisible();
    const first = (await days.first().getAttribute('data-iso'))!;
    expect(new Date(`${first}T00:00:00Z`).getUTCDay()).toBe(1);
    await expect(page.locator('[role="grid"] button[data-iso="2026-10-10"]')).toHaveAttribute('data-weekend', 'true');
    await expect(page.locator('[role="grid"] button[data-iso="2026-10-11"]')).toHaveAttribute('data-weekend', 'true');
    await expect(page.locator('[role="grid"] button[data-iso="2026-10-09"]')).not.toHaveAttribute('data-weekend');
    await expect(page.getByRole('button', { name: '10/15/2026', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');

    // The calendar view follows too.
    await page.goto(calendarUrl);
    const cells = page.getByTestId('calendar-day');
    await expect(cells.first()).toBeVisible();
    expect(new Date(`${(await cells.first().getAttribute('data-day'))!}T00:00:00Z`).getUTCDay()).toBe(1);
    const sunday = cells.nth(6);
    await expect(sunday).toHaveAttribute('data-weekend', 'true');
    await expect(cells.nth(4)).not.toHaveAttribute('data-weekend'); // Friday is a workday here

    // Back to the Israeli defaults: the same values read the other way round, weeks from Sunday.
    await setRegion(israeli);
    await page.goto(tableUrl);
    const again = page.locator('div.grid', { hasText: name }).first();
    await expect(again.locator('[data-column-type="date"]')).toHaveText('06/10/2026 01:30');
    await expect(again.getByTestId('timeline-pill')).toContainText('01/03/27 – 05/03/27');
    await again.locator('[data-column-type="date"]').click();
    const sundayFirst = (await page.locator('[role="grid"] button[data-iso]').first().getAttribute('data-iso'))!;
    expect(new Date(`${sundayFirst}T00:00:00Z`).getUTCDay()).toBe(0);
    await expect(page.locator('[role="grid"] button[data-iso="2026-10-09"]')).toHaveAttribute('data-weekend', 'true');
    await page.keyboard.press('Escape');
  } finally {
    await setRegion({ ...original.settings.locale, ...israeli });
    if (boardId) await page.request.delete(`/api/v1/boards/${boardId}`, { headers });
  }
});
