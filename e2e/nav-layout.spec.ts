// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod (canvas "סרגל עליון וניווט"): Administration → מראה וניווט puts the shell's places in the sidebar
 * or a top bar for the account (and may lock it); הפרופיל שלי → מראה keeps the member's own layout. The board tree and
 * the profile menu never move; search (Ctrl+B) and the bell work from either place.
 */
const reset = async (page: Page) => {
  const { headers } = await ownerContext(page);
  await page.request.put('/api/v1/accounts/me/nav', { headers, data: { placement: {}, locked: false } });
  await page.request.put('/api/v1/me/nav', { headers, data: { placement: null } });
};

test.afterEach(async ({ page }) => {
  await reset(page);
});

test('admin: "navigation on top" moves the places into a top bar; Ctrl+B and the bell still work', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await reset(page);
  await page.goto('/a/demo');
  // Everything in the sidebar: no top bar, the labelled tiles.
  await expect(page.getByTestId('sidebar-tiles')).toBeVisible();
  await expect(page.getByTestId('top-bar')).toHaveCount(0);

  await page.goto('/a/demo/admin/appearance');
  await expect(page.getByTestId('admin-appearance')).toBeVisible();
  await expect(page.getByTestId('nav-preset-side').getByRole('radio')).toBeChecked();
  await page.getByTestId('nav-preset-top').click();
  // The preview draws the top bar.
  await expect(page.getByTestId('nav-preview-top')).toBeVisible();
  await page.getByTestId('nav-save').click();

  const top = page.getByTestId('top-bar');
  await expect(top).toBeVisible();
  await expect(top.getByTestId('top-bar-account')).toBeVisible();
  for (const id of ['nav-home', 'nav-my-work', 'nav-inbox', 'nav-automations']) {
    await expect(top.getByTestId('top-nav').getByTestId(id)).toBeVisible();
  }
  await expect(top.getByTestId('search-open')).toBeVisible();
  await expect(top.getByTestId('bell')).toBeVisible();
  // The sidebar keeps the tree and me, nothing else.
  await expect(page.getByTestId('sidebar-quick')).toHaveCount(0);
  await expect(page.getByTestId('profile-menu')).toBeVisible();

  await top.getByTestId('nav-my-work').click();
  await expect(page).toHaveURL(/\/my-work$/);
  await page.keyboard.press('Control+b');
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await page.keyboard.press('Escape');
  await top.getByTestId('bell').click();
  await expect(page.getByTestId('bell-panel')).toBeVisible();
  await page.keyboard.press('Escape');

  // The skip link stays the first stop on a fresh page.
  await page.reload();
  await expect(top).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('skip-to-content')).toBeFocused();
  await page.screenshot({ path: 'e2e/screens/nav-layout-top.png' });

  // The collapsed rail: the places stay on top, the rail keeps the boards and me.
  await page.getByTestId('sidebar-collapse').click();
  await expect(top.getByTestId('nav-inbox')).toBeVisible();
  await expect(page.getByTestId('rail-boards')).toBeVisible();
  await page.getByTestId('sidebar-collapse').click();
});

test('profile: my own layout, and a locked account layout', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await reset(page);
  await page.goto('/a/demo/profile?tab=appearance');
  const box = page.getByTestId('profile-nav-layout');
  await expect(box.getByTestId('nav-mode-account').getByRole('radio')).toBeChecked();
  // Following the account: the choices are shown but not choosable.
  await expect(box.getByTestId('nav-place-search-top')).toBeDisabled();

  await box.getByTestId('nav-mode-mine').click();
  await expect(box.getByTestId('nav-place-search-top')).toBeEnabled();
  await box.getByTestId('nav-place-search-top').click();
  await box.getByTestId('nav-place-bell-top').click();
  const top = page.getByTestId('top-bar');
  await expect(top.getByTestId('search-open')).toBeVisible();
  await expect(top.getByTestId('bell')).toBeVisible();
  // The destinations stay in the sidebar's tiles.
  await expect(page.getByTestId('sidebar-tiles').getByTestId('nav-inbox')).toBeVisible();
  // Not interested in automations: hidden — in neither bar.
  await box.getByTestId('nav-place-automations-hidden').click();
  await expect(page.getByTestId('nav-automations')).toHaveCount(0);
  await expect(box.getByTestId('nav-place-account-hidden')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screens/nav-layout-mine.png' });

  // An admin locks the account's layout (everything in the sidebar): mine no longer applies.
  const { headers } = await ownerContext(page);
  await page.request.put('/api/v1/accounts/me/nav', { headers, data: { placement: {}, locked: true } });
  await page.reload();
  await expect(page.getByTestId('nav-locked')).toBeVisible();
  await expect(box.getByTestId('nav-mode-mine').getByRole('radio')).toBeDisabled();
  await expect(page.getByTestId('top-bar')).toHaveCount(0);
});
