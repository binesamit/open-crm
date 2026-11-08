// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Support tickets: an account admin opens a ticket (the auto-attached context is shown and can be
 * removed); the platform owner works it in the owner console's Support section — an internal note the customer never
 * sees, a public reply, a request for access; the admin approves with one click; the support banner shows the
 * ticket's number; solving the ticket ends the access; the customer rates the support.
 * The "?" test needs <HelpMenu> mounted in the TopBar (see the report of the sync-tickets branch).
 */
const uid = () => Date.now().toString(36);

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `tk-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `פניות ${id}`, slug, first_admin_email: `tk-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { account, invitation } = (await res.json()) as { account: { id: string }; invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('דנה מנהלת');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, accountId: account.id };
};

test('open → note + reply → access request → one-click approve → banner with the ticket → solve ends access → rate', async ({
  page,
  browser,
}) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId } = await newAccount(page, browser);
  forbidNativeDialogs(admin);

  // The customer opens a ticket from "My tickets"; the attached context is listed and removable.
  await admin.goto(`/a/${slug}/support`);
  await admin.getByTestId('ticket-new').click();
  await admin.getByTestId('ticket-subject').fill('עמודת סטטוס לא נשמרת');
  await admin.getByTestId('ticket-description').fill('אחרי רענון הערך חוזר לקודם');
  await expect(admin.getByTestId('ticket-context')).toBeVisible();
  const browserItem = admin.locator('[data-testid="ticket-context-item"][data-key="browser"]');
  await browserItem.getByTestId('ticket-context-toggle').click();
  await expect(browserItem).toHaveAttribute('data-kept', 'false');
  await admin.getByTestId('ticket-submit').click();
  await admin.waitForURL(new RegExp(`/a/${slug}/support/[0-9A-Z]{26}`));
  const number = ((await admin.getByTestId('ticket-number').textContent()) ?? '').replace('#', '').trim();
  expect(Number(number)).toBeGreaterThan(0);

  // The owner works it in the console's Support section.
  await page.goto('/owner?section=support');
  await expect(page.getByTestId('support-console')).toHaveAttribute('data-role', 'owner');
  await page.getByTestId('support-search').fill(number);
  await page.locator(`[data-testid="support-ticket-row"][data-number="${number}"]`).click();
  const ticket = page.getByTestId('console-ticket');
  await expect(ticket.getByTestId('console-ticket-number')).toHaveText(`#${number}`);
  await expect(ticket.getByTestId('console-context')).toBeVisible();
  // An internal note, then a public reply.
  await ticket.getByTestId('console-visibility-internal').click();
  await ticket.getByTestId('console-reply').fill('נראה כמו בעיית מטמון');
  await ticket.getByTestId('console-send').click();
  await expect(ticket.locator('[data-testid="console-message"][data-visibility="internal"]')).toHaveCount(1);
  await ticket.getByTestId('console-visibility-public').click();
  await ticket.getByTestId('console-reply').fill('אפשר לנקות מטמון ולנסות שוב?');
  await ticket.getByTestId('console-send').click();
  await expect(ticket).toHaveAttribute('data-status', 'open');
  // Request access (view, the default duration).
  await ticket.getByTestId('console-request-access').click();
  await page.getByTestId('console-access-reason').fill('לבדוק את הבורד');
  await page.getByTestId('console-access-send').click();
  await expect(ticket.getByTestId('console-access-request').first()).toHaveAttribute('data-status', 'pending');

  // The customer: the reply, no internal note; approve with one click.
  await admin.reload();
  await expect(admin.locator('[data-testid="ticket-message"][data-kind="staff"]')).toHaveCount(1);
  await expect(admin.getByText('נראה כמו בעיית מטמון')).toHaveCount(0);
  await admin.getByTestId('ticket-access-approve').click();
  await expect(admin.getByTestId('ticket-access-request').first()).toHaveAttribute('data-status', 'approved');

  // The owner enters the account under the grant: the banner names the ticket; writes are refused (view).
  await page.goto(`/a/${slug}`);
  await expect(page.getByTestId('support-banner')).toHaveAttribute('data-mode', 'view');
  await expect(page.getByTestId('support-banner-ticket')).toContainText(number);
  const write = await page.request.post('/api/v1/workspaces', {
    headers: { 'x-account-id': accountId },
    data: { name: 'by support' },
  });
  expect(write.status()).toBe(405);

  // Solving the ticket ends the access at once.
  await page.goto('/owner?section=support');
  await page.getByTestId('support-filter-status').click();
  await page.getByRole('menuitemradio', { name: /הכול|All/ }).click();
  await page.getByTestId('support-search').fill(number);
  await page.locator(`[data-testid="support-ticket-row"][data-number="${number}"]`).click();
  await page.getByTestId('console-status').click();
  await page.getByTestId('console-status-solved').click();
  await expect(page.getByTestId('console-ticket')).toHaveAttribute('data-status', 'solved');
  expect((await page.request.get('/api/v1/accounts/me', { headers: { 'x-account-id': accountId } })).status()).toBe(
    404,
  );

  // The customer rates the support.
  await admin.reload();
  await admin.getByTestId('ticket-rate-5').click();
  await admin.getByTestId('ticket-rate-save').click();
  await expect(admin.getByTestId('toast')).toBeVisible();
});

test('the "?" menu opens the ticket form (needs <HelpMenu> in the TopBar)', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin } = await newAccount(page, browser);
  await admin.getByTestId('help-menu').click();
  await admin.getByTestId('help-open-ticket').click();
  await expect(admin.getByTestId('ticket-new-form')).toBeVisible();
  await admin.keyboard.press('Escape');
  await admin.getByTestId('help-menu').click();
  await admin.getByTestId('help-my-tickets').click();
  await expect(admin.getByTestId('my-tickets')).toBeVisible();
});

test('support staff see only the Support section of the console', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner?section=support');
  await page.getByTestId('support-tab-staff').click();
  const email = `agent-${uid()}@e2e.test`;
  await page.getByTestId('support-staff-email').fill(email);
  await page.getByTestId('support-staff-invite').click();
  await expect(page.locator(`[data-testid="support-staff-row"][data-email="${email}"]`)).toBeVisible();
  // The owner's own console keeps its sections, and Support holds the support settings.
  await expect(page.getByTestId('owner-support-settings')).toBeVisible();
  await page.getByTestId('owner-section-general').click();
  await expect(page.getByTestId('owner-platform-settings')).toBeVisible();
});
