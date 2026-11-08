// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * an account's admin exports all its data (one ZIP, built in the background), schedules the account's
 * deletion (the export offered, the name typed again, a fresh two-factor code) — the account shows only the
 * "scheduled for deletion" screen and the API refuses it — and cancels: the app comes back at once.
 */
const uid = () => Date.now().toString(36);
const PASSWORD = 'a-very-good-password';
const ORIGIN = WEB_URL;

const base32 = (s: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of s.replace(/=+$/, '').toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
};
/** The current code of an otpauth:// URI (RFC 6238: SHA-1, 6 digits, 30 seconds). */
const totp = (uri: string) => {
  const secret = base32(new URL(uri).searchParams.get('secret')!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 1_000_000).padStart(6, '0');
};

const newAccount = async (page: Page, browser: Browser) => {
  const id = uid();
  const slug = `del-${id}`;
  const name = `מחיקה ${id}`;
  const res = await page.request.post('/api/v1/platform/accounts', {
    data: { name, slug, first_admin_email: `del-admin-${id}@e2e.test`, template_set: 'empty' },
  });
  expect(res.status()).toBe(201);
  const { account, invitation } = (await res.json()) as { account: { id: string }; invitation: { url: string } };
  const context = await browser.newContext({ baseURL: ORIGIN, locale: 'he-IL' });
  page.on('close', () => void context.close().catch(() => undefined));
  const admin = await context.newPage();
  await admin.goto(invitation.url);
  await admin.getByLabel('שם מלא').fill('מנהלת מחיקה');
  await admin.getByLabel('סיסמה').fill(PASSWORD);
  await admin.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await admin.waitForURL(new RegExp(`/a/${slug}`));
  return { admin, slug, accountId: account.id, name };
};

/** Two-factor sign-in on, through the same endpoints the profile uses; returns the otpauth URI. */
const enrol = async (admin: Page) => {
  const res = await admin.request.post('/api/auth/two-factor/enable', {
    data: { password: PASSWORD },
    headers: { origin: ORIGIN },
  });
  expect(res.status()).toBe(200);
  const { totpURI } = (await res.json()) as { totpURI: string };
  const verify = await admin.request.post('/api/auth/two-factor/verify-totp', {
    data: { code: totp(totpURI) },
    headers: { origin: ORIGIN },
  });
  expect(verify.status()).toBe(200);
  return totpURI;
};

test('export → schedule the deletion → the locked screen → cancel', async ({ page, browser }) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { admin, slug, accountId, name } = await newAccount(page, browser);
  forbidNativeDialogs(admin);
  const headers = { 'x-account-id': accountId };
  const uri = await enrol(admin);

  // Export: built in the background, then downloadable.
  await admin.goto(`/a/${slug}/admin/general`);
  const section = admin.getByTestId('admin-general-data');
  await section.scrollIntoViewIfNeeded();
  await section.getByTestId('account-export-start').click();
  await expect(section.getByTestId('account-export-ready')).toBeVisible({ timeout: 60_000 });
  const list = (await (await admin.request.get('/api/v1/account-export', { headers })).json()) as {
    data: { id: string; status: string }[];
  };
  expect(list.data[0]!.status).toBe('ready');
  const link = (await (
    await admin.request.get(`/api/v1/account-export/${list.data[0]!.id}/download`, { headers })
  ).json()) as { url: string };
  const zip = await admin.request.get(link.url);
  expect(zip.status()).toBe(200);
  expect((await zip.body()).subarray(0, 2).toString()).toBe('PK');

  // Delete: the export is offered first, then the name, then the code.
  await section.getByTestId('delete-account-open').click();
  const dialog = admin.getByTestId('delete-account-dialog');
  await expect(dialog.getByTestId('account-export-ready')).toBeVisible();
  await dialog.getByTestId('delete-account-next').click();
  await dialog.getByTestId('delete-account-name').fill('לא השם');
  await expect(dialog.getByTestId('delete-account-name-next')).toBeDisabled();
  await dialog.getByTestId('delete-account-name').fill(name);
  await dialog.getByTestId('delete-account-name-next').click();
  await dialog.getByTestId('delete-account-code').fill(totp(uri));
  await dialog.getByTestId('delete-account-confirm').click();

  // Locked: only the deletion screen, and the API refuses the account.
  const screen = admin.getByTestId('account-deletion');
  await expect(screen).toBeVisible();
  await expect(admin.getByTestId('account-deletion-title')).toContainText(name);
  await expect(admin.getByTestId('account-deletion-date')).not.toBeEmpty();
  await expect(admin.getByTestId('sidebar-collapse')).toHaveCount(0);
  await admin.keyboard.press('Escape');
  await expect(screen).toBeVisible();
  const refused = await admin.request.get('/api/v1/workspaces', { headers });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { error: { code: string } }).error.code).toBe('account_deletion_scheduled');
  await admin.reload();
  await expect(admin.getByTestId('account-deletion')).toBeVisible();

  // The owner console lists it.
  const pending = (await (await page.request.get('/api/v1/platform/account-deletions')).json()) as {
    data: { id: string }[];
  };
  expect(pending.data.some((a) => a.id === accountId)).toBe(true);

  // Cancel: the app comes back at once.
  await admin.getByTestId('account-deletion-cancel').click();
  await expect(admin.getByTestId('account-deletion')).toHaveCount(0);
  await expect(admin.getByTestId('sidebar-collapse')).toBeVisible();
  expect((await admin.request.get('/api/v1/workspaces', { headers })).status()).toBe(200);
});
