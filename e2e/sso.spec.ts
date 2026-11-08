// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Plan — sign-in providers: the owner console's "ספקי התחברות" (Google / Microsoft credentials, the return
 * address to copy, a step guide, write-only secrets), the sign-in page's buttons following it at once, and the
 * account's "sign in through Google / Microsoft only" policy with its gate screen. No real provider is contacted.
 */
const ORIGIN = WEB_URL;
const ADMIN = '/a/demo/admin';
const SECRET = 'GOCSPX-e2e-secret-value-9876';

const clearProviders = async (page: Page) => {
  for (const p of ['google', 'microsoft'])
    await page.request.patch(`/api/v1/platform/login-providers/${p}`, {
      headers: { origin: ORIGIN },
      data: { enabled: true, client_id: null, client_secret: null, ...(p === 'microsoft' ? { tenant_id: null } : {}) },
    });
};

test('owner console: save Google and Microsoft; the sign-in page shows the buttons; the secret never comes back', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await clearProviders(page);
  await page.goto('/owner?section=security');
  const google = page.getByTestId('login-provider-google');
  await expect(google).toBeVisible();
  await expect(page.getByTestId('login-provider-google-redirect')).toHaveValue(/\/api\/auth\/callback\/google$/);
  await expect(page.getByTestId('login-provider-microsoft-redirect')).toHaveValue(/\/api\/auth\/callback\/microsoft$/);
  await expect(page.getByTestId('login-provider-google-guide')).toBeVisible();

  await page.getByTestId('login-provider-google-client-id').fill('e2e-client.apps.googleusercontent.com');
  await page.getByTestId('login-provider-google-secret').fill(SECRET);
  await page.getByTestId('login-provider-google-save').click();
  await expect(google).toHaveAttribute('data-active', '1');
  await expect(page.getByTestId('login-provider-google-secret')).toHaveValue('');

  await page.reload();
  await expect(page.getByTestId('login-provider-google-secret')).toHaveAttribute('placeholder', /9876/);
  expect(await page.content()).not.toContain(SECRET);

  await page.getByTestId('login-provider-microsoft-client-id').fill('11111111-2222-3333-4444-555555555555');
  await page.getByTestId('login-provider-microsoft-secret').fill('ms~e2e~secret');
  await page.getByTestId('login-provider-microsoft-save').click();
  await expect(page.getByTestId('login-provider-microsoft')).toHaveAttribute('data-active', '1');

  const guest = await (await browser.newContext({ baseURL: ORIGIN, locale: 'he-IL' })).newPage();
  await guest.goto('/login');
  await expect(guest.getByTestId('login-google')).toBeVisible();
  await expect(guest.getByTestId('login-microsoft')).toBeVisible();

  // Switched off in the console → gone from the sign-in page, without a restart.
  await page.getByTestId('login-provider-microsoft-enabled').click();
  await expect(page.getByTestId('login-provider-microsoft')).toHaveAttribute('data-active', '0');
  await guest.reload();
  await expect(guest.getByTestId('login-google')).toBeVisible();
  await expect(guest.getByTestId('login-microsoft')).toHaveCount(0);
  await guest.context().close();
  await clearProviders(page);
});

test('account policy: members who signed in with a password meet the "sign in with Google" screen', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  await clearProviders(page);
  await page.request.patch('/api/v1/platform/login-providers/google', {
    headers: { origin: ORIGIN },
    data: { client_id: 'e2e-client', client_secret: SECRET },
  });
  const mate = await newTeammate(page, browser, 'חובת ספק');

  await page.goto(`${ADMIN}/security`);
  const panel = page.getByTestId('security-sso');
  await expect(panel).toBeVisible();
  // The owner is the platform owner: always exempt, so saving does not lock them out.
  await page.getByTestId('security-sso-required').click();
  await expect(page.getByTestId('security-sso-required')).toBeChecked();

  await mate.reload();
  await expect(mate.getByTestId('sso-gate')).toBeVisible();
  await expect(mate.getByTestId('sso-gate-google')).toBeVisible();
  await expect(page.getByTestId('admin-security')).toBeVisible();

  await page.getByTestId('security-sso-required').click();
  await expect(page.getByTestId('security-sso-required')).not.toBeChecked();
  await mate.reload();
  await expect(mate.getByTestId('sso-gate')).toHaveCount(0);

  await page.request.patch('/api/v1/security', { headers, data: { sso: { required: false } } });
  await clearProviders(page);
});
