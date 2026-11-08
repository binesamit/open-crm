// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * plan-lock: the owner closes an account (plan status `closed`, with a message). The account's admin
 * sees the closed screen — the account's name and the owner's message, the offered plans, "contact us", sign-out —
 * and nothing else: Esc does not close it, taking it out of the page shows no app, and the API answers 403
 * `account_closed`. The owner reopens it: the screen goes away by itself and the account works again. Cleans up: the
 * plan is removed from the account and archived.
 */
const uid = () => Date.now().toString(36);

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `lock-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `נעילה ${id}`, slug, first_admin_email: `lock-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { account, invitation } = (await res.json()) as {
    account: { id: string; name: string };
    invitation: { url: string };
  };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('מנהלת נעילה');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, accountId: account.id, name: account.name };
};

test('a closed account shows only the closed screen and the API refuses it; reopening brings it back', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId, name } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  const headers = { 'x-account-id': accountId };
  const planName = `Lock ${uid()}`;
  let planId = '';

  try {
    const plan = (await (
      await page.request.post('/api/v1/platform/plans', {
        data: { name: planName, description: 'הכל כלול', version: { price_monthly: 79, currency: 'ILS' } },
      })
    ).json()) as { id: string; current_version_id: string };
    planId = plan.id;
    const versionId = plan.current_version_id;

    // Open: the app works.
    await admin.goto(`/a/${slug}`);
    await expect(admin.getByTestId('account-closed')).toHaveCount(0);
    await expect(admin.getByTestId('sidebar-collapse')).toBeVisible();
    expect((await admin.request.get('/api/v1/workspaces', { headers })).status()).toBe(200);

    // The owner closes it with a message (the owner console's assignment, as its PUT).
    const closed = await page.request.put(`/api/v1/platform/accounts/${accountId}/subscription`, {
      data: { plan_version_id: versionId, status: 'closed', status_message: 'החשבון נסגר עד להסדרת התשלום' },
    });
    expect(closed.status()).toBe(200);

    // The admin's next screen is the closed screen only.
    await admin.goto(`/a/${slug}`);
    const screen = admin.getByTestId('account-closed');
    await expect(screen).toBeVisible();
    await expect(admin.getByTestId('account-closed-title')).toContainText(name);
    await expect(admin.getByTestId('account-closed-reason')).toHaveText('החשבון נסגר עד להסדרת התשלום');
    await expect(admin.getByTestId(`closed-plan-${planId}`)).toContainText(planName);
    await expect(admin.getByTestId('closed-contact')).toBeVisible();
    await expect(admin.getByTestId('closed-sign-out')).toBeVisible();
    // Nothing of the app is there: no sidebar, no board list.
    await expect(admin.getByTestId('sidebar-collapse')).toHaveCount(0);

    // It cannot be dismissed.
    await admin.keyboard.press('Escape');
    await admin.mouse.click(5, 5);
    await expect(screen).toBeVisible();

    // Taking it out of the page shows nothing — and the API refuses everything of the account.
    await admin.evaluate(() => document.querySelector('[data-testid="account-closed"]')?.remove());
    await expect(admin.getByTestId('sidebar-collapse')).toHaveCount(0);
    for (const path of ['/workspaces', '/boards', '/users/me', '/accounts/me']) {
      const res = await admin.request.get(`/api/v1${path}`, { headers });
      expect(res.status(), path).toBe(403);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe('account_closed');
    }
    // The allowlist answers: who I am, my accounts, the offered plans.
    expect((await admin.request.get('/api/v1/auth/me')).status()).toBe(200);
    expect((await admin.request.get('/api/v1/me/accounts')).status()).toBe(200);
    expect((await admin.request.get('/api/v1/plans/public')).status()).toBe(200);

    // The owner reopens it: the screen goes away and the account works again.
    await admin.reload();
    await expect(admin.getByTestId('account-closed')).toBeVisible();
    const reopened = await page.request.put(`/api/v1/platform/accounts/${accountId}/subscription`, {
      data: { plan_version_id: versionId, status: 'active', status_message: null },
    });
    expect(reopened.status()).toBe(200);
    await admin.reload();
    await expect(admin.getByTestId('account-closed')).toHaveCount(0);
    await expect(admin.getByTestId('sidebar-collapse')).toBeVisible();
    expect((await admin.request.get('/api/v1/workspaces', { headers })).status()).toBe(200);
  } finally {
    await page.request.delete(`/api/v1/platform/accounts/${accountId}/subscription`);
    if (planId) await page.request.patch(`/api/v1/platform/plans/${planId}`, { data: { archived: true } });
  }
});
