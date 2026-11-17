// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';
import { WEB_URL } from './stack';

/** M4 step 4 (D15, 08 §12.2–12.3): follow an item, notification settings, mute a board. */
const newBoardWithItem = async (page: Page, prefix: string) => {
  const boardName = `${prefix} ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(boardName);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('Watched');
  await add.press('Enter');
  const row = page.locator('[data-testid="item-row"][data-item-name="Watched"]');
  await expect(row).toBeVisible();
  return { boardName, row };
};

test('follow an item from its card and from the row menu', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { row } = await newBoardWithItem(page, 'מעקב');

  await row.hover();
  await row.getByRole('link', { name: 'פתיחה' }).click();
  const toggle = page.getByTestId('item-follow');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); // the creator follows (D15)
  await expect(toggle).toHaveText('במעקב');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await page.reload();
  await expect(page.getByTestId('item-follow')).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Escape');
  await expect(page).not.toHaveURL(/\/i\//);

  // The row's menu asks for the follow state when it opens: the entry is there at once (disabled, no
  // checkmark) and becomes clickable once the state is known — nothing shifts under the pointer.
  await row.hover();
  await row
    .getByRole('button', { name: /^פעולות ל/ })
    .first()
    .click();
  const follow = page.getByRole('menu').getByRole('menuitemradio', { name: 'מעקב אחרי הפריט' });
  await expect(follow).toHaveAttribute('aria-checked', 'false');
  await follow.click();
  await row.hover();
  await row.getByRole('link', { name: 'פתיחה' }).click();
  await expect(page.getByTestId('item-follow')).toHaveAttribute('aria-pressed', 'true');
});

test('notification settings: a category per channel and the digest, kept after reload', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  // Start from the defaults whatever an earlier run left behind.
  const accounts = (await (await page.request.get('/api/v1/me/accounts')).json()) as {
    data: { id: string; slug: string }[];
  };
  const accountId = accounts.data.find((a) => a.slug === 'demo')!.id;
  await page.request.patch('/api/v1/me/notifications/settings', {
    headers: { 'x-account-id': accountId, origin: WEB_URL },
    data: { categories: [{ key: 'mentioned', bell: true, email: true }], digest: 'instant' },
  });
  // fix5: my notification settings are a tab of "הפרופיל שלי".
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('menu-my-profile').click();
  await page.getByTestId('profile-tab-notifications').click();
  await expect(page.getByTestId('profile-tab-notifications')).toHaveAttribute('aria-selected', 'true');

  const mentionedEmail = page
    .locator('[data-testid="notif-category"][data-key="mentioned"]')
    .getByTestId('notif-email');
  await expect(mentionedEmail).toBeChecked();
  await mentionedEmail.click(); // the box follows the saved value a moment later
  await expect(mentionedEmail).not.toBeChecked();
  await page.getByTestId('notif-digest-daily').click();
  await expect(page.getByTestId('notif-digest-daily')).toHaveAttribute('aria-checked', 'true');

  await page.reload();
  await expect(mentionedEmail).not.toBeChecked();
  await expect(page.getByTestId('notif-digest-daily')).toHaveAttribute('aria-checked', 'true');

  // Back to the defaults (other tests and the real account rely on them).
  await mentionedEmail.click();
  await expect(mentionedEmail).toBeChecked();
  await page.getByTestId('notif-digest-instant').click();
  await expect(page.getByTestId('notif-digest-instant')).toHaveAttribute('aria-checked', 'true');

  // The bell links here too.
  await page.getByTestId('bell').click();
  await page.getByTestId('bell-settings').click();
  await expect(page.getByTestId('bell-panel')).toBeHidden();
  await expect(page).toHaveURL(/\/profile\?tab=notifications$/);
});

test('mute a board for me, and unmute it from the settings page', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { boardName } = await newBoardWithItem(page, 'השתקה');
  // N20: the board's notifications are a submenu of the header's ⋯ menu; the ⋯ carries their state.
  const button = page.getByTestId('board-more');
  await expect(button).toHaveAttribute('data-notif-muted', 'false');
  await button.click();
  await page.getByRole('menuitem', { name: /^התראות/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitemradio', { name: 'להשתיק את הבורד לכולם' })).toBeVisible(); // admin
  await menu.getByRole('menuitemradio', { name: 'להשתיק את הבורד בשבילי' }).click();
  await expect(button).toHaveAttribute('data-notif-muted', 'true');
  await button.click();
  await expect(page.getByRole('menuitem', { name: /^התראות/ })).toContainText('מושתק');
  await page.keyboard.press('Escape');

  await page.getByTestId('profile-menu').click();
  await page.getByTestId('menu-my-profile').click();
  await page.getByTestId('profile-tab-notifications').click();
  const muted = page.locator(`[data-testid="notif-muted-board"][data-name="${boardName}"]`);
  await expect(muted).toBeVisible();
  await muted.getByRole('button', { name: 'ביטול השתקה' }).click();
  await expect(muted).toHaveCount(0);
  await page.goBack();
  await expect(page.getByTestId('board-more')).toHaveAttribute('data-notif-muted', 'false');
});
