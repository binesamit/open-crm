// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';
import { WEB_URL } from './stack';

/** M4.5 stage 6 (after M5): notification summary schedule, account defaults, a board's custom notifications. */
const accountId = async (page: Page) =>
  (
    (await (await page.request.get('/api/v1/me/accounts')).json()) as { data: { id: string; slug: string }[] }
  ).data.find((a) => a.slug === 'demo')!.id;
const headers = (id: string) => ({ 'x-account-id': id, origin: WEB_URL });
const pick = async (page: Page, testId: string, option: string) => {
  await page.getByTestId(testId).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: option, exact: true }).click();
};

test('a weekly summary at a chosen day and hour; account defaults for admins', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = await accountId(page);
  await page.request.patch('/api/v1/me/notifications/settings', { headers: headers(id), data: { digest: 'instant' } });
  await page.getByTestId('profile-menu').click();
  await page.getByTestId('menu-my-profile').click();
  await page.getByTestId('profile-tab-notifications').click();

  await page.getByTestId('notif-digest-weekly').click();
  await pick(page, 'notif-digest-weekday', 'חמישי');
  await pick(page, 'notif-digest-hour', '17:00');
  await page.reload();
  await expect(page.getByTestId('notif-digest-weekly')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('notif-digest-weekday')).toHaveText(/חמישי/);
  await expect(page.getByTestId('notif-digest-hour')).toHaveText(/17:00/);
  await page.getByTestId('notif-digest-instant').click();
  await expect(page.getByTestId('notif-digest-hour')).toHaveCount(0);

  // Admins set the account defaults in Administration → התראות (A3); the personal page links there.
  await page.getByTestId('notif-defaults-link').click();
  await expect(page).toHaveURL(/\/admin\/notifications$/);
  const defaults = page.getByTestId('notif-defaults');
  await expect(defaults).toBeVisible();
  const box = defaults
    .locator('[data-testid="notif-default-category"][data-key="reminders"]')
    .getByTestId('notif-email');
  await expect(box).toBeChecked();
  await box.click();
  await expect(box).not.toBeChecked();
  await page.reload();
  await expect(box).not.toBeChecked();
  await box.click(); // back to the default
  await expect(box).toBeChecked();
});

test('a board: everything, custom categories, or muted', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`התראות ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  // N20: the board's notifications are a submenu of the header's ⋯ menu; the ⋯ carries their state.
  const button = page.getByTestId('board-more');
  await expect(button).toHaveAttribute('data-notif-mode', 'all');
  const openNotifications = async () => {
    await button.click();
    await page.getByRole('menuitem', { name: /^התראות/ }).click();
  };
  await openNotifications();
  await page.getByRole('menuitemradio', { name: /מותאם/ }).click();
  const custom = page.getByTestId('board-notif-custom');
  await custom.locator('[data-key="assigned"]').getByRole('checkbox').first().click();
  await page.getByTestId('board-notif-save').click();
  await expect(button).toHaveAttribute('data-notif-mode', 'custom');
  await page.reload();
  await expect(button).toHaveAttribute('data-notif-mode', 'custom');
  await openNotifications();
  await page.getByRole('menuitemradio', { name: 'לקבל התראות מהבורד' }).click();
  await expect(button).toHaveAttribute('data-notif-mode', 'all');
});

test('search: ">" commands, include archive', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.getByTestId('search-open').click();
  const input = page.getByTestId('search-input');
  await input.fill('>עבודה');
  const commands = page.locator('[data-testid="search-result"][data-kind="command"]');
  await expect(commands).toHaveCount(1);
  await input.press('Enter');
  await expect(page).toHaveURL(/\/my-work$/);

  // An archived item: found only with "include archive".
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`ארכיון ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const name = `Qzx${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
  await row.hover();
  await row
    .getByRole('button', { name: /^פעולות ל/ })
    .first()
    .click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'העברה לארכיון' }).click();
  await expect(row).toHaveCount(0);

  await page.getByTestId('search-open').click();
  await page.getByTestId('search-input').fill(name);
  await expect(page.getByTestId('search-empty')).toBeVisible();
  await page.getByTestId('search-archived').check();
  await expect(page.locator('[data-testid="search-result"][data-kind="item"]')).toContainText('בארכיון');
});
