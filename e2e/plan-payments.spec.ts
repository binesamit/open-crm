// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Paid upgrade through Stripe (self sign-up ה9): the owner sets up "Plan payments" in the owner console (the shared
 * Stripe keys, a price per plan), turns it on; the account admin's My plan → Upgrade then offers the plan and interval
 * and goes to the checkout page. Stripe itself is never called: the checkout request is answered in the browser with
 * a return to the app (?checkout=cancel), so the round trip back is checked too. Restores the settings afterwards.
 */
const uid = () => Date.now().toString(36);
type Payments = { enabled: boolean; secret_key_set: boolean; webhook_secret_set: boolean };

test('owner sells a plan through Stripe; the admin’s Upgrade opens checkout and comes back', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const before = (await (await page.request.get('/api/v1/platform/plan-payments')).json()) as Payments;
  const planRes = await page.request.post('/api/v1/platform/plans', {
    data: { name: `Stripe ${id}`, version: { price_monthly: 99, price_yearly: 990 } },
  });
  expect(planRes.ok()).toBe(true);
  const plan = (await planRes.json()) as { id: string; current_version_id: string };
  const slug = `pay-${id}`;
  const accRes = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `תשלום ${id}`, slug, first_admin_email: `pay-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(accRes.status()).toBe(201);
  const { account, invitation } = (await accRes.json()) as { account: { id: string }; invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });

  try {
    expect(
      (
        await page.request.put(`/api/v1/platform/accounts/${account.id}/subscription`, {
          data: { plan_version_id: plan.current_version_id, status: 'trial' },
        })
      ).ok(),
    ).toBe(true);

    // Owner console → Plans → Plan payments: keys, the plan's monthly price, on.
    await page.goto('/owner?section=plans');
    const card = page.getByTestId('plan-payments');
    await expect(card).toBeVisible();
    if (!before.secret_key_set) await card.getByTestId('plan-payments-secret').fill('sk_test_51E2eFakeKeyForPlans');
    if (!before.webhook_secret_set)
      await card.getByTestId('plan-payments-webhook-secret').fill('whsec_E2eFakeSigningSecret1');
    const row = card.locator(`[data-testid="plan-payments-plan"][data-plan="${plan.id}"]`);
    await row.getByTestId('plan-payments-price-month').fill('price_E2eMonthly01');
    const saved = page.waitForResponse(
      (r) => r.url().includes('/platform/plan-payments') && r.request().method() === 'PATCH',
    );
    await card.getByTestId('plan-payments-save').click();
    expect((await saved).ok()).toBe(true);
    if (!before.enabled) await card.getByTestId('plan-payments-switch').click();
    await expect(card.getByTestId('plan-payments-state')).toHaveAttribute('data-ready', 'yes');

    // The admin: My plan → Upgrade → plan + interval → "checkout" (answered here) → back with a notice.
    const admin = await context.newPage();
    forbidNativeDialogs(admin);
    await admin.goto(invitation.url);
    await admin.getByLabel('שם מלא').fill('מנהלת תשלום');
    await admin.getByLabel('סיסמה').fill('a-very-good-password');
    await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
    await admin.waitForURL(new RegExp(`/a/${slug}`));
    let sent: unknown = null;
    await admin.route('**/api/v1/plan/checkout', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      sent = route.request().postDataJSON();
      await route.fulfill({ json: { url: `${WEB_URL}/a/${slug}/admin/plan?checkout=cancel` } });
    });
    await admin.goto(`/a/${slug}/admin/plan`);
    await admin.getByTestId('plan-upgrade').click();
    const dialog = admin.getByTestId('plan-checkout-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('plan-checkout-plan').click();
    await admin.getByTestId(`plan-checkout-plan-${plan.id}`).click();
    await expect(dialog.getByTestId('plan-checkout-interval-year')).toHaveCount(0);
    await admin.getByTestId('plan-checkout-go').click();
    await expect(admin.getByTestId('plan-checkout-cancel')).toBeVisible();
    expect(sent).toMatchObject({ plan_id: plan.id, interval: 'month' });
  } finally {
    await context.close().catch(() => undefined);
    await page.request.patch('/api/v1/platform/plan-payments', {
      data: {
        enabled: before.enabled,
        prices: { [plan.id]: { month: null, year: null } },
        ...(before.secret_key_set ? {} : { secret_key: null }),
        ...(before.webhook_secret_set ? {} : { webhook_secret: null }),
      },
    });
    await page.request.delete(`/api/v1/platform/accounts/${account.id}/subscription`);
    await page.request.patch(`/api/v1/platform/plans/${plan.id}`, { data: { archived: true } });
  }
});
