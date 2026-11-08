// SPDX-License-Identifier: AGPL-3.0-only
import { type Browser, expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, latestMail, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Self sign-up (D32, plan stages ה2 + ה4 + ה5 UI): closed by default (the closed screen, no link on the sign-in page);
 * the owner turns it on in the console card (what the test environment needs: a public default plan, Turnstile
 * not required); a password sign-up → the email link → the new account with its first steps and trial pill → an
 * upgrade request; manual approval → "being reviewed" → the owner approves in the queue → the person signs in; the
 * accounts table's "source" filter; the trial emails' settings. Every platform setting changed here is put back.
 */
const uid = () => Date.now().toString(36);
const WEB = WEB_URL;
const PASSWORD = 'a-very-good-password';
type Settings = Record<string, unknown> & { settings: Record<string, unknown> };

let original: Record<string, unknown> | null = null;
let planId = '';

const settingsOf = async (page: Page) =>
  (await (await page.request.get('/api/v1/platform/signup-settings')).json()) as Settings;
const patchSettings = async (page: Page, data: Record<string, unknown>) => {
  const res = await page.request.patch('/api/v1/platform/signup-settings', { headers: { origin: WEB }, data });
  expect(res.status(), await res.text()).toBe(200);
};

/** A public plan of its own (no trial days: the sign-up setting's 14 apply) and room for repeated runs. */
const prepare = async (page: Page) => {
  const s = (await settingsOf(page)).settings;
  original ??= {
    enabled: s.enabled,
    approval: s.approval,
    require_captcha: s.require_captcha,
    default_plan_id: s.default_plan_id,
    rate_ip_hour: s.rate_ip_hour,
    daily_cap: s.daily_cap,
    trial_days: s.trial_days,
  };
  if (!planId) {
    const res = await page.request.post('/api/v1/platform/plans', {
      headers: { origin: WEB },
      data: { name: `הרשמה ${uid()}`, version: { trial_days: 0 } },
    });
    planId = ((await res.json()) as { id: string }).id;
  }
  // Every run starts from many sign-ups from this one address.
  await patchSettings(page, { rate_ip_hour: 1000, daily_cap: 100000, trial_days: 14 });
};

test.afterAll(async ({ browser }) => {
  if (!original) return;
  const page = await (await browser.newContext({ baseURL: WEB, locale: 'he-IL' })).newPage();
  await signIn(page);
  await patchSettings(page, { ...original, enabled: false });
  await page.context().close();
});

const visitor = async (browser: Browser) => {
  const context = await browser.newContext({ baseURL: WEB, locale: 'he-IL' });
  const page = await context.newPage();
  forbidNativeDialogs(page);
  return page;
};

/** Fills the form and sends it; returns the verification link from the email. */
const signUp = async (page: Page, who: { name: string; org: string; email: string }) => {
  await page.goto('/signup');
  await expect(page.getByTestId('signup-page')).toBeVisible();
  await page.getByTestId('signup-name').fill(who.name);
  await page.getByTestId('signup-org').fill(who.org);
  await page.getByTestId('signup-email').fill(who.email);
  await page.getByTestId('signup-password').fill(PASSWORD);
  if (await page.getByTestId(`signup-plan-${planId}`).count()) await page.getByTestId(`signup-plan-${planId}`).click();
  if (await page.getByTestId('legal-consent-checkbox').count())
    await page.getByTestId('legal-consent-checkbox').check();
  await page.getByTestId('signup-submit').click();
  await expect(page.getByTestId('signup-check-email')).toBeVisible();
  await expect(page.getByTestId('signup-check-address')).toHaveText(who.email);
  // "Send again" waits for the cooldown.
  await expect(page.getByTestId('signup-resend')).toBeDisabled();
  const mail = await latestMail(who.email);
  return /\/signup\/verify#token=[\w-]+/.exec(mail)![0];
};

test('closed by default: the closed screen, and no sign-up link on the sign-in page', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await prepare(page);
  await patchSettings(page, { enabled: false });
  const v = await visitor(browser);
  await v.goto('/signup');
  await expect(v.getByTestId('signup-closed')).toContainText('ההרשמה סגורה כרגע');
  await v.goto('/login');
  await expect(v.getByLabel('אימייל')).toBeVisible();
  await expect(v.getByTestId('login-signup')).toHaveCount(0);
  await v.context().close();
});

