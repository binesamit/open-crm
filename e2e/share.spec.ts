// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, latestMail, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Product decisions (sync round 3, worktree sync-share):
 * 1. A shareable dashboard shared with a guest by email: the guest joins, finds it in the sidebar and the bell, and
 *    its widgets show only the board shared with them (the private board's numbers never reach them).
 * 2. Starter kits as data: the owner saves boards as a kit in the owner console, edits the first workspace's name,
 *    saves a new version, and picks the kit (with its preview) when creating an account.
 * The sharing dialogs of dashboards / docs are built by the UI session (features/dashboards|docs): the sharing is
 * done through the API here; what is under test is what the guest sees.
 */
test('a dashboard shared with a guest shows them only the boards shared with them', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const post = async (path: string, data: unknown) =>
    (await (await page.request.post(`/api/v1${path}`, { headers, data })).json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = async (name: string, kind: string, amount: number) => {
    const id = (await post('/boards', { name, workspace_id: ws, kind })).id as string;
    await post(`/boards/${id}/columns`, { id: 'amount', title: 'סכום', type: 'numbers' });
    await post(`/boards/${id}/items`, { name: `פריט ${name}`, cells: { amount } });
    return id;
  };
  const shared = await board(`משותף ${tag}`, 'shareable', 70);
  const secret = await board(`סודי ${tag}`, 'private', 9000);
  const dash = await post(`/workspaces/${ws}/dashboards`, {
    name: `דשבורד ללקוח ${tag}`,
    kind: 'shareable',
    board_ids: [shared, secret],
  });
  await post(`/dashboards/${dash.id}/widgets`, {
    type: 'numbers',
    title: 'סך הכול',
    settings: { measure: { fn: 'sum', column: { type: 'numbers', title: 'סכום' } } },
  });

  // Invite a new guest by email to the board and to the dashboard (one account invitation, both on accepting).
  const email = `dash-guest-${tag}@client.test`;
  await post(`/boards/${shared}/invite`, { emails: [email], role: 'guest' });
  const inv = await post(`/dashboards/${dash.id}/invite`, { emails: [email], role: 'guest', level: 'viewer' });
  expect(inv.invited).toHaveLength(1);

  const link = /https?:\/\/\S+\/invite\/[\w-]+/.exec(await latestMail(email))![0];
  const guest = await (await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' })).newPage();
  forbidNativeDialogs(guest);
  await guest.goto(link);
  await guest.getByLabel('שם מלא').fill('אורח דשבורד');
  await guest.getByLabel('סיסמה').fill('a-very-good-password');
  await guest.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await guest.waitForURL(/\/a\/demo/);

  // The sidebar: the shared board and the dashboard — nothing private.
  await expect(guest.getByRole('link', { name: `משותף ${tag}` })).toBeVisible();
  await expect(guest.getByRole('link', { name: `דשבורד ללקוח ${tag}` })).toBeVisible();
  await expect(guest.getByText(`סודי ${tag}`)).toHaveCount(0);

  await guest.getByRole('link', { name: `דשבורד ללקוח ${tag}` }).click();
  await guest.waitForURL(/\/dash\//);
  await expect(guest.getByText('70', { exact: true })).toBeVisible();
  await expect(guest.getByText('9,070')).toHaveCount(0);
  await expect(guest.getByText(`סודי ${tag}`)).toHaveCount(0);
  await guest.screenshot({ path: 'e2e/screens/share-guest-dashboard.png' });

  // Search finds the dashboard for the guest.
  const found = (await (
    await guest.request.get(`/api/v1/search?q=${encodeURIComponent(`ללקוח ${tag}`)}`, {
      headers: { 'x-account-id': headers['x-account-id'] },
    })
  ).json()) as { dashboards: { id: string }[] };
  expect(found.dashboards.map((d) => d.id)).toEqual([dash.id]);
});

test('starter kits as data: save from boards, edit, version, pick when creating an account', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const boardName = `בורד לערכה ${tag}`;
  await page.request.post('/api/v1/boards', { headers, data: { name: boardName, workspace_id: ws } });

  await page.goto('/owner?section=kits');
  const panel = page.getByTestId('owner-starter-kits');
  await expect(panel).toBeVisible();
  await panel.getByTestId('owner-kit-save-from-boards').click();
  const dialog = page.getByTestId('owner-kit-save-dialog');
  await dialog.getByTestId('owner-kit-account').click();
  // This account by its exact name (other local accounts are named "Demo (…)" too).
  const { name: accountName } = (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as {
    name: string;
  };
  await page.getByRole('menu').getByRole('menuitemradio', { name: accountName, exact: true }).first().click();
  await dialog.locator(`[data-testid="owner-kit-board"][data-name="${boardName}"]`).check();
  await dialog.getByTestId('owner-kit-name').fill(`ערכה ${tag}`);
  await dialog.getByTestId('owner-kit-key').fill(`kit-${tag}`);
  await page.getByTestId('owner-kit-create').click();

  // The kit opens in its editor: preview, edit the first workspace's name, a new version.
  const editor = page.getByTestId('owner-kit-editor');
  await expect(editor.getByTestId('owner-kit-preview')).toContainText(boardName);
  await editor.getByTestId('owner-kit-edit-workspace').fill(`מרחב ${tag}`);
  await editor.getByTestId('owner-kit-save').click();
  await expect(editor.getByTestId('owner-kit-versions').locator('li')).toHaveCount(2);
  await expect(editor.getByTestId('owner-kit-preview')).toContainText(`מרחב ${tag}`);
  await page.screenshot({ path: 'e2e/screens/share-kit-editor.png' });
  await page.keyboard.press('Escape');

  // Pick it when creating an account (the Accounts section): its preview shows before creating.
  await page.getByTestId('owner-section-accounts').click();
  await page.getByTestId('owner-kit-picker').click();
  await page.getByTestId(`starter-kit-kit-${tag}`).click();
  await expect(page.getByTestId('owner-kit-preview')).toContainText(`מרחב ${tag}`);

  // Clean up: remove the kit (the owner's confirm dialog, not a native one), back in its section.
  await page.getByTestId('owner-section-kits').click();
  await panel.getByTestId(`owner-kit-kit-${tag}`).getByTestId('owner-kit-remove').click();
  await page.getByRole('alertdialog').getByRole('button').last().click();
  await expect(panel.getByTestId(`owner-kit-kit-${tag}`)).toHaveCount(0);
});
