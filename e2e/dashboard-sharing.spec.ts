// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, openNewBoard, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Round 16 UI specs (UI-SPECS-4):
 * 1. Dashboards sharing: the share dialog switches a dashboard to shareable (the page badge and the sidebar mark
 *    follow) and invites a guest by email.
 * 2. "זרימות" in the sidebar for admins and members.
 * 3. Plans: a suspended plan shows one notice (admins open "My plan" from it, and it works); a read-only plan shows
 *    the banner after the first refused write.
 */
const uid = () => Date.now().toString(36);

test('a dashboard becomes shareable in the share dialog and a guest is invited by email', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = uid();
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const dash = (await (
    await page.request.post(`/api/v1/workspaces/${ws}/dashboards`, { headers, data: { name: `שיתוף ${tag}` } })
  ).json()) as { id: string };
  try {
    await page.goto(`/a/demo/dash/${dash.id}`);
    await expect(page.getByTestId('dashboard-kind')).toHaveAttribute('data-kind', 'main');

    // Kind switch → shareable (saved with PATCH {kind}); the badge and the sidebar mark follow.
    await page.getByTestId('dashboard-share-open').click();
    const dialog = page.getByTestId('dashboard-share');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('dashboard-kind-main')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('dashboard-kind-shareable').click();
    await expect(page.getByTestId('dashboard-kind-shareable')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('dashboard-share-save').click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('dashboard-kind')).toHaveAttribute('data-kind', 'shareable');
    const row = page.locator(`[data-testid="dashboard-row"][data-name="שיתוף ${tag}"]`);
    await expect(row.getByTestId('shareable-mark')).toBeVisible();

    // Invite a new guest by email at "editor" (a guest is never an owner: no owner option for guests).
    await page.getByTestId('dashboard-share-open').click();
    const invite = page.getByTestId('dashboard-invite');
    await expect(page.getByTestId('dashboard-invite-guest')).toHaveAttribute('aria-checked', 'true');
    await invite.getByTestId('dashboard-invite-level').click();
    await expect(page.getByRole('menu').getByRole('menuitemradio', { name: 'בעלים' })).toHaveCount(0);
    await page.getByRole('menu').getByRole('menuitemradio', { name: 'עורך/ת' }).click();
    const email = `r16-dash-guest-${tag}@client.test`;
    await page.getByTestId('dashboard-invite-emails').fill(email);
    await page.getByTestId('dashboard-invite-message').fill('דשבורד בשבילך');
    await page.getByTestId('dashboard-invite-send').click();
    await expect(page.getByTestId('dashboard-invite-result')).toBeVisible();
    await expect(page.getByTestId('dashboard-invite-error')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The invitation is the account's, for a guest, carrying this dashboard.
    const invitations = (await (await page.request.get('/api/v1/users/invitations', { headers })).json()) as {
      data: { email: string; role: string }[];
    };
    expect(invitations.data.find((i) => i.email === email)?.role).toBe('guest');
  } finally {
    await page.request.delete(`/api/v1/dashboards/${dash.id}`, { headers });
  }
});

test('"זרימות" is in the sidebar for admins and members', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo');
  await expect(page.getByTestId('nav-flows')).toBeVisible();
  await page.getByTestId('nav-flows').click();
  await page.waitForURL(/\/a\/demo\/flows/);

  const member = await newTeammate(page, browser, 'חברת זרימות');
  forbidNativeDialogs(member);
  await expect(member.getByTestId('nav-flows')).toBeVisible();
});

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `r16plan-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `חבילה ${id}`, slug, first_admin_email: `r16plan-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { account, invitation } = (await res.json()) as { account: { id: string }; invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('מנהלת חבילה');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, accountId: account.id };
};

test('a suspended plan shows one notice with "My plan"; a read-only plan shows the banner', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  let planId = '';
  try {
    // A workspace first (for the refused write below), then a plan assigned as suspended.
    const headers = { 'x-account-id': accountId };
    const wsList = (await (await admin.request.get('/api/v1/workspaces', { headers })).json()) as {
      data: { id: string }[];
    };
    if (!wsList.data.length) await admin.request.post('/api/v1/workspaces', { headers, data: { name: 'ראשי' } });
    const plan = (await (
      await page.request.post('/api/v1/platform/plans', {
        data: { name: `R16 ${uid()}`, version: { price_monthly: 10, limits: {} } },
      })
    ).json()) as { id: string; current_version_id: string };
    planId = plan.id;
    const assign = (status: string) =>
      page.request.put(`/api/v1/platform/accounts/${accountId}/subscription`, {
        data: { plan_version_id: plan.current_version_id, status },
      });
    expect((await assign('suspended')).ok()).toBe(true);

    await admin.goto(`/a/${slug}`);
    await expect(admin.getByTestId('plan-suspended')).toBeVisible();
    await expect(admin.getByTestId('plan-suspended-message')).toBeVisible();
    await admin.getByTestId('plan-suspended-open').click();
    await admin.waitForURL(new RegExp(`/a/${slug}/admin/plan`));
    // "My plan" answers while suspended: the page is there, not a blank shell.
    await expect(admin.getByTestId('plan-current')).toBeVisible();

    // Read-only: reads work; the first refused write shows the banner (with "My plan" for admins).
    expect((await assign('read_only')).ok()).toBe(true);
    await admin.goto(`/a/${slug}`);
    await expect(admin.getByTestId('plan-suspended')).toHaveCount(0);
    await expect(admin.getByTestId('plan-read-only-banner')).toHaveCount(0);
    await openNewBoard(admin);
    await admin.getByTestId('new-board-name').fill('blocked');
    await admin.getByTestId('new-board-submit').click();
    const banner = admin.getByTestId('plan-read-only-banner');
    await expect(banner).toBeVisible();
    // The banner sits above the page, under the still-open "new board" dialog: close it first.
    await admin.keyboard.press('Escape');
    await expect(admin.getByTestId('new-board-name')).toHaveCount(0);
    await banner.getByTestId('plan-read-only-open').click();
    await admin.waitForURL(new RegExp(`/a/${slug}/admin/plan`));
  } finally {
    await page.request.delete(`/api/v1/platform/accounts/${accountId}/subscription`);
    if (planId) await page.request.patch(`/api/v1/platform/plans/${planId}`, { data: { archived: true } });
  }
});
