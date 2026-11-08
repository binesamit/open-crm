// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Remote support access: an account admin lets the platform's support in (view only) from
 * Administration → Security; the owner console shows "enter support" only while the grant is active; inside, the
 * support banner shows and changes are refused; revoking ends it. The owner console's support settings are there.
 * Needs <SupportBanner> mounted in the account layout (see the report of the sync-support branch).
 */
const uid = () => Date.now().toString(36);

/** A new account whose first admin is a fresh person (the owner is not a member there). */
const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `sup-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `תמיכה ${id}`, slug, first_admin_email: `sup-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { account, invitation } = (await res.json()) as { account: { id: string }; invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('מנהלת תמיכה');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, accountId: account.id };
};

test('an admin grants view-only support; the owner enters with the banner; writes are refused; revoke ends it', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId } = await newAccount(page, browser);
  forbidNativeDialogs(admin);

  // No grant: no "enter support" on this account's row (other local accounts may hold a grant), it does not open.
  await page.goto('/owner?section=support');
  await expect(page.getByTestId('owner-support-settings')).toBeVisible();
  await page.getByTestId('owner-section-accounts').click();
  const accountRow = page.locator('tr', { hasText: `/a/${slug}` });
  await expect(accountRow).toBeVisible();
  await expect(accountRow.getByTestId('owner-enter-support')).toHaveCount(0);
  expect((await page.request.get('/api/v1/accounts/me', { headers: { 'x-account-id': accountId } })).status()).toBe(
    404,
  );

  // The admin grants (view only is the default; edit is off in the account).
  await admin.goto(`/a/${slug}/admin/security`);
  await admin.getByTestId('support-grant-open').click();
  await expect(admin.getByTestId('support-mode-edit')).toHaveCount(0);
  await admin.getByTestId('support-duration-4').click();
  await admin.getByTestId('support-reason').fill('בדיקת אוטומציה שלא רצה');
  await admin.getByTestId('support-grant-submit').click();
  const row = admin.getByTestId('support-grant-row').first();
  await expect(row).toHaveAttribute('data-status', 'active');
  await expect(row).toHaveAttribute('data-mode', 'view');

  // The owner console now offers "enter support"; inside, the banner and no writes.
  await page.goto('/owner?section=accounts');
  await accountRow.getByTestId('owner-enter-support').click();
  await page.waitForURL(new RegExp(`/a/${slug}`));
  await expect(page.getByTestId('support-banner')).toHaveAttribute('data-mode', 'view');
  const write = await page.request.post('/api/v1/workspaces', {
    headers: { 'x-account-id': accountId },
    data: { name: 'by support' },
  });
  expect(write.status()).toBe(405);

  // The admin's audit log shows the entry; revoke ends the access at once.
  await admin.goto(`/a/${slug}/admin/security`);
  await admin.getByTestId('support-revoke').first().click();
  await admin
    .getByRole('alertdialog')
    .getByRole('button', { name: /ביטול גישה|Revoke/ })
    .click();
  await expect(admin.getByTestId('support-grant-row').first()).toHaveAttribute('data-status', 'revoked');
  expect((await page.request.get('/api/v1/accounts/me', { headers: { 'x-account-id': accountId } })).status()).toBe(
    404,
  );
  await page.goto('/owner?section=accounts');
  await expect(accountRow).toBeVisible();
  await expect(accountRow.getByTestId('owner-enter-support')).toHaveCount(0);
});

test('the owner recovery link without a grant offers the emergency path; the admin sees and cancels it', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId } = await newAccount(page, browser);
  const email = ((await (await admin.request.get('/api/v1/auth/me')).json()) as { user: { email: string } }).user.email;
  const res = await page.request.post(`/api/v1/platform/accounts/${accountId}/recovery-link`, { data: { email } });
  expect(res.status()).toBe(403);
  const asked = await page.request.post(`/api/v1/platform/accounts/${accountId}/emergency-recovery`, {
    data: { email, reason: 'e2e' },
  });
  expect(asked.status()).toBe(201);
  await page.goto('/owner?section=emergency');
  await expect(page.getByTestId('owner-emergency-row').first()).toHaveAttribute('data-status', 'waiting');

  await admin.goto(`/a/${slug}/admin/security`);
  const req = admin.getByTestId('support-emergency-row').first();
  await expect(req).toHaveAttribute('data-status', 'waiting');
  await req.getByTestId('support-emergency-cancel').click();
  await admin
    .getByRole('alertdialog')
    .getByRole('button', { name: /ביטול הבקשה|Cancel request/ })
    .click();
  await expect(admin.getByTestId('support-emergency-row').first()).toHaveAttribute('data-status', 'cancelled');
});
