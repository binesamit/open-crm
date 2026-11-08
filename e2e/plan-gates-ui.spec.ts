// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Plan feature gates in the UI (plans): on a plan version that lists only `docs`, the gated controls
 * stay visible but `aria-disabled` with the upgrade hint (`data-tip`), the admin gets "Upgrade" to My plan, and a
 * click does nothing. Covers tokens (`api`), agents (`ai`), the guest role of the invite form (`guests`) and flows
 * (`flows`, when a platform is offered). Cleans up: the subscription is removed and the plan archived.
 */
const uid = () => Date.now().toString(36);

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `gate-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `שערים ${id}`, slug, first_admin_email: `gate-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { account, invitation } = (await res.json()) as { account: { id: string }; invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('מנהלת שערים');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, accountId: account.id };
};

const expectGated = async (page: Page, testId: string, feature: string) => {
  const el = page.getByTestId(testId).first();
  await expect(el).toBeVisible();
  await expect(el).toHaveAttribute('aria-disabled', 'true');
  await expect(el).toHaveAttribute('data-plan-gated', feature);
  await expect(el).toHaveAttribute('data-tip', /.+/);
  await expect(page.getByTestId(`plan-upgrade-${feature}`).first()).toHaveAttribute('href', /\/admin\/plan$/);
};

test('a plan without api / ai / guests / flows: the controls stay visible, disabled, with the upgrade hint', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  let planId = '';
  try {
    const plan = (await (
      await page.request.post('/api/v1/platform/plans', {
        data: { name: `Gates ${uid()}`, version: { price_monthly: 10, limits: {}, features: ['docs'] } },
      })
    ).json()) as { id: string; current_version_id: string };
    planId = plan.id;
    expect(
      (
        await page.request.put(`/api/v1/platform/accounts/${accountId}/subscription`, {
          data: { plan_version_id: plan.current_version_id },
        })
      ).ok(),
    ).toBe(true);

    // Tokens (`api`): the new-token buttons are disabled; a click opens nothing.
    await admin.goto(`/a/${slug}/profile?tab=tokens`);
    await expectGated(admin, 'token-new', 'api');
    // aria-disabled: Playwright would wait for it to be enabled — the click is forced to prove it does nothing.
    await admin.getByTestId('token-new').click({ force: true });
    await expect(admin.getByTestId('token-create-dialog')).toHaveCount(0);

    // Agents (`ai`): "new agent" is shown, disabled, and does not navigate.
    await admin.goto(`/a/${slug}/agents`);
    await expect(admin.getByTestId('agents-page')).toBeVisible();
    if (await admin.getByTestId('agent-new').count()) {
      await expectGated(admin, 'agent-new', 'ai');
      await admin.getByTestId('agent-new').click({ force: true });
      await expect(admin).toHaveURL(new RegExp(`/a/${slug}/agents$`));
    }

    // Invite (`guests`): the guest role is listed but cannot be picked; the note offers "Upgrade".
    await admin.goto(`/a/${slug}/admin/users`);
    await admin.getByTestId('users-invite-open').click();
    await expect(admin.getByTestId('plan-gate-note-guests').first()).toBeVisible();
    await expect(admin.getByTestId('plan-upgrade-guests').first()).toHaveAttribute('href', /\/admin\/plan$/);
    await admin.getByTestId('invite-role').first().click();
    await expect(admin.getByTestId('invite-role-guest')).toBeDisabled();

    // Flows (`flows`): "new connection" when the account is offered a platform.
    await admin.goto(`/a/${slug}/flows`);
    await expect(admin.getByTestId('flows-page')).toBeVisible();
    if (await admin.getByTestId('flow-connection-add').count()) {
      await expectGated(admin, 'flow-connection-add', 'flows');
      await admin.getByTestId('flow-connection-add').click({ force: true });
      await expect(admin.getByTestId('flow-connection-dialog')).toHaveCount(0);
    }

    // Back on a plan with every feature: the same controls work again (nothing was hidden or removed).
    await page.request.delete(`/api/v1/platform/accounts/${accountId}/subscription`);
    await admin.goto(`/a/${slug}/profile?tab=tokens`);
    await expect(admin.getByTestId('token-new')).not.toHaveAttribute('aria-disabled', 'true');
  } finally {
    await page.request.delete(`/api/v1/platform/accounts/${accountId}/subscription`);
    if (planId) await page.request.patch(`/api/v1/platform/plans/${planId}`, { data: { archived: true } });
  }
});
