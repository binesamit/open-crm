// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Hebrew dates, holidays and working days. The account turns Hebrew dates on (also in cells) and counts
 * durations in working days; a date on Yom Kippur 5787 and a timeline over the Tishrei holidays then show the Hebrew
 * date, the holiday and the counted length; the settings section and the owner's card list the holidays.
 * E2E_SHOTS_DIR=<dir> also saves screenshots of each surface (the visual pass against the approved canvas).
 */
const shot = async (target: Page | Locator, name: string) => {
  const dir = process.env.E2E_SHOTS_DIR;
  if (dir) await target.screenshot({ path: `${dir}/${name}.png` });
};

/** A new view of a type from the "+" menu (as in timeline-gantt.spec). */
const newView = async (page: Page, type: string, name: string) => {
  await page.getByTestId('view-add').click();
  await page.getByRole('menuitem', { name: new RegExp(type) }).click();
  await page.getByRole('dialog').getByRole('textbox').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('view-tab').filter({ hasText: name })).toHaveAttribute('aria-selected', 'true');
};

test('Hebrew dates, holidays and working days', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const setCalendar = (calendar: Record<string, unknown>) =>
    page.request.patch('/api/v1/accounts/me', { headers, data: { settings: { calendar } } });
  expect((await setCalendar({ hebrew_dates: 'cells', duration: 'workdays' })).ok()).toBe(true);
  try {
    const ws = (
      (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] }
    ).data[0]!.id;
    const board = (await (
      await page.request.post('/api/v1/boards', {
        headers,
        data: { name: `לוח עברי ${Date.now().toString(36)}`, workspace_id: ws },
      })
    ).json()) as { id: string };
    const col = (data: Record<string, unknown>) =>
      page.request.post(`/api/v1/boards/${board.id}/columns`, { headers, data });
    const due = (await (await col({ id: 'due', title: 'תאריך יעד', type: 'date' })).json()) as { id: string };
    await col({ id: 'tl', title: 'ציר זמן', type: 'timeline', settings: { show_duration: true } });
    await page.request.post(`/api/v1/boards/${board.id}/items`, {
      headers,
      data: { name: 'השקת אתר', cells: { due: { date: '2026-09-21' }, tl: { from: '2026-09-17', to: '2026-09-30' } } },
    });

    await page.goto(`/a/demo/b/${board.id}`);
    const row = page.locator('[data-testid="item-row"][data-item-name="השקת אתר"]');
    await expect(row).toBeVisible();
    // The date cell: the Hebrew date under it. The timeline cell: the counted length (Fri+Sat, Rosh Hashanah week:
    // 17–30/09 = 14 days, 10 weekdays, minus Yom Kippur, Sukkot and half of the two eves = 8.5 working days).
    await expect(row.locator('[data-column-type="date"]')).toContainText('י׳ בתשרי');
    await expect(row.locator('[data-column-type="timeline"]')).toContainText('8.5 ימי עבודה');
    // The table's pill stays plain (the product owner, 13/10): the skipped days show only in the timeline / gantt view.
    await expect(row.getByTestId('timeline-pill').locator('[data-testid="pill-gap"]')).toHaveCount(0);
    await shot(row, 'cells');

    // The picker: Hebrew months under the title, a Hebrew letter under each day, the chosen day's line.
    await row.locator('[data-column-type="date"]').click();
    await expect(page.getByTestId('calendar-hebrew-months')).toContainText('תשרי');
    await expect(page.getByTestId('hebrew-day').first()).toBeVisible();
    await expect(page.getByTestId('calendar-footnote')).toContainText('י׳ בתשרי תשפ״ז');
    await expect(page.getByTestId('calendar-footnote')).toContainText('יום כיפור');
    await expect(page.getByRole('button', { name: /21\/09\/2026/ })).toHaveCSS('font-weight', '400');
    // Days off / half days are a small dot, never a fill (the product owner, canvas board י option 2). The chosen day (Yom Kippur)
    // hides its dot under the selection, so Rosh Hashanah carries the "off" dot and its eve the "half" one.
    await expect(page.locator('[data-iso="2026-09-12"] [data-testid="day-dot"][data-state="off"]')).toHaveCount(1);
    await expect(page.locator('[data-iso="2026-09-20"] [data-testid="day-dot"][data-state="half"]')).toHaveCount(1);
    await expect(page.locator('[data-iso="2026-09-21"] [data-testid="day-dot"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /21\/09\/2026/ })).not.toHaveClass(/bg-danger-soft/);
    await expect(page.getByTestId('calendar-footnote')).toContainText('יום כיפור');
    await shot(page, 'picker');
    await page.keyboard.press('Escape');

    // The column turns the marks off: no dots in its picker.
    const marksOff = await page.request.patch(`/api/v1/boards/${board.id}/columns/${due.id}`, {
      headers,
      data: { settings: { day_marks: 'off' } },
    });
    expect(marksOff.ok()).toBe(true);
    await page.reload();
    await expect(row).toBeVisible();
    await row.locator('[data-column-type="date"]').click();
    await expect(page.getByTestId('hebrew-day').first()).toBeVisible();
    await expect(page.getByTestId('day-dot')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Gantt: the bar keeps one outline, its non-counting days are hatched gaps (Yom Kippur among them).
    await newView(page, 'גאנט', 'גאנט');
    await page.getByTestId('timeline-zoom').locator('[data-zoom="day"]').click();
    await expect(page.getByTestId('timeline')).toHaveAttribute('data-zoom', 'day');
    const bar = page.locator('[data-testid="timeline-bar"][data-item-name="השקת אתר"]');
    await bar.scrollIntoViewIfNeeded();
    await expect(bar).toHaveAttribute('data-from', '2026-09-17');
    await expect(bar.locator('[data-testid="bar-gap"][data-day="2026-09-21"]')).toHaveCount(1);
    await expect(bar.locator('[data-testid="bar-gap"][data-day="2026-09-22"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="axis-tick"][data-day="2026-09-21"]')).toHaveCount(1);
    await expect(page.getByTestId('axis-skip')).toHaveCount(0);
    await shot(page.getByTestId('timeline'), 'gantt-gaps');

    // "Working days only" (a view setting): no column for Yom Kippur, a marker says what was skipped.
    await page.getByTestId('toolbar-view-settings').click();
    await page.getByTestId('timeline-working-days-only').click();
    await expect(page.getByTestId('timeline-working-days-only')).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid="axis-tick"][data-day="2026-09-21"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="axis-tick"][data-day="2026-09-22"]')).toHaveCount(1);
    await expect(page.getByTestId('axis-skip').first()).toBeAttached();
    await expect(page.locator('[data-testid="axis-skip"][data-day="2026-09-21"]')).toHaveAttribute(
      'data-tip',
      /יום כיפור/,
    );
    // The bar has no gap where there is no column; its dates are unchanged.
    await expect(bar.locator('[data-testid="bar-gap"][data-day="2026-09-21"]')).toHaveCount(0);
    await expect(bar).toHaveAttribute('data-to', '2026-09-30');
    await bar.scrollIntoViewIfNeeded();
    await shot(page.getByTestId('timeline'), 'gantt-workdays-only');

    // Administration → General: the calendar section with the holidays and their states.
    await page.goto('/a/demo/admin/general');
    const holidays = page.getByTestId('admin-calendar-holidays');
    await expect(holidays).toBeVisible();
    await expect(holidays.locator('[data-testid="admin-calendar-holiday"][data-key="yom_kippur"]')).toBeVisible();
    await holidays.scrollIntoViewIfNeeded();
    await shot(page, 'admin-calendar');

    // The owner console: the platform defaults.
    await page.goto('/owner?section=general');
    const owner = page.getByTestId('owner-calendar');
    await expect(owner).toBeVisible();
    await expect(owner.locator('[data-testid="owner-calendar-holiday"][data-key="yom_haatzmaut"]')).toBeVisible();
    await owner.scrollIntoViewIfNeeded();
    await shot(owner, 'owner-calendar');
  } finally {
    await setCalendar({ hebrew_dates: null, duration: null });
  }
});
