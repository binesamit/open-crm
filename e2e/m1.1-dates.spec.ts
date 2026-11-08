// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M1.1 #8: system calendar for date and timeline cells (range picking: start, then end). */
const iso = (d: Date) => d.toISOString().slice(0, 10);
const shown = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`; // cell text
const label = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`; // day button (the account's date format, A3)
// Timeline pill: day/month, plus a two-digit year outside the current year (formatTimeline).
const short = (s: string) =>
  s.slice(0, 4) === String(new Date().getFullYear())
    ? `${s.slice(8, 10)}/${s.slice(5, 7)}`
    : `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}`;

test('pick a date and a timeline range from the calendar', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);

  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תאריכים ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of ['תאריך', 'ציר זמן']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const name = `משימה ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: name }).first();
  await expect(row).toBeVisible();

  // Date: next month via the arrow, then the 15th.
  const now = new Date();
  const next15 = iso(new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 15)));
  await row.locator('[data-column-type="date"]').click();
  await page.getByRole('button', { name: 'החודש הבא' }).click();
  await page.getByRole('button', { name: label(next15), exact: true }).click();
  await expect(row.locator('[data-column-type="date"]')).toHaveText(shown(next15));

  // Timeline, next month: 5th → start, 12th → end (saved), 20th → new start, 3rd → becomes start, 20th end.
  // Next month's days: a range that never ends before today (on the 13th, the 3rd–12th of this month was already
  // overdue — a red pill and "באיחור").
  const day = (n: number) => iso(new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, n)));
  const timeline = row.locator('[data-column-type="timeline"]');
  await timeline.click();
  await page.getByRole('button', { name: 'החודש הבא' }).click();
  await page.getByRole('button', { name: label(day(5)), exact: true }).click();
  await expect(page.getByTestId('range-to')).toHaveText(/—/);
  await page.getByRole('button', { name: label(day(12)), exact: true }).click();
  await expect(timeline).toContainText(`${short(day(5))} – ${short(day(12))}`);
  await timeline.getByTestId('timeline-pill').hover();
  await expect(page.getByTestId('timeline-days')).toBeVisible();
  await expect(page.getByTestId('timeline-days')).toHaveText('8 ימים');
  await page.getByRole('button', { name: label(day(20)), exact: true }).click();
  await expect(page.getByTestId('range-from')).toContainText(label(day(20)));
  await page.getByRole('button', { name: label(day(3)), exact: true }).click();
  await expect(timeline).toContainText(`${short(day(3))} – ${short(day(20))}`);

  // Year arrows and the month grid move the view without changing the value.
  await page.getByRole('button', { name: 'השנה הבאה' }).click();
  await page.getByRole('button', { name: 'בחירת חודש' }).click();
  await expect(page.getByRole('button', { name: 'בחירת חודש' })).toHaveText(String(Number(day(1).slice(0, 4)) + 1));
  await page.keyboard.press('Escape');

  await page.reload();
  const saved = page.locator('div.grid', { hasText: name }).first();
  await expect(saved.locator('[data-column-type="date"]')).toHaveText(shown(next15));
  await expect(saved.locator('[data-column-type="timeline"]')).toContainText(`${short(day(3))} – ${short(day(20))}`);
});
