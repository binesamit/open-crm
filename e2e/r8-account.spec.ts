// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Browser, type Page } from '@playwright/test';
import { forbidNativeDialogs, latestMail, newTeammate, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Fix: — account:
 * B. sign-in that does not depend on email (product owner: "מה הגיבוי שלי אם המיילים לא עובדים לי להתחברות?"): an admin's
 *    one-time sign-in link, copying an invitation link, a first password / password change in the profile, and
 *    "forgot password" on the login page.
 * D. moving a board between workspaces from the sidebar (product owner: "אפשרות להעביר בורדים בין ווארקספייס").
 */
const uid = () => Date.now().toString(36);
const USERS = '/a/demo/admin/users';

const freshPage = async (browser: Browser) =>
  (await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' })).newPage();
const whoAmI = async (p: Page) =>
  ((await (await p.request.get('/api/v1/auth/me')).json()) as { user: { id: string; email: string } }).user;

/** Chooses a new password on /login#reset=… and lands signed in. */
const chooseNewPassword = async (p: Page, url: string, password: string) => {
  await p.goto(url);
  await expect(p.getByTestId('reset-form')).toBeVisible();
  // The token leaves the address bar at once.
  await expect.poll(() => new URL(p.url()).hash).toBe('');
  await p.getByTestId('reset-new').fill(password);
  await p.getByTestId('reset-confirm').fill(password);
  await p.getByTestId('reset-save').click();
  await p.waitForURL(/\/a\/demo/);
};

test('an admin hands a member a one-time sign-in link; it works once', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const mate = await newTeammate(page, browser, `שחזור ${uid()}`);
  const { email } = await whoAmI(mate);

  await page.goto(USERS);
  // A long list renders only the rows in view: search for the member first.
  await page.getByRole('searchbox', { name: 'חיפוש לפי שם או מייל' }).fill(email);
  const row = page.getByTestId('user-row').and(page.locator(`[data-email="${email}"]`));
  await row.hover();
  await row.getByRole('button', { name: /^פעולות ל/ }).click();
  await page.getByTestId('user-menu-recovery-link').click();
  const field = page.getByTestId('recovery-link-dialog-field');
  await expect(field).toBeVisible();
  const url = (await field.getAttribute('data-url'))!;
  expect(url).toMatch(/\/login#reset=[\w-]+$/);
  await expect(page.getByTestId('recovery-link-dialog-field-whatsapp')).toHaveAttribute('href', /wa\.me/);

  const fresh = await freshPage(browser);
  await chooseNewPassword(fresh, url, 'recovered-password-1');
  expect((await whoAmI(fresh)).email).toBe(email);
  // The old session of the member is signed out; the link does not work again.
  expect((await mate.request.get('/api/v1/auth/me')).status()).toBe(401);
  const again = await freshPage(browser);
  await again.goto(url);
  await expect(again.getByTestId('reset-invalid')).toBeVisible();
});

test('an invitation link is copied from the users page and opens the invitation', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const email = `link-${uid()}@demo.test`;
  const res = await page.request.post('/api/v1/users/invite', { headers, data: { emails: [email], role: 'member' } });
  const invited = ((await res.json()) as { invited: { url?: string }[] }).invited[0]!;
  expect(invited.url).toMatch(/\/invite\/[\w-]+$/);

  await page.goto(USERS);
  const row = page.getByTestId('invitation-row').and(page.locator(`[data-email="${email}"]`));
  await row.getByTestId('invitation-copy-link').click();
  const field = page.getByTestId('invite-link-dialog-field');
  const url = (await field.getAttribute('data-url'))!;
  expect(url).toMatch(/\/invite\/[\w-]+$/);
  expect(url).not.toBe(invited.url); // a fresh link; the earlier one stops working

  const fresh = await freshPage(browser);
  await fresh.goto(url);
  await expect(fresh.getByText(email)).toBeVisible();
  await fresh.getByLabel('שם מלא').fill('מוזמן בקישור');
  await fresh.getByLabel('סיסמה').fill('a-very-good-password');
  await fresh.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await fresh.waitForURL(/\/a\/demo/);

  const old = await freshPage(browser);
  await old.goto(invited.url!);
  await expect(old.getByText('ההזמנה לא תקפה')).toBeVisible();
});

test('a member who signs in by email link sets a password in the profile, then changes it', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const email = `nopass-${uid()}@demo.test`;
  await page.request.post('/api/v1/users/invite', { headers, data: { emails: [email], role: 'member' } });

  // Signs in by magic link (no password yet) and accepts the invitation.
  const p = await freshPage(browser);
  await p.goto('/login');
  await p.getByLabel('אימייל').fill(email);
  await p.getByRole('button', { name: 'שלחו לי קישור כניסה למייל' }).click();
  await expect(p.getByText('נשלח אליה קישור כניסה')).toBeVisible();
  await expect.poll(async () => /magic-link\/verify/.test(await latestMail(email))).toBe(true);
  await p.goto(/https?:\/\/\S+magic-link\/verify\S+/.exec(await latestMail(email))![0]);
  const invites = (await (await p.request.get('/api/v1/me/invitations')).json()) as { data: { id: string }[] };
  await p.request.post(`/api/v1/me/invitations/${invites.data[0]!.id}/accept`, {
    headers: { origin: WEB_URL },
  });

  await p.goto('/a/demo/profile?tab=security');
  const section = p.getByTestId('profile-security');
  await expect(section).toHaveAttribute('data-has-password', 'false');
  await p.getByTestId('security-new').fill('short');
  await p.getByTestId('security-confirm').fill('short');
  await p.getByTestId('security-save').click();
  await expect(section.getByTestId('security-done')).toHaveCount(0);
  await p.getByTestId('security-new').fill('first-password-1');
  await p.getByTestId('security-confirm').fill('first-password-1');
  await p.getByTestId('security-save').click();
  await expect(p.getByTestId('security-done')).toBeVisible();
  await expect(section).toHaveAttribute('data-has-password', 'true');

  await p.getByTestId('security-current').fill('wrong-password-0');
  await p.getByTestId('security-new').fill('second-password-2');
  await p.getByTestId('security-confirm').fill('second-password-2');
  await p.getByTestId('security-save').click();
  await expect(p.getByTestId('security-done')).toHaveCount(0);
  await p.getByTestId('security-current').fill('first-password-1');
  await p.getByTestId('security-save').click();
  await expect(p.getByTestId('security-done')).toBeVisible();

  const login = await freshPage(browser);
  const res = await login.request.post('/api/auth/sign-in/email', {
    headers: { origin: WEB_URL },
    data: { email, password: 'second-password-2' },
  });
  expect(res.status()).toBe(200);
});