test('the owner turns sign-up on in the console card: readiness, plan, Turnstile off here', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await prepare(page);
  await patchSettings(page, { enabled: false, require_captcha: true });
  await page.goto('/owner?section=signup');
  const card = page.getByTestId('signup-settings');
  await card.scrollIntoViewIfNeeded();
  await expect(card.getByTestId('signup-settings-state')).toHaveText('כבויה');
  await expect(card.getByTestId('signup-readiness')).toBeVisible();
  await expect(card.getByTestId('signup-ready-email')).toHaveAttribute('data-ok', 'true');
  await expect(card.getByTestId('signup-ready-legal')).toHaveAttribute('data-ok', 'true');

  await card.getByTestId('signup-set-plan').click();
  await page.getByTestId(`signup-set-plan-${planId}`).click();
  // The test environment has no real Turnstile keys: not required here.
  await card.getByTestId('signup-set-captcha').click();
  await expect(card.getByTestId('signup-set-captcha')).not.toBeChecked();
  await card.getByTestId('signup-set-enabled').click();
  await card.getByTestId('signup-settings-save').click();
  await expect(card.getByTestId('signup-settings-state')).toHaveText('פתוחה');
  await expect(card.getByTestId('signup-readiness')).toHaveAttribute('data-missing', '');

  // The trial emails: a switch and days each, kept after a reload.
  await card.getByTestId('signup-email-reminder_first-days').fill('5');
  await card.getByTestId('signup-settings-save').click();
  await expect
    .poll(
      async () => ((await settingsOf(page)).settings.emails as Record<string, { days: number }>).reminder_first?.days,
    )
    .toBe(5);
  await page.reload();
  await expect(page.getByTestId('signup-email-reminder_first-days')).toHaveValue('5');
  await page.getByTestId('signup-email-reminder_first-days').fill('3');
  await page.getByTestId('signup-settings-save').click();
  await expect
    .poll(
      async () => ((await settingsOf(page)).settings.emails as Record<string, { days: number }>).reminder_first?.days,
    )
    .toBe(3);

  const v = await visitor(browser);
  await v.goto('/login');
  await v.getByTestId('login-signup').click();
  await expect(v).toHaveURL(/\/signup$/);
  await expect(v.getByTestId('signup-trial')).toContainText('14');
  await v.context().close();
});

