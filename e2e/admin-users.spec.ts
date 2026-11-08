// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, rowMenu, signIn } from './helpers';

/**
 * Administration → users (account admin A2; product decision 2026-10-04): search, edit, inline role, the default transfer user,
 * deactivate with a transfer first (incl. people assignments), activate, bulk deactivate, delete details, invitations
 * (invite, resend, cancel) and the CSV export.
 */
const uid = () => Date.now().toString(36);
const USERS = '/a/demo/admin/users';

const whoAmI = async (p: Page) =>
  ((await (await p.request.get('/api/v1/auth/me')).json()) as { user: { id: string; email: string } }).user;

const pick = async (page: Page, testId: string, option: string | RegExp, scope: Page | Locator = page) => {
  await scope.getByTestId(testId).first().click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: option }).click();
};

test('admins edit, deactivate with a transfer, activate and delete the details of a user', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { headers } = await ownerContext(page);
  const leaver = await newTeammate(page, browser, `עוזב ${id}`);
  const heir = await newTeammate(page, browser, `יורש ${id}`);
  const leaverUser = await whoAmI(leaver);
  const heirUser = await whoAmI(heir);

  // The leaver owns a board and is assigned in its people column.
  const lc = await ownerContext(leaver);
  const ws = (
    (await (await leaver.request.get('/api/v1/workspaces', { headers: lc.headers })).json()) as {
      data: { id: string }[];
    }
  ).data[0]!.id;
  const board = (await (
    await leaver.request.post('/api/v1/boards', {
      headers: lc.headers,
      data: { name: `בורד של עוזב ${id}`, workspace_id: ws },
    })
  ).json()) as { id: string };
  const people = (await (
    await leaver.request.post(`/api/v1/boards/${board.id}/columns`, {
      headers: lc.headers,
      data: { title: 'אחראי', type: 'people' },
    })
  ).json()) as { id: string };
  const item = (await (
    await leaver.request.post(`/api/v1/boards/${board.id}/items`, {
      headers: lc.headers,
      data: {
        name: `משימה ${id}`,
        cells: { [people.id]: { persons_and_teams: [{ kind: 'person', id: leaverUser.id }] } },
      },
    })
  ).json()) as { id: string };

  await page.goto(USERS);
  await expect(page.getByTestId('admin-users')).toBeVisible();

  // Search narrows the table.
  await page.getByRole('searchbox', { name: 'חיפוש לפי שם או מייל' }).fill(leaverUser.email);
  const row = page.locator(`[data-testid="user-row"][data-email="${leaverUser.email}"]`);
  await expect(row).toBeVisible();
  await expect(page.getByTestId('user-row')).toHaveCount(1);

  // Edit: job title and department.
  await rowMenu(page, row, 'עריכה');
  await page.getByTestId('user-edit-title').fill('מנהל לקוחות');
  await page.getByTestId('user-edit-department').fill('מכירות');
  await page.getByTestId('user-edit-save').click();
  await expect(row.getByTestId('user-title')).toHaveText('מנהל לקוחות · מכירות');

  // Inline role: viewer and back.
  await pick(page, 'user-role', 'צופה', row);
  await expect(row.getByTestId('user-role')).toHaveText(/צופה/);
  await pick(page, 'user-role', 'חבר צוות', row);
  await expect(row.getByTestId('user-role')).toHaveText(/חבר צוות/);

  // The default transfer user is offered first in the deactivate dialog.
  await pick(page, 'users-default-transfer', `יורש ${id}`);
  await expect(page.getByTestId('users-default-transfer')).toHaveText(new RegExp(`יורש ${id}`));

  await rowMenu(page, row, 'השבתה');
  const dialog = page.getByRole('dialog', { name: 'השבתת משתמש' });
  await expect(dialog.getByTestId('transfer-to')).toHaveText(new RegExp(`יורש ${id}`));
  await expect(dialog.getByRole('checkbox', { name: /בורדים בבעלותו/ })).toHaveAttribute('aria-checked', 'true');
  await dialog.getByTestId('transfer-scope-assignments').getByRole('checkbox').click();
  await expect(dialog.getByRole('checkbox', { name: /גם השיוכים בעמודות אנשים/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await dialog.getByTestId('transfer-confirm').click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveAttribute('data-status', 'deactivated');

  // The board and the assignment moved to the heir.
  const perms = (await (await page.request.get(`/api/v1/boards/${board.id}/permissions`, { headers })).json()) as {
    members: { email: string; role: string }[];
  };
  expect(perms.members.find((m) => m.email === heirUser.email)?.role).toBe('owner');
  const items = (await (await page.request.get(`/api/v1/boards/${board.id}/items`, { headers })).json()) as {
    data: { id: string; cells: Record<string, { value: unknown }> }[];
  };
  // Only the assignment moves — the item's creator stays who created it.
  const moved = JSON.stringify(items.data.find((i) => i.id === item.id)?.cells[people.id]?.value);
  expect(moved).toContain(heirUser.id);
  expect(moved).not.toContain(leaverUser.id);

  // The status filter shows deactivated people (over the whole list: the table renders only a window of a long one).
  const search = page.getByRole('searchbox', { name: 'חיפוש לפי שם או מייל' });
  await search.fill('');
  await pick(page, 'users-filter-status', 'מושבת');
  await expect(page.locator('[data-testid="user-row"][data-status="deactivated"]').first()).toBeVisible();
  await expect(page.locator('[data-testid="user-row"][data-status="active"]')).toHaveCount(0);
  await search.fill(leaverUser.email);
  await expect(row).toBeVisible();
  await pick(page, 'users-filter-status', 'כל הסטטוסים');

  // Activate, then deactivate again from the batch bar.
  await rowMenu(page, row, 'הפעלה');
  await expect(row).toHaveAttribute('data-status', 'active');
  await row.getByTestId('user-select').check();
  await expect(page.getByTestId('users-batch-count')).toHaveText('1');
  await page.getByTestId('users-batch-deactivate').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'השבתה' }).click();
  await expect(row).toHaveAttribute('data-status', 'deactivated');
  await expect(page.getByTestId('users-batch-bar')).toBeHidden();

  // Delete details: typed confirmation, then the row is anonymised.
  await rowMenu(page, row, 'מחיקת פרטים');
  const del = page.getByRole('alertdialog', { name: 'מחיקת פרטים' });
  await expect(del.getByTestId('delete-details-confirm')).toBeDisabled();
  await del.getByTestId('delete-details-input').fill(leaverUser.email);
  await del.getByTestId('delete-details-confirm').click();
  await expect(del).toBeHidden();
  // The leaver's email is gone now — find the anonymised rows by their name.
  await search.fill('משתמש שנמחק');
  const anon = page.getByTestId('user-row').filter({ hasText: 'משתמש שנמחק' }).filter({ hasText: 'פרטים נמחקו' });
  await expect(anon.first()).toBeVisible();

  await page.request.patch('/api/v1/accounts/me/default-transfer-user', { headers, data: { user_id: null } });
  await leaver.close();
  await heir.close();
});

