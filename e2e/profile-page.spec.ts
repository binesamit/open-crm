// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, latestMail, openNewBoard, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Owner fixes (fix5-card): (1) "הפרופיל שלי" is one page with tabs — profile, my notification settings, my API
 * tokens, appearance — and the avatar menu no longer lists them; the old /settings/* addresses land in the tabs.
 * (2) A subitem's breadcrumb is only its ancestor items (no board, no group). (3) An image / file attached to an
 * update can be removed (✕ on hover, the system confirm). (4) Guests have no trash link and no trash page.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, items: string[]) => {
  const name = `תיקון5 ${uid()}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const item of items) {
    await add.fill(item);
    await add.press('Enter');
    await expect(row(page, item)).toBeVisible();
  }
  return name;
};

const openCard = async (page: Page, itemName: string) => {
  const r = row(page, itemName);
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: itemName });
  await expect(card).toBeVisible();
  return card;
};

test('my profile: one page with tabs; the avatar menu is short; old addresses land in the tabs', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);

  // The avatar menu: my profile, no separate notification settings / tokens / theme entries.
  await page.getByTestId('profile-menu').first().click();
  await expect(page.getByTestId('menu-my-profile')).toBeVisible();
  await expect(page.getByTestId('menu-notification-settings')).toHaveCount(0);
  await expect(page.getByTestId('menu-tokens')).toHaveCount(0);
  await expect(page.getByTestId('theme-dark')).toHaveCount(0);
  await expect(page.getByTestId('menu-trash')).toBeVisible();
  await page.getByTestId('menu-my-profile').click();

  const profile = page.getByTestId('profile-page');
  await expect(profile).toBeVisible();
  await expect(page).toHaveURL(/\/profile$/);
  await expect(page.getByTestId('profile-tab-profile')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('profile-form')).toBeVisible();

  // התראות: my own settings.
  await page.getByTestId('profile-tab-notifications').click();
  await expect(page).toHaveURL(/\/profile\?tab=notifications$/);
  await expect(page.getByTestId('notif-settings')).toBeVisible();

  // טוקני API: my own tokens — the account-wide ones (service tokens, everyone's) stay in Administration.
  await page.getByTestId('profile-tab-tokens').click();
  await expect(page.getByTestId('tokens-page')).toBeVisible();
  await expect(page.getByTestId('token-new')).toBeVisible();
  await expect(page.getByTestId('token-new-service')).toHaveCount(0);
  await expect(page.getByTestId('tokens-show-all')).toHaveCount(0);

  // מראה: theme and the sidebar's tone.
  await page.getByTestId('profile-tab-appearance').click();
  // A light sidebar under a dark theme explains that it stays dark there.
  await page.getByTestId('sidebar-tone-light').click();
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('sidebar-tone')).toContainText('בממשק כהה הסרגל תמיד כהה');
  await page.getByTestId('sidebar-tone-dark').click();
  await page.getByTestId('theme-system').click();
  await expect(page.getByTestId('sidebar-tone-dark')).toBeVisible();

  // The old addresses (links, bookmarks, the bell's ⚙) open the tabs.
  await page.goto('/a/demo/settings/notifications');
  await expect(page).toHaveURL(/\/profile\?tab=notifications$/);
  await expect(page.getByTestId('notif-settings')).toBeVisible();
  await page.goto('/a/demo/settings/tokens');
  await expect(page).toHaveURL(/\/profile\?tab=tokens$/);
  await expect(page.getByTestId('tokens-page')).toBeVisible();

  // The "אני" page: its rows lead into the same tabs.
  await page.goto('/a/demo/me');
  await page.getByTestId('me-tokens').click();
  await expect(page).toHaveURL(/\/profile\?tab=tokens$/);
  await page.goto('/a/demo/me');
  await page.getByTestId('me-profile-edit').click();
  await expect(page.getByTestId('profile-form')).toBeVisible();
});

test("a subitem's breadcrumb is only its ancestors — no board, no group", async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardName = await newBoard(page, ['ראשי']);
  const card = await openCard(page, 'ראשי');
  // A top-level item keeps "board / group".
  await expect(card.getByTestId('card-breadcrumb-board')).toHaveText(boardName);
  await card.locator('[data-testid="card-tab"][data-tab-id="subitems"]').click();
  await card.getByTestId('card-subitem-add').first().fill('משני');
  await card.getByTestId('card-subitem-add').first().press('Enter');
  const child = card.locator('[data-testid="card-subitem"][data-item-name="משני"]');
  await expect(child).toBeVisible();
  const childId = await child.getAttribute('data-item-id');
  await child.getByTestId('card-subitem-toggle').click();
  const nestedAdd = card.locator(`[data-testid="card-subitem-add"][data-parent-id="${childId}"]`);
  await nestedAdd.fill('שלישי');
  await nestedAdd.press('Enter');
  const grandchild = card.locator('[data-testid="card-subitem"][data-item-name="שלישי"]');
  await expect(grandchild).toBeVisible();

  await grandchild.getByTestId('card-subitem-open').click();
  const gCard = page.getByRole('dialog', { name: 'שלישי' });
  await expect(gCard).toBeVisible();
  const crumb = gCard.getByTestId('card-breadcrumb');
  await expect(crumb.getByTestId('card-breadcrumb-item')).toHaveText(['ראשי', 'משני']);
  await expect(crumb.getByTestId('card-breadcrumb-board')).toHaveCount(0);
  await expect(crumb).not.toContainText(boardName);
  await expect(crumb).not.toContainText('/ ראשי /'); // no leading separator before the top item
  // The top item opens its card.
  await crumb.getByTestId('card-breadcrumb-item').first().click();
  await expect(page.getByRole('dialog', { name: 'ראשי' })).toBeVisible();
});

test("an update's pasted image and attached file can be removed (system confirm)", async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['צרופות']);
  const card = await openCard(page, 'צרופות');

  // Paste an image, attach a file; one is taken off again before sending.
  const box = card.getByLabel(/כתבו עדכון/);
  await box.click();
  await box.pressSequentially('עם צרופות');
  const paste = (name: string, type: string, b64: string) =>
    box.evaluate(
      (el, f) => {
        const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
        const dt = new DataTransfer();
        dt.items.add(new File([bytes], f.name, { type: f.type }));
        el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      },
      { name, type, b64 },
    );
  await paste('shot.png', 'image/png', PNG_1PX);
  await paste('notes.txt', 'text/plain', Buffer.from('hello').toString('base64'));
  await paste('extra.txt', 'text/plain', Buffer.from('extra').toString('base64'));
  await expect(card.getByTestId('composer-image')).toBeVisible();
  await expect(card.getByTestId('composer-file-remove')).toHaveCount(3);
  await card.getByRole('button', { name: 'הסרת הקובץ: extra.txt' }).click();
  await expect(card.getByTestId('composer-file-remove')).toHaveCount(2);
  await card.getByRole('button', { name: 'עדכון', exact: true }).click();

  const update = card.locator('article', { hasText: 'עם צרופות' }).first();
  await expect(update.getByTestId('update-image')).toBeVisible();
  await expect(update.getByTestId('update-file')).toHaveCount(1);
  await expect(update.locator('[data-testid="update-attachment"][data-name="extra.txt"]')).toHaveCount(0);

  // The image: ✕ on hover → the system confirm; "cancel" keeps it.
  const image = update.locator('[data-testid="update-attachment"][data-name="shot.png"]');
  await image.hover();
  await image.getByTestId('update-file-remove').click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm).toContainText('shot.png');
  await confirm.getByRole('button', { name: 'ביטול' }).click();
  await expect(update.getByTestId('update-image')).toBeVisible();
  await image.hover();
  await image.getByTestId('update-file-remove').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'הסרת הקובץ' }).click();
  await expect(update.getByTestId('update-image')).toHaveCount(0);

  // The file too — also while the update is being edited. In the editor (f9-updedit) the attached files show in the
  // composer: ✕ takes the file off there (no confirm — nothing changes until the edit is saved), saving detaches it.
  await update.getByRole('button', { name: 'פעולות לעדכון' }).first().click();
  await page.getByRole('menuitem', { name: /עריכה/ }).click();
  const file = update.locator('[data-testid="composer-file"][data-existing="true"][data-name="notes.txt"]');
  await expect(file).toBeVisible();
  await update.getByRole('button', { name: 'הסרת הקובץ: notes.txt' }).click();
  await expect(file).toHaveCount(0);
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await update.getByTestId('composer-send').click();
  await expect(update.getByTestId('composer-send')).toHaveCount(0);
  await expect(update.getByTestId('update-file')).toHaveCount(0);
  await expect(update).toContainText('עם צרופות');
});

test('a guest has no trash link anywhere, and /trash sends them home', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const email = `trash-guest-${uid()}@client.test`;
  await page.request.post('/api/v1/users/invite', { headers, data: { emails: [email], role: 'guest' } });
  const link = /https?:\/\/\S+\/invite\/[\w-]+/.exec(await latestMail(email))![0];

  const guest = await (await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' })).newPage();
  forbidNativeDialogs(guest);
  await guest.goto(link);
  await guest.getByLabel('שם מלא').fill('אורח בלי סל');
  await guest.getByLabel('סיסמה').fill('a-very-good-password');
  await guest.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await guest.waitForURL(/\/a\/demo/);

  await guest.getByTestId('profile-menu').first().click();
  await expect(guest.getByTestId('menu-my-profile')).toBeVisible();
  await expect(guest.getByTestId('menu-trash')).toHaveCount(0);
  await guest.keyboard.press('Escape');

  await guest.goto('/a/demo/me');
  await expect(guest.getByTestId('me-page')).toBeVisible();
  await expect(guest.getByTestId('me-trash')).toHaveCount(0);
  await expect(guest.getByTestId('me-tokens')).toHaveCount(0);

  // Their profile has no tokens tab (the old address falls back to the profile tab).
  await guest.goto('/a/demo/settings/tokens');
  await expect(guest.getByTestId('profile-page')).toBeVisible();
  await expect(guest.getByTestId('profile-tab-tokens')).toHaveCount(0);
  await expect(guest.getByTestId('profile-form')).toBeVisible();

  await guest.goto('/a/demo/trash');
  await expect(guest).toHaveURL(/\/a\/demo\/?$/);
  await guest.context().close();
});
