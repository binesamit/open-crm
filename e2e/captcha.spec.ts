// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Cloudflare Turnstile in layers: the account's keys + master switch (Administration → Security)
 * each form's own mode (inherit / on / off) and the platform's sign-in screens (owner console). Uses Cloudflare's
 * public test keys (always pass) — nothing real is checked. Every setting changed here is put back.
 */
const ADMIN = '/a/demo/admin';
const TEST_SITE = '1x00000000000000000000AA';
const TEST_SECRET = '1x0000000000000000000000000000000AA';

const resetAccount = async (page: Page, headers: Record<string, string>) => {
  await page.request.patch('/api/v1/security/captcha', {
    headers,
    data: { enabled: false, surfaces: { forms: 'inherit' } },
  });
  await page.request.patch('/api/v1/security/captcha', { headers, data: { secret: null, site_key: '' } });
};

test('account Turnstile: "on" needs keys; keys + master switch; forms inherit, or choose on/off', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  await resetAccount(page, headers);

  await page.goto(`${ADMIN}/security`);
  const panel = page.getByTestId('security-captcha');
  await expect(panel).toBeVisible();
  // No keys: the master switch and "on" cannot be chosen, and the page says why.
  await expect(page.getByTestId('account-captcha-master')).toBeDisabled();
  await expect(page.getByTestId('account-captcha-mode-forms-on')).toBeDisabled();
  await expect(page.getByTestId('account-captcha-mode-forms-why')).toBeVisible();

  // Keys: the site key saves on Enter, the secret with its button (and is never shown again).
  await page.getByTestId('account-captcha-keys-site').fill(TEST_SITE);
  await page.getByTestId('account-captcha-keys-site').press('Enter');
  await page.getByTestId('account-captcha-keys-secret').fill(TEST_SECRET);
  await page.getByTestId('account-captcha-keys-secret-save').click();
  await expect(page.getByTestId('account-captcha-master')).toBeEnabled();
  await expect(page.getByTestId('account-captcha-keys-secret')).toHaveValue('');
  // The switch shows what the server saved (it turns on when the save returns), so click and wait — `check()`
  // demands the new state at once.
  await page.getByTestId('account-captcha-master').click();
  await expect(page.getByTestId('account-captcha-master')).toBeChecked();
  await expect(page.getByTestId('account-captcha-mode-forms-state')).toContainText('פעיל');
  // While something is on, the secret cannot be removed.
  await expect(page.getByTestId('account-captcha-keys-secret-remove')).toBeDisabled();

  // A form follows the account by default.
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `קפצ'ה ${Date.now()}`, workspace_id: ws } })
  ).json()) as { id: string };
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('view-add').click();
  await page.getByTestId('view-add-form').click();
  await page.getByRole('dialog').getByRole('textbox').fill('טופס');
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  await expect(page.getByTestId('form-view')).toBeVisible();
  const mode = page.getByTestId('form-captcha-mode');
  await expect(mode.getByTestId('form-captcha-mode-inherit')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('form-captcha-mode-state')).toContainText('פעיל');

  const link = await page.getByTestId('form-link').inputValue();
  const visitor = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void visitor.close().catch(() => undefined));
  const pub = await visitor.newPage();
  await pub.goto(link);
  await expect(pub.getByTestId('public-form-captcha')).toHaveCount(1);

  // Off for this form only: the public page asks nothing (honeypot and rate limit stay).
  await page.getByTestId('form-captcha-mode-off').click();
  await expect(page.getByTestId('form-captcha-mode-state')).toContainText('כבוי');
  await expect
    .poll(async () => {
      await pub.goto(link);
      return pub.getByTestId('public-form-captcha').count();
    })
    .toBe(0);

  await resetAccount(page, headers);
});

test('owner console: the sign-in screens have their own Turnstile, off by default', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner?section=security');
  const card = page.getByTestId('owner-captcha');
  await expect(card).toBeVisible();
  for (const place of ['sign_in', 'sign_up', 'forgot_password'])
    await expect(page.getByTestId(`platform-captcha-place-${place}`)).toBeVisible();
  const cfg = (await (await page.request.get('/api/v1/auth/config')).json()) as { captcha: { site_key: null } };
  if (!cfg.captcha.site_key) {
    await expect(page.getByTestId('platform-captcha-master')).toBeDisabled();
    await expect(page.getByTestId('platform-captcha-mode-sign_in-on')).toBeDisabled();
  }
  // The sign-in screen shows no widget while the platform's Turnstile is off.
  const ctx = await page.context().browser()!.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  const login = await ctx.newPage();
  await login.goto('/login');
  if (!cfg.captcha.site_key) await expect(login.getByTestId('captcha-sign_in')).toHaveCount(0);
  await ctx.close();
});
