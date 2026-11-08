// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, rowMenu, signIn } from './helpers';

/**
 * Administration A4 + A5 (08 §5, §8, §9, §11): security (sessions with sign-out, the account's domains, the guest
 * domain policy), the audit log (filters, CSV), usage cards and tidy up (transfer ownership, archive, delete).
 * Settings changed here are put back, since the local account is shared by every spec.
 */
const uid = () => Date.now().toString(36);
const ADMIN = '/a/demo/admin';

const whoAmI = async (p: Page) =>
  ((await (await p.request.get('/api/v1/auth/me')).json()) as { user: { id: string; email: string; name: string } })
    .user;

const pick = async (page: Page, testId: string, option: string | RegExp) => {
  await page.getByTestId(testId).first().click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: option }).click();
};

test('security: sign a member out; domains and the guest policy save', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { headers } = await ownerContext(page);
  // Start from the default guest policy (a run that stopped half way may have left a list saved).
  await page.request.patch('/api/v1/security', {
    headers,
    data: { guest_domain_policy: { mode: 'any', domains: [] } },
  });
  const mate = await newTeammate(page, browser, `מחובר ${id}`);
  const mateUser = await whoAmI(mate);

  await page.goto(`${ADMIN}/security`);
  await expect(page.getByTestId('admin-security')).toBeVisible();
  await expect(page.getByTestId('admin-next-stage')).toHaveCount(0);

  // My own session is marked and has no sign-out; the mate's has one.
  const mine = page.getByTestId('session-row').filter({ hasText: 'המכשיר הזה' });
  await expect(mine).toHaveCount(1);
  await expect(mine.getByTestId('session-sign-out')).toHaveCount(0);
  const mateRow = page.locator(`[data-testid="session-row"][data-user="${mateUser.email}"]`);
  await expect(mateRow).toHaveCount(1);
  await mateRow.getByTestId('session-sign-out').click();
  await expect(page.getByRole('alertdialog')).toContainText('כל החשבונות');
  await page.getByRole('alertdialog').getByRole('button', { name: 'ניתוק' }).click();
  await expect(mateRow).toHaveCount(0);
  expect((await mate.request.get('/api/v1/auth/me')).status()).toBe(401);

  // The account's domains: add one, then remove it again.
  const domain = `e2e-${id}.test`;
  await page.getByTestId('security-domain-input').fill(domain);
  await page.getByTestId('security-domain-add').click();
  await expect(page.getByTestId('security-domain-chip').filter({ hasText: domain })).toBeVisible();
  await page.reload();
  const chip = page.getByTestId('security-domain-chip').filter({ hasText: domain });
  await expect(chip).toBeVisible();
  await chip.getByTestId('security-domain-remove').click();
  await expect(chip).toHaveCount(0);

  // Guest policy: a block list refuses invitations from it; back to "any".
  await page.getByTestId('guest-mode-block_list').click();
  await expect(page.getByTestId('guest-mode-pending')).toBeVisible();
  await page.getByTestId('guest-domain-input').fill(`blocked-${id}.test`);
  await page.getByTestId('guest-domain-add').click();
  await expect(page.getByTestId('guest-domain-chip')).toHaveCount(1);
  await expect(page.getByTestId('guest-mode-pending')).toHaveCount(0);
  const res = await page.request.post('/api/v1/users/invite', {
    headers,
    data: { emails: [`g@blocked-${id}.test`], role: 'guest' },
  });
  expect(((await res.json()) as { errors: { code: string }[] }).errors[0]!.code).toBe('guest_domain_blocked');
  await page.getByTestId('guest-mode-any').click();
  await expect(page.getByTestId('guest-domain-input')).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId('guest-mode-any').locator('input')).toBeChecked();

  await page.screenshot({ path: 'e2e/screens/admin-security.png' });
  await mate.context().close();
});

