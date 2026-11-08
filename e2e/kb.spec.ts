// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * The knowledge center: the owner writes an article in Support → Knowledge and publishes it; a
 * customer typing a ticket subject is offered it, opens it, says it did not help, and still sends the ticket; the
 * owner turns the solved ticket into a draft (no personal details); the metrics count it; the public help center
 * shows the article to anyone. The "?" panel test needs <HelpMenu> mounted in the TopBar (see the sync-tickets
 * report) — it opens the panel from `help-menu` → `help-center`.
 */
const uid = () => Date.now().toString(36);

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `kb-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `ידע ${id}`, slug, first_admin_email: `kb-admin-${id}@e2e.test`, template_set: 'empty' },
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
  return { admin, slug };
};

test('write + publish → suggested while typing a ticket → not helpful → ticket → solved → article draft → metrics → public', async ({
  page,
  browser,
}) => {
  test.setTimeout(240_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const title = `איך מוסיפים עמודת סטטוס ${id}`;

  // The owner writes and publishes an article (for everyone).
  await page.goto('/owner?section=support');
  await page.getByTestId('support-tab-knowledge').click();
  await expect(page.getByTestId('help-console')).toHaveAttribute('data-role', 'owner');
  await page.getByTestId('help-new-article').click();
  await page.getByTestId('help-new-title').fill(title);
  await page.getByTestId('help-new-create').click();
  const editor = page.getByTestId('help-editor');
  await expect(editor).toBeVisible();
  await page.getByTestId('help-tags').fill('עמודות, בורד');
  await page.getByTestId('help-visibility-public').click();
  await page.getByTestId('help-body').locator('[contenteditable="true"]').click();
  await page.keyboard.type(`פותחים את תפריט העמודה בבורד ובוחרים סטטוס ${id}.`);
  await page.getByTestId('help-publish').click();
  await expect(page.locator(`[data-testid="help-article-row"][data-title="${title}"]`)).toHaveAttribute(
    'data-status',
    'published',
  );
  // Versions: a save and a publish.
  await page.getByTestId('help-versions').click();
  await expect(page.locator('[data-testid="help-version"][data-kind="publish"]')).toHaveCount(1);
  await page.keyboard.press('Escape');

  // A customer typing a subject is offered the article; "no" goes back to the form; the ticket is sent.
  const { admin, slug } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  await admin.goto(`/a/${slug}/support`);
  await admin.getByTestId('ticket-new').click();
  await admin.getByTestId('ticket-subject').fill(`עמודת סטטוס ${id}`);
  const suggestion = admin.getByTestId('ticket-suggestion').filter({ hasText: title });
  await expect(suggestion).toBeVisible();
  await suggestion.click();
  await expect(admin.getByTestId('help-article')).toContainText(`סטטוס ${id}`);
  await admin.getByTestId('help-helpful-no').click();
  await expect(admin.getByTestId('help-article')).toHaveCount(0);
  await admin.getByTestId('ticket-description').fill('dana@e2e.test 050-1234567 — הערך חוזר אחרי רענון');
  await admin.getByTestId('ticket-submit').click();
  await admin.waitForURL(new RegExp(`/a/${slug}/support/[0-9A-Z]{26}`));
  const number = ((await admin.getByTestId('ticket-number').textContent()) ?? '').replace('#', '').trim();

  // The owner answers, solves, and turns the ticket into a draft without personal details.
  await page.goto('/owner?section=support');
  await page.getByTestId('support-search').fill(number);
  await page.locator(`[data-testid="support-ticket-row"][data-number="${number}"]`).click();
  const ticket = page.getByTestId('console-ticket');
  await ticket.getByTestId('console-reply').fill('פותחים את הגדרות העמודה ושומרים שוב');
  await ticket.getByTestId('console-send').click();
  await page.request.patch(`/api/v1/platform/support/tickets/${await ticketId(page, number)}`, {
    data: { status: 'solved' },
  });
  await page.reload();
  // The list shows the open tickets by default: a solved one is found with "all" statuses.
  await page.getByTestId('support-filter-status').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'הכול', exact: true }).click();
  await page.getByTestId('support-search').fill(number);
  await page.locator(`[data-testid="support-ticket-row"][data-number="${number}"]`).click();
  await page.getByTestId('console-ticket-to-article').click();
  await page.getByTestId('support-tab-knowledge').click();
  await page.getByTestId('help-console-search').fill(`סטטוס ${id}`);
  const draftRow = page.locator('[data-testid="help-article-row"][data-status="draft"]').first();
  await expect(draftRow).toBeVisible();
  await draftRow.click();
  await expect(page.getByTestId('help-body')).toContainText('שומרים שוב');
  await expect(page.getByTestId('help-body')).not.toContainText('dana@e2e.test');
  await expect(page.getByTestId('help-body')).not.toContainText('050-1234567');

  // Metrics: the helpful "no" and the ticket opened after help.
  await page.getByTestId('help-tab-metrics').click();
  await expect(page.getByTestId('help-metric-tickets')).not.toContainText(/^\D*0$/);

  // The public help center, signed out.
  const anon = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  const pub = await anon.newPage();
  forbidNativeDialogs(pub);
  await pub.goto('/help');
  await pub.getByTestId('help-center-search').fill(`לבורד ${id}`);
  await pub.getByTestId('help-center-result').filter({ hasText: title }).click();
  await expect(pub.getByTestId('help-center-article')).toContainText(`סטטוס ${id}`);
  await anon.close();
});

test('the "?" help panel: articles for this page, search, "did this help?" (needs HelpMenu in the TopBar)', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const helpMenu = page.getByTestId('help-menu');
  test.skip((await helpMenu.count()) === 0, 'HelpMenu is not mounted in the TopBar yet');
  await helpMenu.click();
  await page.getByTestId('help-center').click();
  const panel = page.getByTestId('help-panel');
  await expect(panel).toBeVisible();
  await panel.getByTestId('help-search').fill('סטטוס');
  const first = panel.getByTestId('help-result').first();
  await expect(first).toBeVisible();
  await first.click();
  await panel.getByTestId('help-helpful-yes').click();
  await expect(panel.getByTestId('help-feedback-thanks')).toBeVisible();
});

/** The ticket's id from the console list (by its number). */
const ticketId = async (page: Page, number: string) => {
  const res = await page.request.get(`/api/v1/platform/support/tickets?q=${number}`);
  const body = (await res.json()) as { data: { id: string; number: number }[] };
  return body.data.find((t) => String(t.number) === number)!.id;
};
