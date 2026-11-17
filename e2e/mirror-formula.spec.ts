// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { MAILPIT_URL as MAILPIT } from './stack';

/** Phase 1 slice B: relation picker, mirror and formula update together in the UI. */
const OWNER = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';

const latestMail = async (to: string): Promise<string> => {
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`);
    const id = ((await res.json()) as { messages?: { ID: string }[] }).messages?.[0]?.ID;
    if (id) return ((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string }).Text;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no mail to ${to}`);
};

test('link a client to an invoice and see mirror + health formula', async ({ page }) => {
  await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE' });
  await page.goto('/');
  await page.getByLabel('אימייל').fill(OWNER);
  await page.getByRole('button', { name: 'שלחו לי קישור כניסה למייל' }).click();
  await expect(page.getByText('נשלח אליה קישור כניסה')).toBeVisible();
  await page.goto(/https?:\/\/\S+magic-link\/verify\S+/.exec(await latestMail(OWNER))![0]);
  const join = page.getByRole('button', { name: 'הצטרפות' });
  if (await join.isVisible().catch(() => false)) await join.click();
  await page.waitForURL(/\/a\/demo/);

  // An invoice of 1000 with 250 paid → balance 750.
  const suffix = Date.now().toString(36);
  await page.locator('aside a', { hasText: 'חשבוניות' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('חשבוניות');
  const addInvoice = page.getByPlaceholder(/\+ הוספת/).first();
  await addInvoice.fill(`חשבונית ${suffix}`);
  await addInvoice.press('Enter');
  const invoiceRow = page.locator('div.grid', { hasText: `חשבונית ${suffix}` }).first();
  await expect(invoiceRow).toBeVisible();
  const header = page.locator('div.grid').first();
  const colIndex = async (title: string) =>
    (await header.locator(':scope > div').allTextContents()).findIndex((x) => x.replace('⋯', '').trim() === title);
  const cellAt = (row: typeof invoiceRow, i: number) => row.locator(':scope > div').nth(i);
  await cellAt(invoiceRow, await colIndex('סה"כ')).click();
  await page.keyboard.type('1000');
  await page.keyboard.press('Enter');
  await cellAt(invoiceRow, await colIndex('שולם')).click();
  await page.keyboard.type('250');
  await page.keyboard.press('Enter');
  await expect(cellAt(invoiceRow, await colIndex('יתרה לתשלום'))).toHaveText('750');

  // A client linked to it mirrors the open balance.
  await page.locator('aside a', { hasText: 'לקוחות' }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('לקוחות');
  const addClient = page.getByPlaceholder(/\+ הוספת/).first();
  await addClient.fill(`לקוח ${suffix}`);
  await addClient.press('Enter');
  const clientRow = page.locator('div.grid', { hasText: `לקוח ${suffix}` }).first();
  await expect(clientRow).toBeVisible();
  const clientHeader = page.locator('div.grid').first();
  const idx = async (title: string) =>
    (await clientHeader.locator(':scope > div').allTextContents()).findIndex(
      (x) => x.replace('⋯', '').trim() === title,
    );
  await expect(cellAt(clientRow, await idx('בריאות'))).toHaveText('🟢 ירוק');
  await cellAt(clientRow, await idx('חשבוניות')).click();
  await page.getByPlaceholder('חיפוש פריטים').fill(suffix);
  await page.getByText(`חשבונית ${suffix}`).click();
  await page.keyboard.press('Escape');
  await expect(cellAt(clientRow, await idx('חשבוניות'))).toContainText(`חשבונית ${suffix}`);
  await expect(cellAt(clientRow, await idx('חשבוניות פתוחות'))).toHaveText('750');
});
