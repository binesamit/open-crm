// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M1.1 #4–6: short phone numbers, email with display text, people with profile photos. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('phone, email and people cells; profile photo', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);

  // Upload a profile photo from the avatar menu.
  const avatarButton = page.getByTestId('profile-menu');
  const me = (await avatarButton.getAttribute('aria-label'))!;
  await avatarButton.click();
  await page.getByTestId('avatar-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await expect(avatarButton.locator('img')).toBeVisible();
  // Esc closes the menu (the shared menu layer). A second click on the avatar used to stand here from before Esc
  // closed menus: it opened the menu again, and the open menu then covered the sidebar's "+" below (as soon as the
  // menu grew a row) — the menu must be gone before the board is created.
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('profile-menu-panel')).toHaveCount(0);

  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`קשר ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of ['טלפון', 'אימייל', 'אנשים']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('איש קשר');
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: 'איש קשר' }).first();

  // A star number shorter than 9 characters is accepted.
  await row.locator('[data-column-type="phone"]').click();
  await page.keyboard.type('*2700');
  await page.keyboard.press('Enter');
  // Plan: the number opens its click actions; a star number is not a valid number → call and copy only.
  const phone = row.locator('[data-column-type="phone"] [data-testid="phone-link"]');
  await expect(phone).toHaveText('*2700');
  await phone.click();
  await expect(page.getByTestId('phone-action-call')).toBeVisible();
  await expect(page.getByTestId('phone-action-copy')).toBeVisible();
  await expect(page.getByTestId('phone-action-whatsapp')).toHaveCount(0);
  await page.keyboard.press('Escape');

  // Email with a display text.
  await row.locator('[data-column-type="email"]').click();
  const popover = page.getByTestId('popover');
  await popover.getByLabel('כתובת אימייל').fill('dana@example.com');
  await popover.getByLabel('טקסט לתצוגה').fill('דנה');
  await popover.getByRole('button', { name: 'שמירה' }).click();
  const mail = row.locator('[data-column-type="email"] a');
  await expect(mail).toHaveText('דנה');
  await expect(mail).toHaveAttribute('href', 'mailto:dana@example.com');

  // People: the picker shows photos; the cell shows mine.
  await row.locator('[data-column-type="people"]').click();
  const mine = popover.locator('label', { hasText: me });
  await expect(mine.locator('img')).toBeVisible();
  await mine.getByRole('checkbox').click();
  await expect(mine.getByRole('checkbox')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(row.locator('[data-column-type="people"] img')).toHaveAttribute('alt', me);

  // Removing the photo falls back to initials everywhere.
  await avatarButton.click();
  await page.getByTestId('menu-photo').click(); // round 9: upload / remove sit in the "תמונת פרופיל" submenu
  await page.getByRole('menuitem', { name: 'הסרת התמונה' }).click();
  await expect(avatarButton.locator('img')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('[data-column-type="people"]').first().getByRole('img', { name: me })).toBeVisible();
  await expect(page.locator('[data-column-type="people"] img')).toHaveCount(0);
});
