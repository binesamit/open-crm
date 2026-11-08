// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser } from '@playwright/test';
import { forbidNativeDialogs, latestMail, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * The minimum password length is a setting (product owner: "הסיסמה לא צריכה להיות עם 10 תווים, שתהיה עד 8
 * תווים"): the owner's platform default (8), an account's own (Administration → Security, empty = the platform's),
 * and every password form shows the minimum that applies.
 */
const ORIGIN = WEB_URL;
const uid = () => Date.now().toString(36);
const freshPage = async (browser: Browser) =>
  (await browser.newContext({ baseURL: ORIGIN, locale: 'he-IL' })).newPage();

test('the invitation sign-up shows the minimum (8 by default); 7 characters are refused, 8 accepted', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const config = (await (await page.request.get('/api/v1/auth/config')).json()) as { password_min_length: number };
  expect(config.password_min_length).toBe(8);

  const email = `pass8-${uid()}@demo.test`;
  await page.request.post('/api/v1/users/invite', { headers, data: { emails: [email], role: 'member' } });
  const invite = /https?:\/\/\S+\/invite\/[\w-]+/.exec(await latestMail(email))![0];
  const p = await freshPage(browser);
  forbidNativeDialogs(p);
  await p.goto(invite);
  await expect(p.getByText('לפחות 8 תווים')).toBeVisible();
  await p.getByLabel('שם מלא').fill('שמונה תווים');
  await p.getByTestId('invite-password').fill('1234567');
  await p.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await expect(p.getByTestId('invite-error')).toHaveText('לפחות 8 תווים');
  await p.getByTestId('invite-password').fill('12345678');
  await p.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await p.waitForURL(/\/a\/demo/);
  await p.context().close();
});

test("an admin sets the account's minimum to 12; the profile's password form follows; cleared, back to 8", async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  try {
    await page.goto('/a/demo/admin/security');
    const panel = page.getByTestId('security-password-policy');
    await expect(panel).toBeVisible();
    const input = page.getByTestId('password-min-length');
    await expect(input).toHaveAttribute('placeholder', '8');
    await input.fill('5');
    await expect(page.getByTestId('password-min-length-invalid')).toBeVisible();
    await expect(page.getByTestId('password-min-length-save')).toBeDisabled();
    await input.fill('12');
    await page.getByTestId('password-min-length-save').click();
    await expect
      .poll(
        async () =>
          ((await (await page.request.get('/api/v1/security', { headers })).json()) as Json).password_min_length,
      )
      .toBe(12);

    await page.goto('/a/demo/profile?tab=security');
    await expect(page.getByTestId('profile-security')).toBeVisible();
    await expect(page.getByText('לפחות 12 תווים')).toBeVisible();
    const has = await page.getByTestId('profile-security').getAttribute('data-has-password');
    if (has === 'true') await page.getByTestId('security-current').fill('whatever-current');
    await page.getByTestId('security-new').fill('12345678901');
    await page.getByTestId('security-confirm').fill('12345678901');
    await page.getByTestId('security-save').click();
    await expect(page.getByTestId('security-done')).toHaveCount(0);
    await expect(page.getByTestId('profile-security').getByText('לפחות 12 תווים').first()).toBeVisible();

    await page.goto('/a/demo/admin/security');
    await page.getByTestId('password-min-length').fill('');
    await page.getByTestId('password-min-length-save').click();
    await expect
      .poll(
        async () =>
          ((await (await page.request.get('/api/v1/security', { headers })).json()) as Json).password_min_length,
      )
      .toBeNull();
  } finally {
    await page.request.patch('/api/v1/security', { headers, data: { password_min_length: null } });
  }
});

test('the owner changes the platform default; the public config and the account placeholder follow', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  try {
    await page.goto('/owner?section=general');
    await expect(page.getByTestId('owner-platform-settings')).toBeVisible();
    await page.getByTestId('owner-password-min-length').fill('9');
    await page.getByTestId('owner-platform-save').click();
    await expect
      .poll(async () => ((await (await page.request.get('/api/v1/auth/config')).json()) as Json).password_min_length)
      .toBe(9);
    await page.goto('/a/demo/admin/security');
    await expect(page.getByTestId('password-min-length')).toHaveAttribute('placeholder', '9');
  } finally {
    await page.request.patch('/api/v1/platform/settings', {
      headers: { origin: ORIGIN },
      data: { password: { min_length: 8 } },
    });
    await page.request.patch('/api/v1/security', { headers, data: { password_min_length: null } });
  }
});

type Json = Record<string, unknown>;