test('password sign-up → email link → the new account: first steps, trial pill, upgrade request', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  await prepare(page);
  await patchSettings(page, { enabled: true, approval: false, require_captcha: false, default_plan_id: planId });

  const id = uid();
  const who = { name: 'דנה לוי', org: `סטודיו ${id}`, email: `signup-${id}@signup.test` };
  const v = await visitor(browser);
  const link = await signUp(v, who);
  await v.goto(link);
  await expect(v.getByTestId('signup-preparing')).toBeVisible();
  await v.waitForURL(/\/a\/[a-z0-9-]+$/);
  const slug = /\/a\/([a-z0-9-]+)/.exec(v.url())![1]!;

  // First steps (in place of the welcome card): open by themselves for the new admin; closed, they
  // come back from the help menu.
  const steps = v.getByTestId('first-steps');
  await expect(steps).toBeVisible();
  await expect(v.getByTestId('first-step-joined')).toBeVisible();
  await v.getByTestId('first-steps-close').click();
  await expect(steps).toHaveCount(0);
  await v.getByTestId('help-menu').first().click();
  await v.getByTestId('help-first-steps').click();
  await expect(steps).toBeVisible();
  await v.getByTestId('first-steps-close').click();

  // The trial pill → "My plan" → ask for an upgrade (three an hour per account; the fourth is refused).
  await expect(v.getByTestId('trial-pill').first()).toContainText('נשארו 14 ימי ניסיון');
  await v.getByTestId('trial-pill-upgrade').first().click();
  await expect(v).toHaveURL(new RegExp(`/a/${slug}/admin/plan`));
  await v.getByTestId('plan-upgrade-request').click();
  await v.getByTestId('plan-upgrade-request-note').fill('צריכים עוד משתמשים');
  await v.getByTestId('plan-upgrade-request-send').click();
  await expect(v.getByTestId('plan-upgrade-request-sent')).toBeVisible();
  const accountId = (
    (await (await v.request.get('/api/v1/me/accounts')).json()) as { data: { id: string; slug: string }[] }
  ).data.find((a) => a.slug === slug)!.id;
  for (let i = 0; i < 2; i++)
    await v.request.post('/api/v1/plan/upgrade-request', {
      headers: { origin: WEB, 'x-account-id': accountId },
      data: {},
    });
  await v.getByTestId('plan-upgrade-request').click();
  await v.getByTestId('plan-upgrade-request-send').click();
  await expect(v.getByTestId('plan-upgrade-request-error')).toContainText('כבר נשלחה בקשת שדרוג');

  // The same link again: used.
  await v.context().clearCookies();
  await v.goto(link);
  await expect(v.getByTestId('signup-verify-invalid')).toBeVisible();
  await v.context().close();

  // The owner console: "source" filter.
  await page.goto('/owner?section=accounts');
  await page.getByTestId('owner-accounts-origin-signup').click();
  const row = page.locator('tr', { hasText: who.org });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('owner-account-origin')).toHaveAttribute('data-origin', 'signup');
  await expect(page.locator('[data-testid="owner-account-origin"][data-origin="owner"]')).toHaveCount(0);
  await page.getByTestId('owner-accounts-trial-trial').click();
  await expect(row).toBeVisible();
  await page.getByTestId('owner-accounts-origin-owner').click();
  await expect(row).toHaveCount(0);
});

test('manual approval: "being reviewed", the owner approves in the queue, the person signs in', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  await prepare(page);
  await patchSettings(page, { enabled: true, approval: true, require_captcha: false, default_plan_id: planId });

  const id = uid();
  const who = { name: 'אורי כהן', org: `ארגון ${id}`, email: `approve-${id}@signup.test` };
  const v = await visitor(browser);
  const link = await signUp(v, who);
  await v.goto(link);
  await expect(v.getByTestId('signup-pending')).toBeVisible();
  await expect(v.getByTestId('signup-pending-details')).toContainText(who.org);

  await page.goto('/owner?section=signup-requests');
  const queue = page.getByTestId('signup-requests');
  await expect(queue).toBeVisible();
  const row = queue.getByTestId(`signup-request-${who.email}`);
  await expect(row).toContainText(`${who.org} · ${who.name}`);
  await row.getByTestId('signup-request-approve').click();
  await expect(row).toHaveCount(0);
  await queue.getByTestId('signup-requests-tab-provisioned').click();
  await expect(queue.getByTestId(`signup-request-${who.email}`)).toBeVisible();

  // The account works: sign in with the password chosen at sign-up.
  await v.goto('/login');
  await v.getByLabel('אימייל').fill(who.email);
  await v.getByLabel('סיסמה').fill(PASSWORD);
  await v.locator('form button[type="submit"]').click();
  await v.waitForURL(/\/a\/[a-z0-9-]+/);
  // The new admin starts with their first steps.
  await expect(v.getByTestId('first-steps')).toBeVisible();
  await v.context().close();

  await patchSettings(page, { approval: false });
});
