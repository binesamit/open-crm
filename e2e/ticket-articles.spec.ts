// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Knowledge-center articles on a support reply: the platform owner attaches a published article to a
 * reply from the console's own picker (never a browser control); the customer sees it in the ticket as a card (title +
 * excerpt) that opens the article in the app's knowledge center.
 */
const uid = () => Date.now().toString(36);
const origin = { origin: WEB_URL };
const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

test('attach an article to a reply → the customer sees a card that opens it', async ({ page, browser }) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();

  // A published article the customer may read (signed-in members).
  const title = `איפוס סיסמה ${id}`;
  const created = await page.request.post('/api/v1/platform/support/help/articles', {
    headers: origin,
    data: {
      title,
      visibility: 'signed_in',
      excerpt: `מסבירים איך מאפסים סיסמה ${id}`,
      content: doc(`לוחצים על "שכחתי סיסמה" ${id}`),
    },
  });
  expect(created.status()).toBe(201);
  const article = (await created.json()) as { id: string };
  expect(
    (
      await page.request.post(`/api/v1/platform/support/help/articles/${article.id}/publish`, { headers: origin })
    ).status(),
  ).toBe(200);

  // A customer account with a ticket.
  const slug = `tka-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `מאמרים ${id}`, slug, first_admin_email: `tka-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { invitation } = (await res.json()) as { invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  forbidNativeDialogs(admin);
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('דנה מנהלת');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  await admin.goto(`/a/${slug}/support`);
  await admin.getByTestId('ticket-new').click();
  await admin.getByTestId('ticket-subject').fill(`לא מצליחה להתחבר ${id}`);
  await admin.getByTestId('ticket-description').fill('שכחתי את הסיסמה');
  await admin.getByTestId('ticket-submit').click();
  await admin.waitForURL(new RegExp(`/a/${slug}/support/[0-9A-Z]{26}`));
  const number = ((await admin.getByTestId('ticket-number').textContent()) ?? '').replace('#', '').trim();

  // The owner attaches the article from the console's picker and replies.
  await page.goto('/owner?section=support');
  await page.getByTestId('support-search').fill(number);
  await page.locator(`[data-testid="support-ticket-row"][data-number="${number}"]`).click();
  const ticket = page.getByTestId('console-ticket');
  await ticket.getByTestId('console-attach-article').click();
  const picker = page.getByTestId('console-article-picker');
  await expect(picker).toBeVisible();
  await picker.getByTestId('console-article-search').fill(id);
  await picker.locator(`[data-testid="console-article-option"][data-id="${article.id}"]`).click();
  await expect(picker).toHaveCount(0);
  await expect(ticket.locator(`[data-testid="console-reply-article"][data-id="${article.id}"]`)).toContainText(title);
  await ticket.getByTestId('console-reply').fill('המאמר הזה מסביר בדיוק מה לעשות');
  await ticket.getByTestId('console-send').click();
  await expect(ticket.getByTestId('console-reply-articles')).toHaveCount(0);
  await expect(ticket.locator(`[data-testid="console-message-article"][data-id="${article.id}"]`)).toContainText(title);

  // The customer sees the card (title + excerpt) and opens the article in the knowledge center.
  await admin.reload();
  const card = admin.locator(`[data-testid="ticket-article"][data-id="${article.id}"]`);
  await expect(card).toContainText(title);
  await expect(card).toContainText(`מסבירים איך מאפסים סיסמה ${id}`);
  await card.click();
  await admin.waitForURL(new RegExp(`/a/${slug}/help\\?article=${article.id}`));
  await expect(admin.getByTestId('help-article')).toHaveAttribute('data-id', article.id);
});
