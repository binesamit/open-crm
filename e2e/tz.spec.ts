// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * A member who never chose a timezone follows the account's (A3): the admin picks the account's zone in
 * Administration → כללי, the member picks "לפי החשבון" in their profile, and the dates in the table move with the
 * account; a zone of their own still wins. The account and the profile are restored in `finally`.
 */
type Detail = { settings: { locale: Record<string, unknown> } };
type Profile = { timezone: string | null };
const uid = () => Date.now().toString(36);

/** Opens a Picker, searches its (long) list and picks the option. */
const pickZone = async (page: Page, testId: string, search: string, option: RegExp) => {
  await page.getByTestId(testId).click();
  await page.getByTestId('menu-search').fill(search);
  await page.getByRole('menu').getByRole('menuitemradio', { name: option }).click();
};

test('timezone: a member without their own zone follows the account; their own zone wins', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const original = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail;
  const profile = (await (await page.request.get('/api/v1/users/me', { headers })).json()) as Profile;
  const setRegion = (locale: Record<string, unknown>) =>
    page.request.patch('/api/v1/accounts/me', { headers, data: { settings: { locale } } });
  const myZone = async () =>
    ((await (await page.request.get('/api/v1/users/me', { headers })).json()) as Profile).timezone;
  let boardId: string | null = null;
  try {
    await setRegion({ date_format: 'DD/MM/YYYY', time_format: '24h' });
    const ws = (
      (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] }
    ).data[0]!.id;
    const board = (await (
      await page.request.post('/api/v1/boards', { headers, data: { name: `אזור זמן ${uid()}`, workspace_id: ws } })
    ).json()) as { id: string };
    boardId = board.id;
    const date = (
      (await (
        await page.request.post(`/api/v1/boards/${board.id}/columns`, {
          headers,
          data: { title: 'מועד', type: 'date' },
        })
      ).json()) as { id: string }
    ).id;
    const name = `פגישה ${uid()}`;
    // 22:30 UTC on 2026-10-05.
    await page.request.post(`/api/v1/boards/${board.id}/items`, {
      headers,
      data: { name, cells: { [date]: { date: '2026-10-05', time: '22:30' } } },
    });
    const dateCell = () => page.locator('div.grid', { hasText: name }).first().locator('[data-column-type="date"]');

    // The admin sets the account's zone in the UI (a searchable system list, no native select).
    await page.goto('/a/demo/admin/general');
    await pickZone(page, 'admin-timezone', 'Tokyo', /Asia\/Tokyo/);
    await expect(page.getByTestId('admin-timezone')).toHaveText(/Asia\/Tokyo/);
    await expect
      .poll(async () => (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as Detail)
      .toMatchObject({ settings: { locale: { timezone: 'Asia/Tokyo' } } });

    // The member chooses "לפי החשבון" — no zone of their own.
    await page.goto('/a/demo/profile');
    await page.getByTestId('profile-timezone').click();
    await page.getByTestId('profile-timezone-account').click();
    await expect(page.getByTestId('profile-timezone')).toContainText('Tokyo');
    await page.getByTestId('profile-save').click();
    await expect.poll(myZone).toBeNull();

    // Tokyo (+9): 07:30 on the 6th.
    await page.goto(`/a/demo/b/${board.id}`);
    await expect(dateCell()).toHaveText('06/10/2026 07:30');

    // The admin moves the account to London (+1 in October): the member follows.
    expect((await setRegion({ timezone: 'Europe/London' })).status()).toBe(200);
    await page.reload();
    await expect(dateCell()).toHaveText('05/10/2026 23:30');

    // A zone of their own wins over the account's.
    await page.goto('/a/demo/profile');
    await pickZone(page, 'profile-timezone', 'New York', /America\/New York/);
    await page.getByTestId('profile-save').click();
    await expect.poll(myZone).toBe('America/New_York');
    await page.goto(`/a/demo/b/${board.id}`);
    await expect(dateCell()).toHaveText('05/10/2026 18:30');
    expect((await setRegion({ timezone: 'Asia/Tokyo' })).status()).toBe(200);
    await page.reload();
    await expect(dateCell()).toHaveText('05/10/2026 18:30');
  } finally {
    await setRegion(original.settings.locale);
    await page.request.patch('/api/v1/users/me', { headers, data: { timezone: profile.timezone } });
    if (boardId) await page.request.delete(`/api/v1/boards/${boardId}`, { headers });
  }
});
