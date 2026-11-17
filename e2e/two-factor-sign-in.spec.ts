// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, rowMenu, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * M8 ד12 + ד13: two-factor authentication (enrol in the profile with the QR, the code step at sign-in, "trust this
 * device", a backup code, the admin reset), the account policy and the IP allowlist screens, and scheduled cleaning
 * (rules, dry run). The TOTP is computed here from the secret in the otpauth:// URI.
 *
 * The local demo account and its owner are shared by every spec: the owner never turns 2FA on, a policy is only
 * set with a grace period (so nobody is locked out) and everything changed is put back in `finally`.
 */
const ADMIN = '/a/demo/admin';
const PASSWORD = 'a-very-good-password'; // helpers.newTeammate
const uid = () => Date.now().toString(36);

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

const confirm = async (page: Page) => {
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button').last().click();
};

const whoAmI = async (p: Page) =>
  ((await (await p.request.get('/api/v1/auth/me')).json()) as { user: { id: string; email: string } }).user;

/** A fresh browser on /login, signed out. */
const freshLogin = async (browser: Browser, storage?: Awaited<ReturnType<BrowserContext['storageState']>>) => {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    locale: 'he-IL',
    ...(storage ? { storageState: storage } : {}),
  });
  const p = await context.newPage();
  forbidNativeDialogs(p);
  await p.goto('/login');
  return p;
};
const passwordSignIn = async (p: Page, email: string) => {
  await p.getByLabel('אימייל').fill(email);
  await p.getByLabel('סיסמה', { exact: true }).fill(PASSWORD);
  await p.getByRole('button', { name: 'כניסה', exact: true }).click();
};

/** The teammate turns 2FA on from Profile → כניסה ואבטחה; returns the otpauth URI and the backup codes. */
const enrol = async (mate: Page) => {
  await mate.goto('/a/demo/profile?tab=security');
  const section = mate.getByTestId('profile-two-factor');
  await expect(section).toHaveAttribute('data-enabled', 'false');
  await mate.getByTestId('two-factor-enable').click();
  await mate.getByTestId('two-factor-password').fill(PASSWORD);
  await mate.getByTestId('two-factor-start').click();
  await expect(mate.getByTestId('two-factor-qr')).toBeVisible();
  const uri = (await mate.getByTestId('two-factor-secret').getAttribute('data-uri'))!;
  expect(uri).toMatch(/^otpauth:\/\/totp\//);
  await mate.getByTestId('two-factor-code').fill(totp(uri));
  await mate.getByTestId('two-factor-verify').click();
  const codes = mate.getByTestId('two-factor-backup-code');
  await expect(codes).toHaveCount(10);
  const backup = await codes.allInnerTexts();
  await mate.getByTestId('two-factor-backup-done').click();
  await expect(section).toHaveAttribute('data-enabled', 'true');
  return { uri, backup: backup.map((c) => c.trim()) };
};

test('2FA: enrol with the QR, then sign in with a code, trust the device, use a backup code; the admin resets it', async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const mate = await newTeammate(page, browser, `דו-שלבי ${uid()}`);
  const { email } = await whoAmI(mate);
  const { uri, backup } = await enrol(mate);

  // A new browser: password → the code step; a wrong code is refused; the right one (trusted) signs in.
  const p1 = await freshLogin(browser);
  await passwordSignIn(p1, email);
  await expect(p1.getByTestId('two-factor-challenge')).toBeVisible();
  await p1.getByTestId('two-factor-challenge-code').fill('000000');
  await p1.getByTestId('two-factor-challenge-submit').click();
  await expect(p1.getByTestId('two-factor-challenge-error')).toBeVisible();
  await p1.getByTestId('two-factor-challenge-code').fill(totp(uri));
  await p1.getByTestId('two-factor-trust').click();
  await p1.getByTestId('two-factor-challenge-submit').click();
  await p1.waitForURL(/\/a\/demo/);

  // The same device again: no code (signed out, then in with the password).
  const trusted = await p1.context().storageState();
  await p1.context().close();
  const withoutSession = { ...trusted, cookies: trusted.cookies.filter((c) => !c.name.includes('session_token')) };
  const p2 = await freshLogin(browser, withoutSession);
  await passwordSignIn(p2, email);
  await p2.waitForURL(/\/a\/demo/);
  await expect(p2.getByTestId('two-factor-challenge')).toHaveCount(0);
  await p2.context().close();

  // Another device without the phone: a backup code.
  const p3 = await freshLogin(browser);
  await passwordSignIn(p3, email);
  await p3.getByTestId('two-factor-use-backup').click();
  await expect(p3.getByTestId('two-factor-challenge')).toHaveAttribute('data-mode', 'backup');
  await p3.getByTestId('two-factor-challenge-backup').fill(backup[0]!);
  await p3.getByTestId('two-factor-challenge-submit').click();
  await p3.waitForURL(/\/a\/demo/);
  await p3.context().close();

  // The admin (lost phone): Administration → users → ⋯ → reset 2FA. Then the password alone signs in.
  await page.goto(`${ADMIN}/users`);
  // A long list renders only the rows in view: search for the member first.
  await page.getByRole('searchbox', { name: 'חיפוש לפי שם או מייל' }).fill(email);
  const row = page.locator(`[data-testid="user-row"][data-email="${email}"]`);
  await expect(row.getByTestId('user-2fa')).toBeVisible();
  await rowMenu(page, row, /אימות דו-שלבי|sec2\.users\.reset/);
  await confirm(page);
  await expect(row.getByTestId('user-2fa')).toHaveCount(0);
  const p4 = await freshLogin(browser);
  await passwordSignIn(p4, email);
  await p4.waitForURL(/\/a\/demo/);
  await p4.context().close();
});