test('forgot password: the login page emails a link to choose a new one', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const mate = await newTeammate(page, browser, `שכחה ${uid()}`);
  const { email } = await whoAmI(mate);

  const p = await freshPage(browser);
  forbidNativeDialogs(p);
  await p.goto('/login');
  await p.getByTestId('login-forgot').click();
  await p.getByTestId('forgot-email').fill(email);
  await p.getByTestId('forgot-send').click();
  await expect(p.getByTestId('forgot-sent')).toBeVisible();
  let link = '';
  await expect
    .poll(async () => {
      link = /https?:\/\/\S+\/login#reset=[\w-]+/.exec(await latestMail(email))?.[0] ?? '';
      return link;
    })
    .not.toBe('');
  await chooseNewPassword(p, link, 'forgot-password-9');
  expect((await whoAmI(p)).email).toBe(email);
});

test('a board moves to another workspace from its sidebar menu', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const id = uid();
  const make = async (name: string) =>
    ((await (await page.request.post('/api/v1/workspaces', { headers, data: { name } })).json()) as { id: string }).id;
  const from = `מקור ${id}`;
  const to = `יעד ${id}`;
  const fromId = await make(from);
  const toId = await make(to);
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `בורד נודד ${id}`, workspace_id: fromId } })
  ).json()) as { id: string; name: string };

  await page.reload();
  const sidebar = page.locator('aside').first();
  await sidebar.getByRole('button', { name: 'החלפת מרחב עבודה' }).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: from }).click();
  const row = sidebar.getByTestId('board-row').filter({ hasText: board.name });
  await expect(row).toBeVisible();

  await row.hover();
  await row.getByRole('button', { name: `פעולות ל${board.name}` }).click();
  await page.getByTestId('board-menu-move-workspace').click();
  await page.getByRole('menu').getByTestId('move-workspace-option').filter({ hasText: to }).click();
  await expect(row).toHaveCount(0);

  const moved = (await (await page.request.get(`/api/v1/boards/${board.id}`, { headers })).json()) as {
    workspace_id: string;
  };
  expect(moved.workspace_id).toBe(toId);
  await sidebar.getByRole('button', { name: 'החלפת מרחב עבודה' }).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: to }).click();
  await expect(sidebar.getByTestId('board-row').filter({ hasText: board.name })).toBeVisible();
});
