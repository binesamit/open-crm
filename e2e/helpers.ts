// SPDX-License-Identifier: AGPL-3.0-only
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, expect, type Locator, type Page } from '@playwright/test';
import { MAILPIT_URL as MAILPIT, STACK, WEB_URL } from './stack';

export const OWNER = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The newest message to `to` in Mailpit (its id), or null. */
const newestMailId = async (to: string): Promise<string | null> => {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`);
  return ((await res.json()) as { messages?: { ID: string }[] }).messages?.[0]?.ID ?? null;
};

/**
 * The newest mail to `to` (its text). With `after` (an id from `newestMailId`), only a message that arrived after
 * that one counts — the mailbox is shared by every worker, so nothing deletes it any more (s4f-e2e).
 */
export const latestMail = async (to: string, after?: string | null): Promise<string> => {
  for (let i = 0; i < 40; i++) {
    const id = await newestMailId(to);
    if (id && (after === undefined || id !== after))
      return ((await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as { Text: string }).Text;
    await sleep(250);
  }
  throw new Error(`no mail to ${to}`);
};

/**
 * A lock shared by every Playwright worker process of this machine (an atomic mkdir): the owner's magic-link mails
 * all go to one address, so two workers signing in at once could each open the other's link. A lock older than a
 * minute is a crashed worker's — taken over. Per stack (E2E_STACK, run-stacks.mjs): each stack has its own Mailpit.
 */
export const withWorkerLock = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
  const dir = join(tmpdir(), `bines-e2e-${STACK ? `${STACK}-` : ''}${name}.lock`);
  for (let i = 0; ; i++) {
    try {
      mkdirSync(dir);
      break;
    } catch {
      try {
        if (Date.now() - statSync(dir).mtimeMs > 60_000) rmSync(dir, { recursive: true, force: true });
      } catch {
        // released meanwhile
      }
      if (i > 1200) throw new Error(`e2e lock ${name}: still held after 2 minutes`);
      await sleep(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

/** Magic-link sign-in as the seeded owner, landing in the demo account. */
export const signIn = async (page: Page) => {
  await page.goto('/');
  await page.getByLabel('אימייל').fill(OWNER);
  // Only this worker asks for an owner link while it holds the lock; the link is the first mail after `before`.
  const link = await withWorkerLock('owner-mail', async () => {
    const before = await newestMailId(OWNER);
    await page.getByRole('button', { name: 'שלחו לי קישור כניסה למייל' }).click();
    await expect(page.getByText('נשלח אליה קישור כניסה')).toBeVisible();
    return /https?:\/\/\S+magic-link\/verify\S+/.exec(await latestMail(OWNER, before))![0];
  });
  await page.goto(link);
  await joinDemoIfInvited(page);
  await dismissFirstSteps(page);
};

/**
 * "First steps" stay closed for the test owner, so no spec meets the panel over its page (it is
 * remembered per person and account: after the first run this is a no-op). first-steps.spec.ts opens it itself.
 */
export const dismissFirstSteps = async (page: Page) => {
  const accounts = (await (await page.request.get('/api/v1/me/accounts')).json()) as {
    data: { id: string; slug: string }[];
  };
  const demo = accounts.data.find((a) => a.slug === 'demo');
  if (!demo) return;
  await page.request.post('/api/v1/me/first-steps/dismiss', {
    headers: { 'x-account-id': demo.id, origin: WEB_URL },
    data: { dismissed: true },
  });
  // Shown already on this page (the very first run): load it again without the panel.
  if (await page.getByTestId('first-steps').or(page.getByTestId('first-steps-pill')).isVisible()) await page.reload();
};

/**
 * After the owner's sign-in: lands in the demo account, or — on a fresh database, where the seed only invited the
 * owner — waits for the account picker's pending invitation and joins it first.
 */
export const joinDemoIfInvited = async (page: Page) => {
  const join = page.getByRole('button', { name: 'הצטרפות' });
  const landed = page.waitForURL(/\/a\/demo/).then(
    () => 'in' as const,
    () => null,
  );
  const invited = join.waitFor().then(
    () => 'join' as const,
    () => null,
  );
  if ((await Promise.race([landed, invited])) === 'join') await join.click();
  await page.waitForURL(/\/a\/demo/);
  // The URL changes before the account's route has loaded; the picker's placeholder stays until it has.
  await expect(page.getByTestId('account-picker-loading')).toHaveCount(0);
};

/**
 * "בורד חדש" (Fix: ): the workspace "+" in the sidebar opens the "add new" menu (board, board from a
 * template, doc, dashboard, folder); its first item opens the new-board dialog.
 */
export const openNewBoard = async (page: Page) => {
  await page.getByTestId('sidebar-add').click();
  await page.getByTestId('add-new-board').click();
};

/** The workspace "+" menu → one of its items (`add-new-doc`, `add-new-dashboard`, `add-board-template` …). */
export const addNew = async (page: Page, testId: string) => {
  await page.getByTestId('sidebar-add').click();
  await page.getByTestId(testId).click();
};

/** Chooses `item` in the ⋯ menu of a table row / tile / section (14 §0). */
export const rowMenu = async (page: Page, row: Locator, item: string | RegExp) => {
  await row.hover();
  await row
    .getByRole('button', { name: /^פעולות ל/ })
    .first()
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
};

/** Fails the test if the page opens a native alert/confirm/prompt (M1.1 #9). */
/** The group panel's column (a picker, as on the canvas); the panel is open (`toolbar-group`). */
export const pickGroupColumn = async (page: Page, name: string | RegExp) => {
  await page.getByTestId('group-column').click();
  await page
    .getByRole('menu')
    .getByRole('menuitemradio', { name, exact: typeof name === 'string' })
    .click();
};

export const forbidNativeDialogs = (page: Page) =>
  page.on('dialog', (d) => {
    void d.dismiss();
    throw new Error(`native ${d.type()} dialog: ${d.message()}`);
  });

/** The demo account id and the owner's user id, from inside a signed-in page. */
export const ownerContext = async (page: Page) => {
  const accounts = (await (await page.request.get('/api/v1/me/accounts')).json()) as {
    data: { id: string; slug: string }[];
  };
  const accountId = accounts.data.find((a) => a.slug === 'demo')!.id;
  const me = ((await (await page.request.get('/api/v1/auth/me')).json()) as { user: { id: string } }).user.id;
  return { accountId, meId: me, headers: { 'x-account-id': accountId, origin: WEB_URL } };
};

/** A new member of demo in a second browser context (invited by the owner's page, joined by password). */
export const newTeammate = async (page: Page, browser: Browser, name = 'חברת צוות') => {
  const { headers } = await ownerContext(page);
  const email = `mate-${Date.now().toString(36)}@demo.test`;
  await page.request.post('/api/v1/users/invite', { headers, data: { emails: [email], role: 'member' } });
  const invite = /https?:\/\/\S+\/invite\/[\w-]+/.exec(await latestMail(email))![0];
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  // Closed with the test's own page: a context left open keeps its page (and SSE / WebSocket) alive for the rest of
  // the run, and failure screenshots of later tests include it.
  page.on('close', () => void context.close().catch(() => undefined));
  const other = await context.newPage();
  await other.goto(invite);
  await other.getByLabel('שם מלא').fill(name);
  await other.getByLabel('סיסמה').fill('a-very-good-password');
  await other.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await other.waitForURL(/\/a\/demo/);
  return other;
};
