// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Errors & health: a browser error of an account reaches the owner console's "Errors & health"
 * section by itself; the owner finds it, sees that the account's data needs a support grant, acknowledges it,
 * takes it, opens a ticket from it; the settings show the account's admins the browser source on their Health page,
 * where the admin sees the error without support's fields. Needs the i18n fragment errhub.json merged (Hebrew labels).
 */
const uid = () => Date.now().toString(36);

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `eh-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `שגיאות ${id}`, slug, first_admin_email: `eh-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { invitation } = (await res.json()) as { invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('דנה מנהלת');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, id };
};

type Settings = { account_page: { enabled: boolean; sources: string[]; admin_alerts: Record<string, unknown> } };

test('a browser error → the console (grant needed, ack, assign, ticket) → the account admin’s Health page', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, id } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  const original = ((await (await page.request.get('/api/v1/platform/errors/config')).json()) as { settings: Settings })
    .settings;

  try {
    // The account's page reports an error automatically (what lib/client-errors.ts sends).
    const sent = await admin.request.post('/api/v1/client-errors', {
      data: { errors: [{ message: `TypeError: e2e-${id} for dana@client.test`, area: 'window' }], account_slug: slug },
    });
    expect(sent.status()).toBe(200);

    // The owner console: the error is there (the writer flushes within seconds).
    await page.goto('/owner?section=errors');
    await expect(page.getByTestId('errors-hub')).toHaveAttribute('data-role', 'owner');
    // Product decision: no always-on warning triangle in the top bar — alerts count on the "Errors & health" tab instead.
    await expect(page.getByTestId('errors-bell')).toHaveCount(0);
    await expect(page.getByTestId('owner-section-errors')).toContainText('שגיאות ובריאות');
    await page.getByTestId('errors-search').fill(`e2e-${id}`);
    const row = page.locator('[data-testid="error-row"][data-source="client"]');
    await expect(async () => {
      await page.getByTestId('errors-search').fill(`e2e-${id} `);
      await page.getByTestId('errors-search').fill(`e2e-${id}`);
      await expect(row).toHaveCount(1, { timeout: 2000 });
    }).toPass({ timeout: 30_000 });
    await expect(row).not.toContainText('dana@client.test');
    await row.click();
    const detail = page.getByTestId('error-detail');
    // No grant to this account: metadata only, and the way to ask for access.
    await expect(detail).toHaveAttribute('data-access', 'none');
    await expect(detail.getByTestId('error-request-access')).toBeVisible();
    await expect(detail.getByTestId('error-open-account')).toHaveCount(0);
    // Acknowledge, then a ticket from the error.
    await detail.getByTestId('error-ack').click();
    await expect(detail).toHaveAttribute('data-status', 'acknowledged');
    await detail.getByTestId('error-ticket-create').click();
    await page.getByRole('dialog').getByRole('button', { name: 'פתיחת פנייה מהשגיאה' }).click();
    await expect(detail.getByTestId('error-ticket-open')).toBeVisible();

    // Settings: the account's admins also see browser errors on their Health page.
    await page.getByTestId('errors-tab-settings').click();
    const account = page.getByTestId('errors-settings-account');
    const chip = account.locator('[data-testid="errors-account-sources"] [data-source="client"]');
    if ((await chip.getAttribute('aria-pressed')) !== 'true') await chip.click();
    await account.getByTestId('errors-settings-account-save').click();
    await expect(page.getByTestId('toast')).toBeVisible();

    // The admin's Health page: the error, without support's fields.
    await admin.goto(`/a/${slug}/admin/health`);
    const health = admin.locator('[data-testid="health-row"][data-source="client"]');
    await expect(health).toHaveCount(1);
    await expect(health).toContainText(`e2e-${id}`);
    await expect(admin.getByTestId('admin-health')).not.toContainText('#');
    // The open errors count on Administration → Health (not an icon in the sidebar).
    await expect(admin.getByTestId('admin-nav-health-count')).toHaveText(/^[1-9]\d*\+?$/);
    await expect(admin.getByTestId('errors-bell')).toHaveCount(0);
  } finally {
    await page.request.patch('/api/v1/platform/errors/settings', { data: { account_page: original.account_page } });
  }
});