test('invitations: invite from the page, resend, cancel; CSV export downloads', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const email = `invitee-${uid()}@demo.test`;
  await page.goto(USERS);

  await page.getByTestId('users-invite-open').click();
  const dialog = page.getByRole('dialog', { name: 'הזמנת משתמשים' });
  await dialog.getByLabel('כתובות מייל').fill(email);
  await dialog.getByRole('button', { name: 'שליחת הזמנות' }).click();
  await expect(dialog.getByText('הזמנות שנשלחו: 1.')).toBeVisible();
  await page.keyboard.press('Escape');

  const inv = page.locator(`[data-testid="invitation-row"][data-email="${email}"]`);
  await expect(inv).toBeVisible();
  await inv.getByTestId('invitation-resend').click();
  await expect(page.getByText('הזמנות שנשלחו מחדש: 1')).toBeVisible();
  await expect(inv).toBeVisible();

  // Batch resend through the bar.
  await inv.getByTestId('invitation-select').check();
  await page.getByTestId('users-batch-resend').click();
  await expect(page.getByTestId('users-batch-bar')).toBeHidden();

  // cancelling asks first (the link stops working at once).
  await inv.getByTestId('invitation-revoke').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'ביטול ההזמנה' }).click();
  await expect(inv).toBeHidden();

  const download = page.waitForEvent('download');
  await page.getByTestId('users-export').click();
  expect((await download).suggestedFilename()).toBe('users-demo.csv');
});
