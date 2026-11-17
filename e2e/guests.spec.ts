// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, latestMail, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * M7 — guests: the owner invites a guest from the board's permissions dialog (just an email); the
 * board shows non-owners only what they created or are assigned to; the guest works in the same app — the normal
 * sidebar with only that board, and only their items.
 */
test('invite a guest to a board; they see only that board and their items', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const post = async (path: string, data: unknown) =>
    (await (await page.request.post(`/api/v1${path}`, { headers, data })).json()) as { id: string };
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  await post('/boards', { name: `פנימי ${tag}`, workspace_id: ws });
  const requests = (await post('/boards', { name: `בקשות ${tag}`, workspace_id: ws })).id; // a regular board
  const person = (await post(`/boards/${requests}/columns`, { title: 'אחראי', type: 'people' })).id;
  const mine = await post(`/boards/${requests}/items`, { name: `הבקשה שלו ${tag}` });
  const other = await post(`/boards/${requests}/items`, { name: `בקשה של מישהו אחר ${tag}` });

  // The permissions dialog: only assigned / created items, then invite a guest by email — nothing else.
  await page.goto(`/a/demo/b/${requests}`);
  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'הרשאות', exact: true }).click();
  const dialog = page.getByTestId('permissions-dialog');
  // A regular board: guests need "shareable" — change the board type here.
  await expect(dialog.getByTestId('perm-invite')).toContainText('אורחים נכנסים רק לבורד משותף');
  await dialog.getByTestId('perm-kind-shareable').click();
  await expect(dialog.getByTestId('perm-kind-shareable')).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.getByTestId('perm-invite')).not.toContainText('אורחים נכנסים רק לבורד משותף');
  const onlyMine = dialog.getByTestId('perm-view-items').getByRole('radio', { name: 'רק מה שיצרו או הוקצה להם' });
  await onlyMine.click();
  await expect(onlyMine).toHaveAttribute('aria-checked', 'true');
  const invite = dialog.getByTestId('perm-invite');
  const email = `guest-${tag}@client.test`;
  await invite.getByLabel('כתובות מייל').fill(email);
  await invite.getByRole('button', { name: 'תפקיד' }).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: 'אורח' }).click();
  await page.screenshot({ path: 'e2e/screens/m7-invite.png' });
  await invite.getByRole('button', { name: 'שליחת הזמנות' }).click();
  await expect(invite.getByText(/הזמנות שנשלחו: 1/)).toBeVisible();

  // The guest joins in another browser.
  const link = /https?:\/\/\S+\/invite\/[\w-]+/.exec(await latestMail(email))![0];
  const guest = await (await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' })).newPage();
  forbidNativeDialogs(guest);
  await guest.goto(link);
  await guest.getByLabel('שם מלא').fill('אורח');
  await guest.getByLabel('סיסמה').fill('a-very-good-password');
  await guest.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await guest.waitForURL(/\/a\/demo/);

  // The owner assigns them to one item.
  const users = (await (await page.request.get('/api/v1/users', { headers })).json()) as {
    data: { user_id: string; email: string; role: string }[];
  };
  const me = users.data.find((u) => u.email === email)!;
  expect(me.role).toBe('guest');
  await page.request.put(`/api/v1/items/${mine.id}/cells/${person}`, {
    headers,
    data: { value: { persons_and_teams: [{ id: me.user_id, kind: 'person' }] } },
  });

  // The same sidebar — only the shared board; only the item assigned to them.
  await expect(guest.getByRole('link', { name: `בקשות ${tag}` })).toBeVisible();
  await expect(guest.getByText(`פנימי ${tag}`)).toHaveCount(0);
  await guest.screenshot({ path: 'e2e/screens/m7-guest-home.png' });
  await guest.getByRole('link', { name: `בקשות ${tag}` }).click();
  await expect(guest.locator(`[data-testid="item-row"][data-item-name="הבקשה שלו ${tag}"]`)).toBeVisible();
  await expect(guest.locator(`[data-testid="item-row"][data-item-name="בקשה של מישהו אחר ${tag}"]`)).toHaveCount(0);
  // A new request of theirs stays visible to them.
  const add = guest.getByPlaceholder(/\+ הוספת פריט/).first();
  await add.fill(`בקשה חדשה ${tag}`);
  await add.press('Enter');
  await expect(guest.locator(`[data-testid="item-row"][data-item-name="בקשה חדשה ${tag}"]`)).toBeVisible();
  await guest.screenshot({ path: 'e2e/screens/m7-guest-board.png' });

  // A link to their item (as in a notification email) opens the card; another item does not exist for them.
  await guest.goto(`/a/demo/b/${requests}/i/${mine.id}?tab=updates`);
  await expect(guest.getByTestId('item-follow')).toBeVisible();
  await guest.goto(`/a/demo/b/${requests}/i/${other.id}`);
  await expect(guest.getByRole('dialog').getByText('לא נמצא')).toBeVisible();
  await expect(guest.getByText(`בקשה של מישהו אחר ${tag}`)).toHaveCount(0);

  // The owner sees all three.
  await page.reload();
  await expect(page.locator(`[data-testid="item-row"][data-item-name="בקשה חדשה ${tag}"]`)).toBeVisible();
  await expect(page.locator(`[data-testid="item-row"][data-item-name="בקשה של מישהו אחר ${tag}"]`)).toBeVisible();
});
