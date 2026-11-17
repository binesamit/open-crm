// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { joinDemoIfInvited } from './helpers';
import { MAILPIT_URL as MAILPIT } from './stack';

/** Phase 0 demo (12-ROADMAP DoD): owner → new account → its admin joins → invites a member; isolation holds. */
const OWNER = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';

const latestMail = async (to: string): Promise<string> => {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`);
    const body = (await res.json()) as { messages?: { ID: string }[] };
    const id = body.messages?.[0]?.ID;
    if (id) return ((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string }).Text;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail to ${to}`);
};

const signInOwner = async (page: Page) => {
  await page.goto('/');
  await page.getByLabel('אימייל').fill(OWNER);
  await page.getByRole('button', { name: 'שלחו לי קישור כניסה למייל' }).click();
  await expect(page.getByText('נשלח אליה קישור כניסה')).toBeVisible();
  const link = /https?:\/\/\S+magic-link\/verify\S+/.exec(await latestMail(OWNER))![0];
  await page.goto(link);
};

test('owner creates an account; its admin joins and invites a member', async ({ browser }) => {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  const slug = `e2e-${Date.now().toString(36)}`;
  const adminEmail = `admin@${slug}.test`;

  const owner = await (await browser.newContext()).newPage();
  await signInOwner(owner);
  // First run: accept the seeded Demo invitation; later runs land straight in the account.
  await joinDemoIfInvited(owner);

  await owner.goto('/owner?section=accounts');
  await owner.getByLabel('שם החשבון', { exact: true }).fill('E2E Client');
  await owner.getByLabel('כתובת (slug)').fill(slug);
  await owner.getByLabel('מייל המנהל הראשון').fill(adminEmail);
  await owner.getByRole('button', { name: 'יצירת חשבון' }).click();
  await expect(owner.getByText('החשבון נוצר והזמנה נשלחה')).toBeVisible();

  const invite = /https?:\/\/\S+\/invite\/[\w-]+/.exec(await latestMail(adminEmail))![0];
  const admin = await (await browser.newContext()).newPage();
  await admin.goto(invite);
  await expect(admin.getByRole('heading', { level: 1 })).toContainText('E2E Client');
  await admin.getByLabel('שם מלא').fill('מנהלת בדיקות');
  await admin.getByLabel('סיסמה').fill('a-very-good-password');
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));

  await admin.getByLabel('כתובות מייל').fill(`bob@${slug}.test`);
  await admin.getByRole('button', { name: 'שליחת הזמנות' }).click();
  await expect(admin.getByText('הזמנות שנשלחו: 1')).toBeVisible();
  await latestMail(`bob@${slug}.test`);

  // The platform owner is not a member of the new account and must not get in (D12).
  await owner.goto(`/a/${slug}`);
  await expect(owner.getByText('לא נמצא')).toBeVisible();
});
