// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, latestMail, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Owner fixes (fix6-server): (1) a filter on a subitem column keeps items that have no subitems at all;
 * (2) a file removed from the update composer before sending leaves storage (DELETE /files/:id);
 * (3) invitations from a board's permissions dialog and a workspace's members section (closed workspaces).
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const encode = (q: unknown) => Buffer.from(JSON.stringify(q)).toString('base64url');

test('a sub-status filter keeps an item that has no subitems', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const post = async (path: string, data: unknown) =>
    (await (await page.request.post(`/api/v1${path}`, { headers, data })).json()) as { id: string };
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const tag = uid();
  const board = await post('/boards', { name: `סינון סאב ${tag}`, workspace_id: ws.id });
  const done = await post(`/boards/${board.id}/items`, { name: `הכול הושלם ${tag}` });
  const open = await post(`/boards/${board.id}/items`, { name: `פתוח ${tag}` });
  await post(`/boards/${board.id}/items`, { name: `בלי תתי-פריטים ${tag}` });
  await post(`/items/${done.id}/subitems`, { name: 'א', cells: { status: { index: 1 } } });
  await post(`/items/${open.id}/subitems`, { name: 'ב', cells: { status: { index: 0 } } });

  const q = encode({
    filter: {
      kind: 'group',
      operator: 'and',
      rules: [{ column_id: 'sub:status', operator: 'is_not_done', values: [] }],
    },
  });
  await page.goto(`/a/demo/b/${board.id}?q=${q}`);
  const row = (name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
  await expect(row(`בלי תתי-פריטים ${tag}`)).toBeVisible();
  await expect(row(`פתוח ${tag}`)).toBeVisible();
  await expect(row(`הכול הושלם ${tag}`)).toHaveCount(0);
});

test('a file removed from the composer before sending is discarded on the server', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!;
  const tag = uid();
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `טיוטה ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: `פריט ${tag}` } });
  await page.goto(`/a/demo/b/${board.id}`);
  const r = page.locator(`[data-testid="item-row"][data-item-name="פריט ${tag}"]`);
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: `פריט ${tag}` });
  await expect(card).toBeVisible();
  await card.locator('.ProseMirror').first().click();
  await card
    .locator('.ProseMirror')
    .first()
    .evaluate((el) => {
      const dt = new DataTransfer();
      dt.items.add(new File([new TextEncoder().encode('draft')], 'draft.txt', { type: 'text/plain' }));
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
  await expect(card.getByTestId('composer-file-remove')).toHaveCount(1);
  const discarded = page.waitForResponse(
    (res) => res.request().method() === 'DELETE' && /\/api\/v1\/files\/[\w]+$/.test(res.url()),
  );
  await card.getByRole('button', { name: 'הסרת הקובץ: draft.txt' }).click();
  expect((await discarded).status()).toBe(200);
  await expect(card.getByTestId('composer-file-remove')).toHaveCount(0);
});

test('a closed workspace: members are listed, invited by email and removed', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = uid();
  const ws = (await (
    await page.request.post('/api/v1/workspaces', { headers, data: { name: `סגור ${tag}`, kind: 'closed' } })
  ).json()) as { id: string };
  await page.goto(`/a/demo/w/${ws.id}`);
  const members = page.getByTestId('workspace-members');
  await expect(members).toBeVisible();
  await expect(members.getByTestId('workspace-member')).toHaveCount(1); // the creator (owner)

  const email = `ws-${tag}@demo.test`;
  const invite = members.getByTestId('workspace-invite');
  await invite.getByLabel('כתובות מייל').fill(email);
  await invite.getByTestId('workspace-invite-send').click();
  await expect(invite.getByTestId('workspace-invite-result')).toContainText('הזמנות שנשלחו: 1');
  await page.screenshot({ path: 'e2e/screens/fix6-workspace-members.png' });

  // They accept in another browser: the closed workspace is theirs to see.
  const link = /https?:\/\/\S+\/invite\/[\w-]+/.exec(await latestMail(email))![0];
  const other = await (await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' })).newPage();
  forbidNativeDialogs(other);
  await other.goto(link);
  await other.getByLabel('שם מלא').fill('חבר מרחב');
  await other.getByLabel('סיסמה').fill('a-very-good-password');
  await other.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await other.waitForURL(/\/a\/demo/);
  await other.goto(`/a/demo/w/${ws.id}`);
  await expect(other.getByTestId('workspace-page')).toBeVisible();

  await page.reload();
  const row = members.locator(`[data-testid="workspace-member"][data-email="${email}"]`);
  await expect(row).toBeVisible();
  await row.getByTestId('workspace-member-remove').click();
  await expect(row).toHaveCount(0);
  await other.reload();
  await expect(other.getByTestId('workspace-page')).toHaveCount(0);
});

test('the board permissions dialog invites by email (new people) and adds account members at once', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = uid();
  const ws = (await (
    await page.request.post('/api/v1/workspaces', { headers, data: { name: `סגור בורד ${tag}`, kind: 'closed' } })
  ).json()) as { id: string };
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `בורד מוזמנים ${tag}`, workspace_id: ws.id } })
  ).json()) as { id: string };
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'הרשאות', exact: true }).click();
  const dialog = page.getByTestId('permissions-dialog');
  const form = dialog.getByTestId('perm-invite-form');
  await form.getByLabel('כתובות מייל').fill(`board-${tag}@demo.test`);
  await form.getByTestId('perm-invite-form-send').click();
  await expect(form.getByTestId('perm-invite-form-result')).toContainText('הזמנות שנשלחו: 1');
});
