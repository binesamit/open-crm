// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * s37generic — the sign-in screen's product name and tagline, and the tab title, come from the owner console
 * (Platform settings), per language; nothing branded in code. Puts the platform settings back as it found them.
 */
type Settings = { settings: { product_name?: string; login_subtitle?: { he?: string; en?: string } } };

test('owner sets the sign-in tagline and product name; the sign-in screen and the tab title follow', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const before = (await (await page.request.get('/api/v1/platform/settings')).json()) as Settings;
  try {
    await page.goto('/owner?section=general');
    await expect(page.getByTestId('owner-platform-settings')).toBeVisible();
    await page.getByTestId('owner-product-name').fill('WorkHub E2E');
    await page.getByTestId('owner-login-subtitle-he').fill('מערכת העבודה של הצוות');
    await page.getByTestId('owner-login-subtitle-en').fill('');
    await page.getByTestId('owner-platform-save').click();
    await expect
      .poll(async () => ((await (await page.request.get('/api/v1/platform/settings')).json()) as Settings).settings)
      .toMatchObject({ product_name: 'WorkHub E2E', login_subtitle: { he: 'מערכת העבודה של הצוות' } });
    // The signed-in tab follows the product name.
    await expect(page).toHaveTitle('WorkHub E2E');

    // A signed-out visitor (Hebrew): the product name on the shell and in the title, the tagline under it.
    const guest = await browser.newContext({ locale: 'he-IL' });
    try {
      const p = await guest.newPage();
      forbidNativeDialogs(p);
      await p.goto('/login');
      await expect(p.getByTestId('auth-product-name')).toHaveText('WorkHub E2E');
      await expect(p.getByTestId('login-subtitle')).toHaveText('מערכת העבודה של הצוות');
      await expect(p.getByRole('heading', { level: 1 })).toContainText('WorkHub E2E');
      await expect(p).toHaveTitle('WorkHub E2E');
    } finally {
      await guest.close();
    }

    // Empty tagline = no line at all.
    await page.request.patch('/api/v1/platform/settings', { headers, data: { login_subtitle: { he: null } } });
    const guest2 = await browser.newContext({ locale: 'he-IL' });
    try {
      const p = await guest2.newPage();
      await p.goto('/login');
      await expect(p.getByTestId('auth-product-name')).toHaveText('WorkHub E2E');
      await expect(p.getByTestId('login-subtitle')).toHaveCount(0);
    } finally {
      await guest2.close();
    }
  } finally {
    await page.request.patch('/api/v1/platform/settings', {
      headers,
      data: {
        product_name: before.settings.product_name ?? null,
        login_subtitle: {
          he: before.settings.login_subtitle?.he ?? null,
          en: before.settings.login_subtitle?.en ?? null,
        },
      },
    });
  }
});
