// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M1.1 #11: time tracking — several timers at once, time log with manual entry, edit, delete. */
const label = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

/** One click opens one panel; hour then minute (the minute closes it) — no typing, no native picker. */
const setTime = async (page: Page, scope: Locator, field: string, hh: string, mm: string) => {
  await scope.getByRole('button', { name: field, exact: true }).click();
  const panel = page.getByRole('dialog', { name: field });
  await panel
    .getByRole('listbox', { name: `${field} — שעות` })
    .getByRole('option', { name: hh, exact: true })
    .click();
  await expect(panel).toBeVisible(); // still open after the hour
  await panel
    .getByRole('listbox', { name: `${field} — דקות` })
    .getByRole('option', { name: mm, exact: true })
    .click();
  await expect(panel).toBeHidden();
  await expect(scope.getByRole('button', { name: field, exact: true })).toHaveText(`${hh}:${mm}`);
};

test('track time with the timer and by hand', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`זמנים ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'מעקב זמן', exact: true }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const n of ['משימה א', 'משימה ב']) {
    await add.fill(n);
    await add.press('Enter');
  }
  const cell = (n: string) =>
    page.locator('div.grid', { hasText: n }).first().locator('[data-column-type="time_tracking"]');
  const startStop = (n: string, name: 'הפעלת טיימר' | 'עצירת טיימר') => cell(n).getByRole('button', { name });

  // ▶ on א: the cell counts live.
  await cell('משימה א').hover();
  await startStop('משימה א', 'הפעלת טיימר').click();
  await expect(startStop('משימה א', 'עצירת טיימר')).toBeVisible();
  await expect(cell('משימה א').getByTestId('cell-value')).toHaveText(/00:00:0[1-9]/, { timeout: 5000 });

  // ▶ on ב too: both run at once (no timer in the shell).
  await cell('משימה ב').hover();
  await startStop('משימה ב', 'הפעלת טיימר').click();
  await expect(startStop('משימה ב', 'עצירת טיימר')).toBeVisible();
  await expect(startStop('משימה א', 'עצירת טיימר')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'תפריט' }).getByText('משימה')).toHaveCount(0);

  // ⏸ each one in its own cell.
  await startStop('משימה ב', 'עצירת טיימר').click();
  await startStop('משימה א', 'עצירת טיימר').click();
  await expect(page.getByRole('button', { name: 'עצירת טיימר' })).toHaveCount(0);

  // The value opens the time log; add yesterday 09:00–10:30 by hand.
  await cell('משימה א').getByTestId('cell-value').click();
  const log = page.getByTestId('time-log');
  await expect(log.getByTestId('time-entry')).toHaveCount(1);
  await log.getByRole('button', { name: /הוספת רשומה/ }).click();
  const form = log.getByTestId('time-form');
  await form.getByRole('button', { name: 'תאריך' }).click();
  const yesterday = new Date(Date.now() - 86_400_000);
  await page
    .getByTestId('popover')
    .getByRole('button', { name: label(yesterday), exact: true })
    .click();
  // Only one popup at a time, also inside the item card: opening the time closes the calendar.
  await form.getByRole('button', { name: 'תאריך' }).click();
  await expect(page.getByTestId('popover')).toBeVisible();
  await form.getByRole('button', { name: 'התחלה', exact: true }).click();
  await expect(page.getByTestId('popover')).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'התחלה' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'התחלה' })).toBeHidden();
  await expect(log).toBeVisible(); // Esc closed the picker, not the item card
  await form.getByRole('button', { name: 'תאריך' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('popover')).toBeHidden();
  await expect(log).toBeVisible();
  await setTime(page, form, 'התחלה', '09', '00');
  await setTime(page, form, 'סיום', '10', '30');
  await form.getByLabel('הערה').fill('שיחה עם לקוח');
  await form.getByRole('button', { name: 'שמירה' }).click();
  await expect(log.getByTestId('time-entry')).toHaveCount(2);
  const manual = log.getByTestId('time-entry').filter({ hasText: 'שיחה עם לקוח' });
  await expect(manual).toContainText('ידני');
  await expect(manual).toContainText('01:30:00');

  // By duration: yesterday 13:15 + 00:45 (keyboard works in the minutes list too).
  await log.getByRole('button', { name: /הוספת רשומה/ }).click();
  const byDuration = log.getByTestId('time-form');
  await byDuration.getByRole('button', { name: 'תאריך' }).click();
  await page
    .getByTestId('popover')
    .getByRole('button', { name: label(yesterday), exact: true })
    .click();
  await setTime(page, byDuration, 'התחלה', '13', '15');
  await byDuration.getByRole('button', { name: 'לפי משך' }).click();
  await setTime(page, byDuration, 'משך', '00', '45');
  await byDuration.getByLabel('הערה').fill('תיקון קטן');
  await byDuration.getByRole('button', { name: 'שמירה' }).click();
  await expect(log.getByTestId('time-entry').filter({ hasText: 'תיקון קטן' })).toContainText('00:45:00');
  // Edit / delete live in the entry's ⋯ menu (canvas Item-Time).
  await log.getByTestId('time-entry').filter({ hasText: 'תיקון קטן' }).getByTestId('time-entry-more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'מחיקה' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(log.getByTestId('time-entry')).toHaveCount(2);

  // Edit → marked as edited; the total follows.
  await manual.getByTestId('time-entry-more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'עריכה' }).click();
  await setTime(page, log.getByTestId('time-form'), 'סיום', '11', '00');
  await log.getByTestId('time-form').getByRole('button', { name: 'שמירה' }).click();
  const edited = log.getByTestId('time-entry').filter({ hasText: 'שיחה עם לקוח' });
  await expect(edited).toContainText('02:00:00');
  await expect(edited).toContainText('נערך');
  await expect(log.getByTestId('time-total')).toHaveText(/^02:00:0\d$/);

  // Delete through the system dialog.
  await edited.getByTestId('time-entry-more').click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'מחיקה' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(log.getByTestId('time-entry')).toHaveCount(1);
});
