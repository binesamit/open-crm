// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';
import { enrol, totp } from './two-factor';

/**
 * Secret updates: a teammate with 2FA writes a secret update in an item card (the lock in the
 * composer — no files, no draft), the thread shows a locked card; Show asks for a fresh code in a dialog (never a
 * browser prompt), the text shows with a countdown, Hide locks it again; a reply in the secret thread is always
 * secret; a subitem's card has the same lock. The owner (no 2FA) sees the locked card and is told to turn 2FA on —
 * also when changing the board's secret-update settings (⋯ → עדכונים סודיים). Administration → Security has the
 * account's default, and the secrets log names the secret update — never its text.
 */
const PLAIN = `e2e-secret-update-${Date.now().toString(36)}`;

/** Types into the card's (or a reply's) composer. */
const typeIn = async (scope: ReturnType<Page['getByRole']>, page: Page, text: string, nth = 0) => {
  await scope.getByTestId('rich-editor').nth(nth).locator('[contenteditable="true"]').click();
  await page.keyboard.type(text);
};

test('secret updates: lock in the composer, locked card, code to show, secret replies, settings, log', async ({
  page,
  browser,
}) => {
  test.setTimeout(200_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', {
      headers,
      data: { name: `עדכונים סודיים ${Date.now()}`, workspace_id: ws },
    })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'משרד לקוח' } })
  ).json()) as { id: string };

  // A teammate with 2FA writes a secret update.
  const mate = await newTeammate(page, browser, `כותבת ${Date.now().toString(36)}`);
  forbidNativeDialogs(mate);
  const uri = await enrol(mate);
  await mate.goto(`/a/demo/b/${board.id}/i/${item.id}?tab=updates`);
  const card = mate.getByRole('dialog', { name: 'משרד לקוח' });
  await expect(card).toBeVisible();
  await typeIn(card, mate, PLAIN);
  await expect(card.getByTestId('composer-attach')).toBeVisible();
  await card.getByTestId('composer-secret').click();
  await expect(card.getByTestId('composer-secret')).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByTestId('composer-secret-note')).toBeVisible();
  await expect(card.getByTestId('composer-attach')).toHaveCount(0); // no files on a secret update
  await card.getByTestId('composer-send').first().click();
  const entry = card.locator('[data-testid="update-entry"]').first();
  await expect(entry.getByTestId('secret-update')).toHaveAttribute('data-state', 'locked');
  await expect(card.getByText(PLAIN)).toHaveCount(0);
  // Never kept as a draft in the browser.
  expect(await mate.evaluate((p) => JSON.stringify(localStorage).includes(p), PLAIN)).toBe(false);

  // Show → the code dialog → the text with a countdown → Hide.
  await entry.getByTestId('secret-update-reveal').click();
  await expect(mate.getByTestId('secret-stepup-code')).toBeVisible();
  await mate.getByTestId('secret-stepup-input').fill(totp(uri));
  await mate.getByTestId('secret-stepup-input').press('Enter');
  await expect(entry.getByTestId('secret-update-text')).toHaveText(PLAIN);
  await expect(entry.getByTestId('secret-update-countdown')).toBeVisible();
  await entry.getByTestId('secret-update-hide').click();
  await expect(entry.getByTestId('secret-update')).toHaveAttribute('data-state', 'locked');

  // A reply in the secret thread is always secret (a chip, no toggle); it shows locked too.
  await entry.getByRole('button', { name: 'תגובה' }).first().click();
  await expect(card.getByTestId('composer-secret-forced')).toBeVisible();
  await expect(card.getByTestId('composer-secret')).toHaveCount(0);
  await typeIn(card, mate, `${PLAIN}-reply`, 1);
  await card.getByTestId('composer-send').last().click();
  const reply = card.locator('[data-testid="update-entry"][data-depth="1"]').first();
  await expect(reply.getByTestId('secret-update')).toHaveAttribute('data-state', 'locked');
  // The code entered a moment ago still counts: Show reveals at once.
  await reply.getByTestId('secret-update-reveal').click();
  await expect(reply.getByTestId('secret-update-text')).toHaveText(`${PLAIN}-reply`);
  await expect(mate.getByTestId('secret-stepup-code')).toHaveCount(0);

  // A subitem's card offers the same lock (subitems follow the board's settings).
  const sub = (await (
    await page.request.post(`/api/v1/items/${item.id}/subitems`, { headers, data: { name: 'תת סודי' } })
  ).json()) as { id: string; board_id: string };
  await mate.goto(`/a/demo/b/${board.id}/i/${sub.id}?tab=updates`);
  const subCard = mate.getByRole('dialog', { name: 'תת סודי' });
  await typeIn(subCard, mate, 'x');
  await expect(subCard.getByTestId('composer-secret')).toBeVisible();

  // The owner (no 2FA): the locked card, and Show says to turn 2FA on.
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}?tab=updates`);
  const ownCard = page.getByRole('dialog', { name: 'משרד לקוח' });
  const ownEntry = ownCard.locator('[data-testid="update-entry"]').first();
  await expect(ownEntry.getByTestId('secret-update')).toHaveAttribute('data-state', 'locked');
  await ownEntry.getByTestId('secret-update-reveal').click();
  await expect(page.getByTestId('secret-stepup-no2fa')).toBeVisible();
  await page.getByTestId('secret-stepup-close').click();
  await expect(page.getByText(PLAIN)).toHaveCount(0);

  // The board's own settings (⋯ → עדכונים סודיים): changing them takes a code — the owner is told to turn 2FA on.
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('board-more').first().click();
  await page.getByTestId('board-secret-updates').click();
  const dialog = page.getByTestId('secret-updates-board');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('secret-updates-inherited')).toBeVisible();
  await page.getByTestId('secret-updates-own').click();
  await page.getByTestId('secret-updates-enabled').click();
  await page.getByTestId('secret-updates-board-save').click();
  await expect(page.getByTestId('secret-stepup-no2fa')).toBeVisible();
  await page.getByTestId('secret-stepup-close').click();
  const settings = (await (
    await page.request.get(`/api/v1/boards/${board.id}/secret-updates`, { headers })
  ).json()) as {
    board: unknown;
  };
  expect(settings.board).toBeNull(); // nothing saved

  // Administration → Security: the account's default, and the log names the secret update (never its text).
  await page.goto('/a/demo/admin/security');
  await expect(page.getByTestId('secret-updates-account')).toBeVisible();
  await expect(page.getByTestId('secret-updates-enabled')).toBeVisible();
  await expect(page.getByTestId('secret-log')).toBeVisible();
  await expect(
    page.locator('[data-testid="secret-log-row"][data-action="reveal"]', { hasText: 'משרד לקוח › עדכון סודי' }).first(),
  ).toBeVisible();
  await expect(page.getByText(PLAIN)).toHaveCount(0);

  await page.request.delete(`/api/v1/boards/${board.id}`, { headers });
});
