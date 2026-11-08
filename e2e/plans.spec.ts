// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Subscription plans (stages 1–3): the owner writes a plan in the owner console (prices, limits)
 * assigns it to an account from the accounts list with a per-account override; the account's admin sees
 * Administration → My plan (usage bars, upgrade text); at the limit only the next board is refused, with a toast
 * whose action opens My plan. Cleans up: the plan is removed from the account and archived.
 */
const uid = () => Date.now().toString(36);

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `plan-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `חבילות ${id}`, slug, first_admin_email: `plan-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { account, invitation } = (await res.json()) as { account: { id: string }; invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('מנהלת חבילות');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, accountId: account.id };
};

test('owner writes a plan, assigns it with an override; the admin sees My plan and hits the board limit', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  const planName = `Pro ${uid()}`;
  let planId = '';

  try {
    // Owner console → Plans: a new plan with its first version (no plan is built in).
    await page.goto('/owner?section=plans');
    await expect(page.getByTestId('owner-plans')).toBeVisible();
    await page.getByTestId('plan-new').click();
    const dialog = page.getByTestId('plan-dialog');
    await dialog.getByTestId('plan-name-input').fill(planName);
    await dialog.getByTestId('plan-price-monthly').fill('49.90');
    await dialog.getByTestId('plan-price-yearly').fill('499');
    await dialog.getByTestId('plan-limit-boards').fill('20');
    await dialog.getByTestId('plan-limit-seats').fill('5');
    await dialog.getByTestId('plan-save').click();
    const card = page.getByTestId('plan-card').filter({ hasText: planName });
    await expect(card).toBeVisible();
    await expect(page.getByTestId('plan-version').filter({ hasText: '49.90' }).first()).toBeVisible();
    const plans = (await (await page.request.get('/api/v1/platform/plans')).json()) as {
      data: { id: string; name: string }[];
    };
    planId = plans.data.find((p) => p.name === planName)!.id;

    // An empty account has no boards since starter kits became data: give it one, so the override below is full.
    const headers = { 'x-account-id': accountId };
    let ws = ((await (await admin.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
      .data[0];
    if (!ws)
      ws = (await (await admin.request.post('/api/v1/workspaces', { headers, data: { name: 'ראשי' } })).json()) as {
        id: string;
      };
    expect(
      (await admin.request.post('/api/v1/boards', { headers, data: { name: 'first', workspace_id: ws.id } })).ok(),
    ).toBe(true);

    // Accounts list → the account's plan: this version, with a boards override = the boards it has now.
    const boards = (await (
      await admin.request.get('/api/v1/boards', { headers: { 'x-account-id': accountId } })
    ).json()) as { data: unknown[] };
    // The accounts are their own console section.
    await page.getByTestId('owner-section-accounts').click();
    const row = page.locator('tr', { hasText: `/a/${slug}` });
    await expect(row.getByTestId('account-plan')).toHaveAttribute('data-status', 'legacy');
    await row.getByTestId('owner-account-plan').click();
    const assign = page.getByTestId('account-plan-dialog');
    await assign.getByTestId('account-plan-version').click();
    await page.getByTestId(`account-plan-version-${planName}-1`).click();
    await assign.getByTestId('override-on-boards').click();
    await assign.getByTestId('override-value-boards').fill(String(boards.data.length));
    await assign.getByTestId('account-plan-save').click();
    await expect(assign).toHaveCount(0);
    await expect(row.getByTestId('account-plan')).toHaveAttribute('data-status', 'active');

    // The admin's My plan: the plan, the bars (boards full), the upgrade text.
    await admin.goto(`/a/${slug}/admin/plan`);
    await expect(admin.getByTestId('plan-name')).toHaveText(planName);
    await expect(admin.getByTestId('plan-usage').and(admin.locator('[data-kind="boards"]'))).toHaveAttribute(
      'data-pct',
      '100',
    );
    await expect(admin.getByTestId('plan-usage').and(admin.locator('[data-kind="seats"]'))).toBeVisible();
    await admin.getByTestId('plan-upgrade').click();
    await expect(admin.getByTestId('plan-upgrade-dialog')).toBeVisible();
    await admin.keyboard.press('Escape');

    // At the limit: a new board is refused with a friendly toast; its action opens My plan.
    await admin.goto(`/a/${slug}`);
    await openNewBoard(admin);
    await admin.getByTestId('new-board-name').fill('one too many');
    await admin.getByTestId('new-board-submit').click();
    const toast = admin.getByTestId('toast').filter({ hasText: /בורדים/ });
    await expect(toast).toBeVisible();
    await toast.getByTestId('toast-action').click();
    await admin.waitForURL(new RegExp(`/a/${slug}/admin/plan`));
  } finally {
    await page.request.delete(`/api/v1/platform/accounts/${accountId}/subscription`);
    if (planId) await page.request.patch(`/api/v1/platform/plans/${planId}`, { data: { archived: true } });
  }
});

test('owner billing settings: the upgrade text an admin sees is the owner’s', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const before = (await (await page.request.get('/api/v1/platform/billing-settings')).json()) as {
    upgrade_text?: string;
  };
  try {
    await page.goto('/owner?section=plans');
    const card = page.getByTestId('billing-settings');
    await card.getByTestId('billing-upgrade-text').fill('דברו איתנו בוואטסאפ');
    await card.getByTestId('billing-save').click();
    await expect
      .poll(
        async () =>
          ((await (await page.request.get('/api/v1/platform/billing-settings')).json()) as { upgrade_text?: string })
            .upgrade_text,
      )
      .toBe('דברו איתנו בוואטסאפ');
  } finally {
    await page.request.patch('/api/v1/platform/billing-settings', {
      data: { upgrade_text: before.upgrade_text ?? null },
    });
  }
});
