// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, openNewBoard, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * M4 step 2 (07 §9.3): a teammate mentions me → the bell counts it live; a click opens the item; mark all read.
 * Live = over `/me/events` with no refetch: the spec first proves the channel is open (the teammate's "accepted"
 * notification shows up and goes again) before it counts mentions, and gives each live change LIVE_MS.
 */
const LIVE_MS = 10_000;
test('a mention from a teammate rings the bell and opens the item', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`פעמון ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Ping');
  await add.press('Enter');
  await expect(page.locator('[data-testid="item-row"][data-item-name="Ping"]')).toBeVisible();
  const boardId = /\/b\/([0-9A-Z]{26})/.exec(page.url())![1]!;

  const accounts = (await (await page.request.get('/api/v1/me/accounts')).json()) as {
    data: { id: string; slug: string }[];
  };
  const accountId = accounts.data.find((a) => a.slug === 'demo')!.id;
  const headers = { 'x-account-id': accountId, origin: WEB_URL };
  const me = (await (await page.request.get('/api/v1/auth/me')).json()) as { user: { id: string } };
  const items = (await (await page.request.get(`/api/v1/boards/${boardId}/items`, { headers })).json()) as {
    data: { id: string; name: string }[];
  };
  const itemId = items.data.find((i) => i.name === 'Ping')!.id;
  await page.request.post('/api/v1/me/notifications/read', { headers, data: { all: true } });
  // A fresh load reads the bell after that (a page still connecting its event stream would keep the old count).
  await page.reload();
  await expect(page.locator('[data-testid="item-row"][data-item-name="Ping"]')).toBeVisible();
  await expect(page.getByTestId('bell-count')).toBeHidden();

  // A teammate joins the account (closed with the page).
  const other = await newTeammate(page, browser);
  // sync-invites: the inviter hears that the invitation was accepted — live, which shows the bell's channel is open;
  // read it, so the bell counts the mentions only.
  await expect
    .poll(async () => {
      const list = (await (await page.request.get('/api/v1/me/notifications?limit=20', { headers })).json()) as {
        data: { type: string; read_at: string | null }[];
      };
      return list.data.some((n) => n.type === 'invitation_accepted' && !n.read_at);
    })
    .toBe(true);
  await expect(page.getByTestId('bell-count')).toBeVisible({ timeout: LIVE_MS });
  await page.request.post('/api/v1/me/notifications/read', { headers, data: { all: true } });
  await expect(page.getByTestId('bell-count')).toBeHidden({ timeout: LIVE_MS });

  const bell = page.getByTestId('bell');
  const mention = (text: string) =>
    other.request.post(`/api/v1/items/${itemId}/updates`, {
      headers,
      data: { body: `[@Owner](user:${me.user.id}) ${text}` },
    });
  expect((await mention('בדיקת פעמון')).status()).toBe(200);
  await expect(page.getByTestId('bell-count')).toHaveText('1', { timeout: LIVE_MS });

  await bell.click();
  const row = page.getByTestId('bell-panel').getByTestId('notification').first();
  await expect(row).toHaveAttribute('data-type', 'mention');
  await expect(row).toHaveAttribute('data-read', 'false');
  await expect(row).toContainText('חברת צוות תייג/ה אתכם ב־Ping');
  await expect(row).toContainText('בדיקת פעמון');
  await expect(page.getByTestId('bell-panel')).toContainText('היום');
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/i/${itemId}\\?tab=updates`));
  await expect(page.getByTestId('bell-panel')).toBeHidden();
  await expect(page.getByTestId('bell-count')).toBeHidden();

  // The item card opens over the whole app (N19, canvas Item-Updates — the sidebar and its bell too); close it.
  await expect(page.getByRole('dialog', { name: 'Ping' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Ping' }).getByRole('button', { name: 'סגירה' }).click();
  await expect(page.getByRole('dialog', { name: 'Ping' })).toBeHidden();
  expect((await mention('עוד אחת')).status()).toBe(200);
  expect((await mention('ועוד')).status()).toBe(200);
  await expect(page.getByTestId('bell-count')).toHaveText('2', { timeout: LIVE_MS });
  await bell.click();
  await page.getByTestId('bell-filter-unread').click();
  await expect(page.getByTestId('bell-panel').getByTestId('notification')).toHaveCount(2);
  await page.getByTestId('bell-read-all').click();
  await expect(page.getByTestId('bell-count')).toBeHidden();
  await expect(page.getByTestId('bell-panel')).toContainText('אין התראות');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('bell-panel')).toBeHidden();
});
