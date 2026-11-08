// SPDX-License-Identifier: AGPL-3.0-only
import { type Browser, expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, latestMail, OWNER, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Invitations (product owner: "לשגר לו למייל, להקפיץ לו את המייל, לבטל את ההזמנה — בקונסולת הבעלים וגם בחשבון
 * עצמו"): in the account (Administration → Users) and in the owner console — email by default or a link to copy,
 * the status of each open invitation, send again with another lifetime (the old link dies), cancel (the link dies),
 * the account's invitation settings, and the back-door rule of the owner console.
 */
const uid = () => Date.now().toString(36);
const linkIn = (text: string) => /https?:\/\/\S+\/invite\/[\w-]+/.exec(text)![0];

/** A new account whose first admin is a fresh person (the owner is not a member there). */
const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `inv-${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name: `הזמנות ${id}`, slug, first_admin_email: `inv-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { invitation } = (await res.json()) as { invitation: { url: string } };
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('מנהלת הזמנות');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, id };
};

test('in the account: email or link only, status, send again with another lifetime, cancel, settings', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, id } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  const emailed = `mailed-${id}@e2e.test`;
  const linkOnly = `link-${id}@e2e.test`;

  await admin.goto(`/a/${slug}/admin/users`);
  // Emailed (the default).
  await admin.getByTestId('users-invite-open').click();
  const dialog = admin.getByRole('dialog', { name: 'הזמנת משתמשים' });
  await dialog.getByLabel('כתובות מייל').fill(emailed);
  await dialog.getByRole('button', { name: 'שליחת הזמנות' }).click();
  await expect(dialog.getByTestId('invite-link')).toHaveCount(1);
  const firstLink = linkIn(await latestMail(emailed));
  // Link only: the switch off → nothing emailed, the link to copy.
  await dialog.getByLabel('כתובות מייל').fill(linkOnly);
  await dialog.getByTestId('invite-send-email').click();
  await dialog.getByRole('button', { name: 'שליחת הזמנות' }).click();
  await expect(dialog.locator(`[data-testid="invite-link"][data-email="${linkOnly}"]`)).toBeVisible();
  await admin.keyboard.press('Escape');

  const mailedRow = admin.locator(`[data-testid="invitation-row"][data-email="${emailed}"]`);
  const linkRow = admin.locator(`[data-testid="invitation-row"][data-email="${linkOnly}"]`);
  await expect(mailedRow).toHaveAttribute('data-status', 'sent');
  await expect(linkRow).toHaveAttribute('data-status', 'link');
  await expect(mailedRow.getByTestId('invitation-meta')).toContainText('מנהלת הזמנות');

  // Opening the link marks it "opened".
  const visitor = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  const v = await visitor.newPage();
  await v.goto(firstLink);
  await expect(v.getByText(emailed)).toBeVisible();
  await admin.reload();
  await expect(mailedRow).toHaveAttribute('data-status', 'opened');

  // Send again, valid 14 days: a new email, the old link no longer works.
  await mailedRow.getByTestId('invitation-more').click();
  await admin.getByTestId('invitation-resend-for').click();
  await admin.getByTestId('invitation-resend-days-14').click();
  await expect(admin.getByText('הזמנות שנשלחו מחדש: 1')).toBeVisible();
  await expect.poll(async () => linkIn(await latestMail(emailed))).not.toBe(firstLink);
  await v.goto(firstLink);
  await expect(v.getByText(emailed)).toHaveCount(0);
  await visitor.close();

  // Copy a fresh link (nothing emailed).
  await linkRow.getByTestId('invitation-copy-link').click();
  await expect(admin.getByTestId('invite-link-dialog')).toBeVisible();
  await admin.keyboard.press('Escape');

  // Cancel: asked first; the row goes.
  await linkRow.getByTestId('invitation-revoke').click();
  await admin.getByRole('alertdialog').getByRole('button', { name: 'ביטול ההזמנה' }).click();
  await expect(linkRow).toBeHidden();

  // The account's invitation settings: a 3-day link from now on.
  const settings = admin.getByTestId('invitation-settings');
  await settings.getByTestId('invitation-settings-expiry').fill('3');
  await settings.getByTestId('invitation-settings-save').click();
  await expect(admin.getByText('נשמר')).toBeVisible();
  await admin.reload();
  await expect(admin.getByTestId('invitation-settings-expiry')).toHaveValue('3');
});

test('owner console: an account invitations — invite any role, send again, copy, cancel; never to myself', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { slug, id } = await newAccount(page, browser);
  const person = `owner-inv-${id}@e2e.test`;

  await page.goto('/owner?section=accounts');
  const accountRow = page.locator('tr', { hasText: `/a/${slug}` });
  await accountRow.getByTestId('owner-invitations').click();
  const dialog = page.getByTestId('owner-invitations-dialog');
  await expect(dialog).toBeVisible();

  // A viewer, emailed.
  await dialog.getByTestId('owner-invite-email').fill(person);
  await dialog.getByTestId('owner-invite-role').click();
  await page.getByTestId('owner-invite-role-viewer').click();
  await dialog.getByTestId('owner-invite-send').click();
  await expect(dialog.getByTestId('owner-invite-link')).toBeVisible();
  const first = linkIn(await latestMail(person));
  const row = dialog.locator(`[data-testid="invitation-row"][data-email="${person}"]`);
  await expect(row).toHaveAttribute('data-status', 'sent');

  // Send again: a new link by email.
  await row.getByTestId('invitation-resend').click();
  await expect.poll(async () => linkIn(await latestMail(person))).not.toBe(first);

  // Copy a link valid 3 days.
  await row.getByTestId('invitation-more').click();
  await page.getByTestId('invitation-link-for').click();
  await page.getByTestId('invitation-link-days-3').click();
  await expect(page.getByTestId('invite-link-dialog')).toBeVisible();
  await page.keyboard.press('Escape');

  // Cancel.
  await row.getByTestId('invitation-revoke').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ביטול ההזמנה' }).click();
  await expect(row).toBeHidden();

  // The back-door rule: my own address without an edit grant is refused.
  await dialog.getByTestId('owner-invite-email').fill(OWNER);
  await dialog.getByTestId('owner-invite-send').click();
  await expect(dialog.getByRole('alert').or(dialog.locator('[role="status"]')).first()).toBeVisible();
  await expect(dialog.locator(`[data-testid="invitation-row"][data-email="${OWNER}"]`)).toHaveCount(0);
});
