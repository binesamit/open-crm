// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Plan feature gates (plans): the owner's version picker lists the gated features (none selected =
 * every feature); an account on a version that lists only some sees, on Administration → My plan, which are
 * included and which are not; a gated action answers 402 and the app shows the plan toast with "upgrade". Cleans up:
 * the subscription is removed and the plan archived.
 */
const uid = () => Date.now().toString(36);

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `feat-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `יכולות ${id}`, slug, first_admin_email: `feat-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { account, invitation } = (await res.json()) as { account: { id: string }; invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('מנהלת יכולות');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, accountId: account.id };
};

test('a plan that lists features: My plan shows included / not included; a gated action is refused', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  const planName = `Docs ${uid()}`;
  let planId = '';
  try {
    // Owner console: the version picker offers the gated features even with an empty catalogue.
    await page.goto('/owner?section=plans');
    await page.getByTestId('plan-new').click();
    const dialog = page.getByTestId('plan-dialog');
    await dialog.getByTestId('plan-name-input').fill(planName);
    await expect(dialog.getByTestId('plan-feature-ai')).toBeVisible();
    await dialog.getByTestId('plan-feature-docs').click();
    await dialog.getByTestId('plan-save').click();
    await expect(page.getByTestId('plan-card').filter({ hasText: planName })).toBeVisible();
    const plans = (await (await page.request.get('/api/v1/platform/plans')).json()) as {
      data: { id: string; name: string; versions: { id: string; features: string[] }[] }[];
    };
    const plan = plans.data.find((p) => p.name === planName)!;
    planId = plan.id;
    expect(plan.versions[0]!.features).toEqual(['docs']);
    expect(
      (
        await page.request.put(`/api/v1/platform/accounts/${accountId}/subscription`, {
          data: { plan_version_id: plan.versions[0]!.id },
        })
      ).ok(),
    ).toBe(true);

    // My plan: docs included, dashboards not (shown, never hidden).
    await admin.goto(`/a/${slug}/admin/plan`);
    const features = admin.getByTestId('plan-features');
    await expect(features).toHaveAttribute('data-all', '0');
    await expect(features.locator('[data-key="docs"]')).toHaveAttribute('data-included', '1');
    await expect(features.locator('[data-key="dashboards"]')).toHaveAttribute('data-included', '0');

    // /me/accounts carries the list the app gates with.
    const mine = (await (await admin.request.get('/api/v1/me/accounts')).json()) as {
      data: { id: string; plan_features: string[] | null }[];
    };
    expect(mine.data.find((a) => a.id === accountId)!.plan_features).toEqual(['docs']);

    // A gated action through the API: 402 with the feature.
    const headers = { 'x-account-id': accountId };
    let ws = ((await (await admin.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
      .data[0];
    if (!ws)
      ws = (await (await admin.request.post('/api/v1/workspaces', { headers, data: { name: 'ראשי' } })).json()) as {
        id: string;
      };
    const refused = await admin.request.post(`/api/v1/workspaces/${ws.id}/dashboards`, {
      headers,
      data: { name: 'x' },
    });
    expect(refused.status()).toBe(402);
    expect(((await refused.json()) as { error: { details: unknown } }).error.details).toEqual({
      feature: 'dashboards',
      upgrade: true,
    });
    expect(
      (await admin.request.post(`/api/v1/workspaces/${ws.id}/docs`, { headers, data: { name: 'ok' } })).status(),
    ).toBe(201);
  } finally {
    await page.request.delete(`/api/v1/platform/accounts/${accountId}/subscription`);
    if (planId) await page.request.patch(`/api/v1/platform/plans/${planId}`, { data: { archived: true } });
  }
});
