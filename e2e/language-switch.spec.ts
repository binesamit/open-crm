// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, rowMenu, signIn } from './helpers';

/*
 * fix3: (1) the profile language switches the whole UI (texts, <html lang/dir>) and back; (2) moving an item to
 * another board can create a missing column there ("+ עמודה חדשה") with the source column's type.
 */

const openProfile = async (page: Page) => {
  await page.getByTestId('profile-menu').first().click();
  await page.getByTestId('menu-my-profile').click();
  // fix5: "הפרופיל שלי" is a page with tabs; the details form is its first tab.
  return page.getByTestId('profile-form');
};

const setLanguage = async (page: Page, locale: 'he' | 'en') => {
  const dialog = await openProfile(page);
  await dialog.getByTestId(`profile-locale-${locale}`).click();
  await page.getByTestId('profile-save').click();
  await expect(page.locator('html')).toHaveAttribute('lang', locale);
};

test('the profile language switches the UI to English (LTR) and back to Hebrew (RTL)', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  const { headers } = await ownerContext(page);
  try {
    await setLanguage(page, 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
    await expect(page.getByTestId('nav-my-work').first()).toHaveAccessibleName(/My work/);

    // It sticks: a reload comes back in English (from the user, and from this browser before /auth/me answers).
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.getByTestId('nav-my-work').first()).toHaveAccessibleName(/My work/);
    await page.waitForLoadState('networkidle');
    const form = await openProfile(page);
    await expect(form).toBeVisible();
    await expect(page.getByTestId('profile-page')).toContainText('My profile');
    await setLanguage(page, 'he');
  } finally {
    // Never leave the shared local user in English (every later spec expects Hebrew).
    await page.request.patch('/api/v1/users/me', { headers, data: { locale: 'he' } });
  }
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(page.getByTestId('nav-my-work').first()).toHaveAccessibleName(/העבודה שלי/);
});

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, name: string, withNumbers: boolean) => {
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  if (withNumbers) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: 'מספרים', exact: true }).click();
  }
  return page.url();
};

test('move to another board with "+ new column": the column is made on the target with the value', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const suffix = Date.now().toString(36);
  const targetName = `יעד חדש ${suffix}`;
  const targetUrl = await newBoard(page, targetName, false);
  await newBoard(page, `מקור חדש ${suffix}`, true);
  const add = page.getByPlaceholder(/\+ הוספת פריט/).first();
  await add.fill('Deal');
  await add.press('Enter');
  await expect(row(page, 'Deal')).toBeVisible();
  await row(page, 'Deal').locator('[data-column-type="numbers"]').click();
  await page.keyboard.type('42');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Deal').locator('[data-column-type="numbers"]')).toHaveText('42');

  await rowMenu(page, row(page, 'Deal'), 'העברה לבורד אחר');
  const dialog = page.getByTestId('move-dialog');
  await dialog.getByTestId('move-board').click();
  await page.getByRole('menu').getByRole('menuitemradio', { name: targetName }).click();

  // The target has no numbers column: the row offers "+ עמודה חדשה: מספרים (מספרים)".
  const mappingRow = dialog.locator('[data-testid="mapping-row"][data-source="מספרים"]');
  await mappingRow.getByRole('button').first().click();
  const option = page.getByRole('menu').getByTestId('mapping-new-option');
  await expect(option).toContainText('עמודה חדשה: מספרים (מספרים)');
  await expect(option).toBeEnabled();
  await option.click();
  await expect(mappingRow.getByTestId('mapping-new')).toBeVisible();
  await expect(page.getByTestId('move-confirm')).toHaveText('העברה');
  await page.getByTestId('move-confirm').click();
  await expect(row(page, 'Deal')).toHaveCount(0);

  await page.goto(targetUrl);
  await expect(row(page, 'Deal').locator('[data-column-type="numbers"]')).toHaveText('42');
});
