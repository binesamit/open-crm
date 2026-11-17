// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * Round 9 (product decisions): "מראה" as a submenu of the avatar menu; every open menu closes on a press anywhere else (and that
 * press still does its own thing); the profile photo is uploaded / removed from "הפרופיל שלי" and the avatar menu.
 */

const openMe = async (page: Page) => {
  await page.getByTestId('profile-menu').first().click();
  await expect(page.getByTestId('profile-menu-panel')).toBeVisible();
};

test('the avatar menu: "מראה" submenu switches the theme at once, in sync with the profile page', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const html = page.locator('html');

  await openMe(page);
  // The theme choices live in the submenu, not on the first level.
  await expect(page.getByTestId('menu-theme-dark')).toHaveCount(0);
  await page.getByTestId('menu-appearance').click();
  await expect(page.getByTestId('menu-theme-light')).toBeVisible();
  await expect(page.getByTestId('menu-theme-system')).toHaveText(/מערכת/);
  await expect(page.getByTestId('menu-sidebar-tone-dark')).toBeVisible();
  await page.getByTestId('menu-theme-dark').click();
  await expect(html).toHaveAttribute('data-theme', 'dark');
  // r17ui: an appearance choice keeps the menu open (try, compare); Esc closes it.
  await expect(page.getByTestId('menu-theme-dark')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('profile-menu-panel')).toHaveCount(0);

  // Reopened: the current choice is checked.
  await openMe(page);
  await page.getByTestId('menu-appearance').click();
  await expect(page.getByTestId('menu-theme-dark')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('menu-theme-light')).toHaveAttribute('aria-checked', 'false');
  await page.getByTestId('menu-theme-light').click();
  await expect(html).toHaveAttribute('data-theme', 'light');

  // The profile page's appearance tab shows the same choice, and a change there shows in the menu.
  await page.goto('/a/demo/profile?tab=appearance');
  await expect(page.getByTestId('theme-light')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('theme-system').click();
  await expect(html).not.toHaveAttribute('data-theme', /.+/);
  await openMe(page);
  await page.getByTestId('menu-appearance').click();
  await expect(page.getByTestId('menu-theme-system')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape'); // leaves the submenu
  await page.keyboard.press('Escape'); // closes the menu
  await expect(page.getByTestId('profile-menu-panel')).toHaveCount(0);
});

test('an open menu closes on a press anywhere else, and that press still does its thing', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const name = `r9 תפריט ${Date.now().toString(36)}`;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name, workspace_id: ws } })
  ).json()) as { id: string };
  await page.goto(`/a/demo/b/${board.id}`);
  const panel = page.getByTestId('profile-menu-panel');

  // The trigger toggles it.
  await openMe(page);
  await page.getByTestId('profile-menu').first().click();
  await expect(panel).toHaveCount(0);

  // A press on the board: the menu goes, and the press reaches the board (the search opens from its button).
  await openMe(page);
  await page.getByTestId('search-open').first().click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await page.keyboard.press('Escape');

  // A press on the board's content area (its title): the menu goes.
  await openMe(page);
  const box = (await page.locator('.app-panel').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 40);
  await expect(panel).toHaveCount(0);

  // A press on another menu's trigger: only one menu stays open — the board row's ⋯ menu.
  await openMe(page);
  const row = page.getByTestId('board-row').filter({ hasText: name }).first();
  await row.hover();
  await row
    .getByRole('button', { name: /^פעולות ל/ })
    .first()
    .click();
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('menu')).toHaveCount(1);
  // …and that one closes on a press on the sidebar, which navigates.
  await page.getByTestId('nav-my-work').first().click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page).toHaveURL(/\/my-work$/);

  // A press inside the menu keeps it open (the header with my name).
  await openMe(page);
  await page.getByTestId('profile-menu-header').click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);

  // The collapsed rail's boards flyout: a press outside it closes it and still lands (no overlay swallows it).
  await page.getByTestId('sidebar-collapse').click();
  await page.getByTestId('rail-boards').click();
  await expect(page.getByTestId('rail-boards-panel')).toBeVisible();
  await page.getByTestId('nav-inbox').first().click();
  await expect(page.getByTestId('rail-boards-panel')).toHaveCount(0);
  await expect(page).toHaveURL(/\/inbox$/);
  // Esc closes it too; the rail button toggles it.
  await page.getByTestId('rail-boards').click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('rail-boards-panel')).toHaveCount(0);
  await page.getByTestId('rail-boards').click();
  await page.getByTestId('rail-boards').click();
  await expect(page.getByTestId('rail-boards-panel')).toHaveCount(0);
  await page.getByTestId('sidebar-collapse').click();

  await page.request.delete(`/api/v1/boards/${board.id}`, { headers });
});