test('2FA policy: required for everyone with a grace period shows the banner; IP allowlist refuses a list without me', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const before = (await (await page.request.get('/api/v1/security', { headers })).json()) as {
    two_factor: { grace_days: number };
  };
  const reset = (graceDays: number) =>
    page.request.patch('/api/v1/security', {
      headers,
      data: { two_factor: { mode: 'optional', grace_days: graceDays }, ip_allowlist: { enabled: false, ranges: [] } },
    });
  // The owner has no 2FA: "required" switches on with the stored grace period, so start from the longest one —
  // a "required" with no grace would answer 403 to every account call of the owner, `finally` included.
  expect((await reset(30)).ok()).toBe(true);
  try {
    await page.goto(`${ADMIN}/security`);
    await expect(page.getByTestId('security-two-factor')).toBeVisible();
    // Grace first (30 days), so nobody — the owner included — is stopped today.
    await page.getByTestId('two-factor-mode-required_all').click();
    await confirm(page);
    await expect(page.getByTestId('two-factor-grace')).toBeVisible();
    await page.getByTestId('two-factor-grace-30').click();
    await expect(page.getByTestId('two-factor-deadline')).toBeVisible();
    const policy = (await (await page.request.get('/api/v1/security', { headers })).json()) as {
      two_factor: { mode: string; grace_days: number; required_since: string | null };
    };
    expect(policy.two_factor).toMatchObject({ mode: 'required_all', grace_days: 30 });
    expect(policy.two_factor.required_since).toBeTruthy();

    // A member without 2FA sees the banner with the date and a link to the profile.
    const mate = await newTeammate(page, browser, `באנר ${uid()}`);
    await expect(mate.getByTestId('two-factor-banner')).toBeVisible();
    await mate.getByTestId('two-factor-banner-link').click();
    await expect(mate.getByTestId('profile-two-factor')).toBeVisible();
    await expect(mate.getByTestId('two-factor-required')).toBeVisible();

    // IP allowlist: off by default; my address is shown; a list without it cannot be turned on.
    const panel = page.getByTestId('security-ip-allowlist');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('ip-allowlist-toggle')).not.toBeChecked();
    await page.getByTestId('ip-range-input').fill('198.51.100.0/24');
    await page.getByTestId('ip-range-add').click();
    await expect(page.locator('[data-testid="ip-range-chip"][data-range="198.51.100.0/24"]')).toBeVisible();
    await page.getByTestId('ip-allowlist-toggle').click();
    await confirm(page);
    // The refusal is an error toast (the "saved" toasts of the policy above may still be up).
    await expect(page.getByTestId('toast').and(page.getByRole('alert'))).toBeVisible();
    await expect(page.getByTestId('ip-allowlist-toggle')).not.toBeChecked();
  } finally {
    expect((await reset(before.two_factor.grace_days)).ok()).toBe(true);
  }
});

test('scheduled cleaning: content rules off, technical on; a dry run shows counts', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const before = (await (await page.request.get('/api/v1/admin/tidy/rules', { headers })).json()) as {
    rules: Record<string, { enabled: boolean; days: number }>;
  };
  try {
    await page.goto(`${ADMIN}/tidy`);
    await expect(page.getByTestId('tidy-rules')).toBeVisible();
    await expect(page.getByTestId('tidy-toggle-archive_done_items')).not.toBeChecked();
    await expect(page.getByTestId('tidy-toggle-empty_trash')).not.toBeChecked();
    await expect(page.getByTestId('tidy-toggle-doc_auto_versions')).toBeChecked();
    await expect(page.getByTestId('tidy-toggle-agent_run_logs')).toBeChecked();

    // Change the days of a technical rule; it saves.
    const days = page.getByTestId('tidy-days-doc_auto_versions');
    await days.fill('120');
    await days.press('Enter');
    await expect
      .poll(
        async () =>
          ((await (await page.request.get('/api/v1/admin/tidy/rules', { headers })).json()) as typeof before).rules
            .doc_auto_versions!.days,
      )
      .toBe(120);

    // Dry run: a count per enabled rule, nothing changes.
    await page.getByTestId('tidy-preview').click();
    await expect(page.getByTestId('tidy-count-doc_auto_versions')).toBeVisible();
    await expect(page.getByTestId('tidy-count-archive_done_items')).toHaveCount(0);
  } finally {
    await page.request.put('/api/v1/admin/tidy/rules', {
      headers,
      data: { doc_auto_versions: { days: before.rules.doc_auto_versions!.days } },
    });
  }
});
