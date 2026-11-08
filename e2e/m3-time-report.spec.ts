// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M3 step 7 (03 §3.3): the board time report — by person and by item — and its CSV. */
test('time report: totals by person and item, CSV download', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `שעות ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const boardId = /\/b\/([^/?]+)/.exec(page.url())![1]!;

  // Time is logged through the API (the log UI has its own tests): 90 + 30 minutes on two items.
  const accounts = (await (await page.request.get('/api/v1/me/accounts')).json()) as {
    data: { id: string; slug: string }[];
  };
  const headers = { 'x-account-id': accounts.data.find((a) => a.slug === 'demo')!.id };
  const post = (path: string, data: unknown) => page.request.post(`/api/v1${path}`, { headers, data });
  expect((await post(`/boards/${boardId}/columns`, { id: 'time', title: 'זמן', type: 'time_tracking' })).ok()).toBe(
    true,
  );
  const item = async (n: string) =>
    ((await (await post(`/boards/${boardId}/items`, { name: n })).json()) as { id: string }).id;
  const [a, b] = [await item('Design'), await item('Build')];
  const started = new Date(Date.now() - 6 * 3600_000).toISOString();
  expect(
    (await post(`/items/${a}/time/entries`, { column_id: 'time', started_at: started, duration_s: 5400 })).ok(),
  ).toBe(true);
  expect(
    (await post(`/items/${b}/time/entries`, { column_id: 'time', started_at: started, duration_s: 1800 })).ok(),
  ).toBe(true);
  await page.reload();

  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'דוח שעות', exact: true }).click();
  const report = page.getByTestId('time-report');
  await expect(report.getByTestId('time-report-row')).toHaveCount(1); // one person
  await expect(report.getByTestId('time-report-total')).toContainText('02:00');

  await report.getByTestId('time-report-group').getByRole('radio', { name: 'פריט' }).click();
  await expect(report.locator('[data-testid="time-report-row"][data-label="Design"]')).toContainText('01:30');
  await expect(report.locator('[data-testid="time-report-row"][data-label="Build"]')).toContainText('00:30');

  const download = page.waitForEvent('download');
  await page.getByTestId('time-report-csv').click();
  expect((await download).suggestedFilename()).toMatch(/\.csv$/);
});