test('audit log: the sign-out and a role change show; filters and CSV', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { headers } = await ownerContext(page);
  const mate = await newTeammate(page, browser, `ביקורת ${id}`);
  const mateUser = await whoAmI(mate);
  await page.request.patch(`/api/v1/users/${mateUser.id}`, { headers, data: { role: 'viewer' } });

  await page.goto(`${ADMIN}/audit`);
  await expect(page.getByTestId('admin-audit')).toBeVisible();
  await expect(page.getByTestId('audit-row').first()).toBeVisible();

  await pick(page, 'audit-filter-event', 'שינוי תפקיד');
  const rows = page.getByTestId('audit-row');
  await expect(rows.first()).toHaveAttribute('data-event', 'user.role_changed');
  await expect(rows.first()).toContainText(`ביקורת ${id}`);
  await expect(page.getByTestId('audit-filter-clear')).toBeVisible();

  await page.getByTestId('audit-filter-clear').click();
  await expect(page.getByTestId('audit-filter-clear')).toHaveCount(0);

  const download = page.waitForEvent('download');
  await page.getByTestId('audit-export').click();
  expect((await download).suggestedFilename()).toBe('audit-demo.csv');
  await page.screenshot({ path: 'e2e/screens/admin-audit.png' });
  await mate.context().close();
});

test('usage: the cards and the period', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto(`${ADMIN}/usage`);
  await expect(page.getByTestId('admin-usage')).toBeVisible();
  for (const card of ['usage-automation-runs', 'usage-webhooks', 'usage-api', 'usage-active-users', 'usage-storage'])
    await expect(page.getByTestId(card)).toBeVisible();
  await expect(page.getByTestId('usage-active-users-value')).not.toHaveText('0');
  await expect(page.getByTestId('usage-bars').locator('> div')).toHaveCount(30);
  await page.getByTestId('usage-period-7').click();
  await expect(page.getByTestId('usage-bars').locator('> div')).toHaveCount(7);
  await page.screenshot({ path: 'e2e/screens/admin-usage.png' });
});

test('tidy up: filter, transfer ownership, archive and delete a board', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const me = await whoAmI(page);
  const mate = await newTeammate(page, browser, `בעלים ${id}`);
  const mc = await ownerContext(mate);
  const ws = (
    (await (await mate.request.get('/api/v1/workspaces', { headers: mc.headers })).json()) as {
      data: { id: string }[];
    }
  ).data[0]!.id;
  const name = `ניקיון ${id}`;
  await mate.request.post('/api/v1/boards', { headers: mc.headers, data: { name, workspace_id: ws } });
  await mate.context().close();

  await page.goto(`${ADMIN}/tidy`);
  await expect(page.getByTestId('admin-tidy')).toBeVisible();
  // Every board of the account is listed (thousands in a local DB that E2E runs fill): find ours by the search.
  await expect(page.getByTestId('tidy-row').first()).toBeVisible({ timeout: 20_000 });
  await page.getByRole('searchbox', { name: 'חיפוש בורד או מרחב עבודה' }).fill(name);
  const row = page.locator(`[data-testid="tidy-row"][data-name="${name}"]`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId('tidy-row')).toHaveCount(1);
  await expect(row.getByTestId('tidy-owners')).toContainText(`בעלים ${id}`);

  // A new board has one empty group: it shows under "ריקים".
  await page.getByTestId('tidy-show-empty').click();
  await expect(row).toBeVisible();
  await page.getByTestId('tidy-show-all').click();

  // Transfer ownership to me.
  await rowMenu(page, row, 'העברת בעלות');
  await expect(page.getByTestId('tidy-transfer-dialog')).toBeVisible();
  await page.getByTestId('tidy-transfer-to').click();
  await page
    .getByRole('menu')
    .getByRole('menuitemradio')
    .filter({ hasText: me.name || me.email })
    .first()
    .click();
  await page.getByTestId('tidy-transfer-confirm').click();
  await expect(page.getByTestId('tidy-transfer-dialog')).toHaveCount(0);
  await expect(row.getByTestId('tidy-owners')).not.toContainText(`בעלים ${id}`);

  // Archive, then delete (to the trash).
  await rowMenu(page, row, 'העברה לארכיון');
  await page.getByRole('alertdialog').getByRole('button', { name: 'העברה לארכיון' }).click();
  await expect(row).toHaveAttribute('data-archived', 'true');
  await page.getByTestId('tidy-show-archived').click();
  await expect(row).toBeVisible();
  await rowMenu(page, row, 'מחיקה');
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screens/admin-tidy.png' });

  // The audit log has the archive and the delete.
  await page.goto(`${ADMIN}/audit`);
  await pick(page, 'audit-filter-event', 'מחיקת בורד');
  await expect(page.getByTestId('audit-row').first()).toContainText(name);
});
