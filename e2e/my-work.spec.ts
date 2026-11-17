// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/** M4 step 5 (07 §9.2): My Work — my items by deadline, inline status edit, hide done, group by, customize. */
test('my items by deadline; finish one in place; group by board; hide a board', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);

  // Setup through the API: a board with people / date / status columns and four of my items.
  const accounts = (await (await page.request.get('/api/v1/me/accounts')).json()) as {
    data: { id: string; slug: string }[];
  };
  const accountId = accounts.data.find((a) => a.slug === 'demo')!.id;
  const headers = { 'x-account-id': accountId, origin: WEB_URL };
  const post = async (path: string, data: unknown) =>
    (await (await page.request.post(`/api/v1${path}`, { headers, data })).json()) as Record<string, string>;
  await page.request.patch('/api/v1/me/work/settings', {
    headers,
    data: { hide_done: true, group_by: 'date' },
  });
  const me = ((await (await page.request.get('/api/v1/auth/me')).json()) as { user: { id: string } }).user.id;
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const tag = Date.now().toString(36);
  const boardName = `עבודה ${tag}`;
  const board = (await post('/boards', { name: boardName, workspace_id: ws })).id!;
  const owner = (await post(`/boards/${board}/columns`, { title: 'אחראי', type: 'people' })).id!;
  const due = (await post(`/boards/${board}/columns`, { title: 'יעד', type: 'date' })).id!;
  await post(`/boards/${board}/columns`, { title: 'שלב', type: 'status' });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(new Date());
  const shift = (days: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const mine = { persons_and_teams: [{ kind: 'person', id: me }] };
  const names = { late: `באיחור ${tag}`, now: `היום ${tag}`, later: `בהמשך ${tag}`, none: `בלי תאריך ${tag}` };
  await post(`/boards/${board}/items`, { name: names.late, cells: { [owner]: mine, [due]: { date: shift(-3) } } });
  await post(`/boards/${board}/items`, { name: names.now, cells: { [owner]: mine, [due]: { date: today } } });
  await post(`/boards/${board}/items`, { name: names.later, cells: { [owner]: mine, [due]: { date: shift(45) } } });
  await post(`/boards/${board}/items`, { name: names.none, cells: { [owner]: mine } });

  await page.getByTestId('nav-my-work').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('העבודה שלי');
  const section = (key: string) => page.locator(`[data-testid="mywork-section"][data-key="${key}"]`);
  const row = (name: string) => page.locator(`[data-testid="mywork-row"][data-item-name="${name}"]`);
  await expect(section('past').locator(row(names.late))).toBeVisible();
  await expect(section('today').locator(row(names.now))).toBeVisible();
  await expect(section('later').locator(row(names.later))).toBeVisible();
  await expect(section('no_date').locator(row(names.none))).toBeVisible();
  await expect(section('past')).toContainText('תאריכים שעברו');
  await expect(row(names.now)).toContainText(boardName);

  // Finish it in place: "done" hides it; showing done items brings it back.
  await row(names.now).locator('[data-column="status"]').click();
  await page.getByTestId('popover').getByRole('button', { name: 'הושלם', exact: true }).click();
  await expect(row(names.now)).toHaveCount(0);
  await page.getByTestId('mywork-hide-done').click();
  await expect(row(names.now)).toBeVisible();
  await expect(row(names.now).locator('[data-column="status"]')).toContainText('הושלם');
  await page.getByTestId('mywork-hide-done').click();
  await expect(row(names.now)).toHaveCount(0);

  // Group by board: one section for the board, holding all three remaining items.
  await page.getByTestId('mywork-group-by-board').click();
  await expect(section(board)).toContainText(boardName);
  await expect(section(board).getByTestId('mywork-row')).toHaveCount(3);

  // Customize: hide the board.
  await page.getByTestId('mywork-customize').click();
  const boardRow = page.locator(`[data-testid="mywork-board"][data-name="${boardName}"]`);
  await boardRow.getByTestId('mywork-board-show').click();
  await expect(section(board)).toHaveCount(0);
  await boardRow.getByTestId('mywork-board-show').click();
  await expect(section(board)).toBeVisible();
  await page.getByTestId('mywork-customize-close').click();

  // Back to the default grouping; a name opens the item on its board.
  await page.getByTestId('mywork-group-by-date').click();
  await row(names.late).getByRole('link', { name: names.late }).click();
  await expect(page).toHaveURL(new RegExp(`/b/${board}/i/`));
  await expect(page.getByRole('dialog').getByRole('heading', { level: 2 })).toHaveText(names.late);
});