/** A non-square PNG drawn in the page (so the stored photo can be checked for the centre-square crop). */
const widePng = async (page: Page) =>
  Buffer.from(
    await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 300;
      c.height = 120;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#2f6fe0';
      ctx.fillRect(0, 0, 300, 120);
      ctx.fillStyle = '#c2410c';
      ctx.fillRect(110, 0, 80, 120);
      return c.toDataURL('image/png').split(',')[1]!;
    }),
    'base64',
  );

test('profile photo: upload from the avatar menu, shows in the sidebar, remove → initials; also from my profile', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const mate = await newTeammate(page, browser, 'צילום תשע');
  forbidNativeDialogs(mate);
  const png = await widePng(mate);
  const me = mate.getByTestId('profile-menu').first();
  await expect(me.locator('img')).toHaveCount(0);

  // From the avatar menu: "תמונת פרופיל" → upload (the real file chooser).
  await me.click();
  await mate.getByTestId('menu-photo').click();
  await expect(mate.getByTestId('menu-photo-remove')).toHaveCount(0);
  const chooser = mate.waitForEvent('filechooser');
  await mate.getByTestId('menu-photo-upload').click();
  await (await chooser).setFiles({ name: 'wide.png', mimeType: 'image/png', buffer: png });
  const img = me.locator('img');
  await expect(img).toBeVisible();
  // Stored as the centre square.
  await expect
    .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth > 0 && el.naturalWidth === el.naturalHeight))
    .toBe(true);

  // An SVG is refused before it is sent.
  await mate.getByTestId('avatar-input').setInputFiles({
    name: 'x.svg',
    mimeType: 'image/svg+xml',
    buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
  });
  await expect(mate.getByText('אפשר להעלות תמונה מסוג PNG, JPEG או WebP.')).toBeVisible();
  await expect(img).toBeVisible();

  // Remove → initials.
  await me.click();
  await mate.getByTestId('menu-photo').click();
  await mate.getByTestId('menu-photo-remove').click();
  await expect(me.locator('img')).toHaveCount(0);
  await expect(me.getByRole('img', { name: 'צילום תשע' })).toHaveText('צת');

  // "הפרופיל שלי": the avatar opens the photo panel → upload → the crop dialog → save; then remove it there (r15).
  await me.click();
  await mate.getByTestId('menu-my-profile').click();
  await expect(mate.getByTestId('profile-page')).toBeVisible();
  await mate.getByTestId('profile-avatar').click();
  const chooser2 = mate.waitForEvent('filechooser');
  await mate.getByTestId('profile-photo-upload').click();
  await (await chooser2).setFiles({ name: 'wide.png', mimeType: 'image/png', buffer: png });
  await mate.getByTestId('photo-crop-save').click();
  await expect(mate.getByTestId('profile-avatar').locator('img')).toBeVisible();
  await expect(me.locator('img')).toBeVisible(); // the sidebar too, at once
  await mate.getByTestId('profile-avatar').click();
  await mate.getByTestId('profile-photo-remove').click();
  await expect(mate.getByTestId('profile-avatar').locator('img')).toHaveCount(0);
  await expect(me.locator('img')).toHaveCount(0);
  await mate.context().close();
});
