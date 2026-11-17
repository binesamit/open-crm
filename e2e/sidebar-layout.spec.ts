// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, latestMail, ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Fix list 4 (shell): the general places as a compact icon row at the top of the sidebar and me (the avatar
 * menu) at its bottom; a light / dark sidebar per user; "collapse all" for folders and sub-folders (remembered);
 * favourites reordered by drag; a guest nothing is shared with signs in to an empty, explaining home and never sees
 * tokens / admin / archive links.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const post = async (path: string, data: unknown) =>
    (await (await page.request.post(`/api/v1${path}`, { headers, data })).json()) as { id: string };
  return { headers, ws, post };
};

test('sidebar: places on top, me at the bottom; the avatar menu opens upwards', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const quick = page.getByTestId('sidebar-quick');
  await expect(quick).toBeVisible();
  for (const [id, name] of [
    ['nav-home', 'בית'],
    ['nav-my-work', 'העבודה שלי'],
    ['nav-inbox', 'תיבת עדכונים'],
    ['nav-automations', 'אוטומציות'],
  ] as const) {
    // Prod (canvas option ד): labelled tiles — the name is on the tile, not in a tooltip.
    await expect(quick.getByTestId(id)).toHaveAccessibleName(name);
    await expect(quick.getByTestId(id)).toContainText(name);
  }
  await expect
    .poll(() =>
      quick.getByTestId('search-open').evaluate((el) => el.getAttribute('title') ?? el.getAttribute('data-tip')),
    )
    .toMatch(/Ctrl\+B/);
  await expect(quick.getByTestId('bell')).toBeVisible();

  // Me at the bottom, below the workspace tree; the menu opens above it.
  const me = page.getByTestId('profile-menu');
  await expect(me.getByTestId('profile-menu-name')).toBeVisible();
  const quickBox = (await quick.boundingBox())!;
  const meBox = (await me.boundingBox())!;
  const firstBoard = (await page.getByTestId('board-row').first().boundingBox())!;
  expect(meBox.y).toBeGreaterThan(firstBoard.y);
  expect(quickBox.y).toBeLessThan(firstBoard.y);
  await me.click();
  const menu = page.getByRole('menu').filter({ has: page.getByTestId('menu-my-profile') });
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox())!.y + (await menu.boundingBox())!.height).toBeLessThanOrEqual(meBox.y + 1);
  await page.keyboard.press('Escape');
  await me.click();

  // The icons work.
  await quick.getByTestId('nav-my-work').click();
  await expect(page).toHaveURL(/\/my-work$/);
  await quick.getByTestId('search-open').click();
  await expect(page.getByTestId('search-palette')).toBeVisible();
  await page.keyboard.press('Escape');

  // The collapsed rail keeps the same places, and the avatar at its bottom.
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('nav-inbox')).toBeVisible();
  await expect(page.getByTestId('rail-boards')).toBeVisible();
  const railMe = (await page.getByTestId('profile-menu').boundingBox())!;
  expect(railMe.y).toBeGreaterThan((await page.getByTestId('rail-boards').boundingBox())!.y);
  await page.getByTestId('sidebar-collapse').click();
  await expect(page.getByTestId('sidebar-collapse')).toHaveAttribute('aria-expanded', 'true');
});

test('sidebar tone: light while the interface is light, always dark in dark mode; remembered', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const shell = page.locator('[data-sidebar]').first();
  const bg = () => shell.evaluate((el) => getComputedStyle(el).backgroundColor);

  // fix5: the appearance is a tab of "הפרופיל שלי".
  await page.goto('/a/demo/profile?tab=appearance');
  await page.getByTestId('theme-light').click();
  await page.getByTestId('sidebar-tone-light').click();
  await expect(shell).toHaveAttribute('data-sidebar', 'light');
  await expect.poll(bg).toBe('rgb(237, 243, 240)');

  // Dark interface: the sidebar stays dark (and the tab says why).
  await page.getByTestId('theme-dark').click();
  await expect.poll(bg).not.toBe('rgb(237, 243, 240)');
  await expect(page.getByTestId('sidebar-tone')).toContainText('בממשק כהה הסרגל תמיד כהה');
  await page.getByTestId('theme-light').click();

  // Remembered on this device.
  await page.reload();
  await expect(page.locator('[data-sidebar]').first()).toHaveAttribute('data-sidebar', 'light');
  await expect.poll(bg).toBe('rgb(237, 243, 240)');

  // The "אני" page leads to the same tab.
  await page.goto('/a/demo/me');
  await page.getByTestId('me-appearance').click();
  await page.getByTestId('sidebar-tone-dark').click();
  await expect(shell).toHaveAttribute('data-sidebar', 'dark');
  await page.getByTestId('theme-light').click();
  await expect.poll(bg).toBe('rgb(13, 59, 53)');
  await page.getByTestId('theme-system').click();
});

test('collapse all folders and sub-folders — from the header and the workspace menu, remembered', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { headers, ws, post } = await setup(page);
  const wsName = (
    (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as {
      data: { id: string; name: string }[];
    }
  ).data.find((w) => w.id === ws)!.name;
  const top = await post('/folders', { workspace_id: ws, parent_folder_id: null, name: `ראשית ${id}` });
  const sub = await post('/folders', { workspace_id: ws, parent_folder_id: top.id, name: `משנה ${id}` });
  await post('/boards', { name: `בתיקייה ${id}`, workspace_id: ws, folder_id: sub.id });
  await page.reload();

  const folder = (name: string) => page.getByTestId('folder-row').filter({ hasText: name }).getByRole('button').first();
  const board = page.getByTestId('board-row').filter({ hasText: `בתיקייה ${id}` });
  await expect(board).toBeVisible();

  const toggle = page.getByTestId('sidebar-folders-toggle');
  await expect(toggle).toHaveAccessibleName('כיווץ כל התיקיות');
  await toggle.click();
  await expect(folder(`ראשית ${id}`)).toHaveAttribute('aria-expanded', 'false');
  await expect(board).toHaveCount(0);
  await expect(toggle).toHaveAccessibleName('פתיחת כל התיקיות');

  // Sub-folders are closed too: open the top one only — its sub-folder stays closed.
  await folder(`ראשית ${id}`).click();
  await expect(folder(`משנה ${id}`)).toHaveAttribute('aria-expanded', 'false');
  await expect(board).toHaveCount(0);

  // Remembered after a reload.
  await page.reload();
  await expect(folder(`משנה ${id}`)).toHaveAttribute('aria-expanded', 'false');

  // From the workspace's ⋯ menu: one folder is open (mixed), so it offers "כיווץ" first, then "פתיחת הכל".
  const wsMenu = () => page.getByRole('button', { name: `פעולות ל${wsName}`, exact: true }).click();
  await wsMenu();
  await expect(page.getByRole('menu').getByTestId('workspace-folders-toggle')).toHaveText(/כיווץ כל התיקיות/);
  await page.getByRole('menu').getByTestId('workspace-folders-toggle').click();
  await expect(folder(`ראשית ${id}`)).toHaveAttribute('aria-expanded', 'false');
  await wsMenu();
  await expect(page.getByRole('menu').getByTestId('workspace-folders-toggle')).toHaveText(/פתיחת כל התיקיות/);
  await page.getByRole('menu').getByTestId('workspace-folders-toggle').click();
  await expect(board).toBeVisible();
  await expect(folder(`ראשית ${id}`)).toHaveAttribute('aria-expanded', 'true');
  await expect(folder(`משנה ${id}`)).toHaveAttribute('aria-expanded', 'true');
});

test('favourites are reordered by drag; the order is kept', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { headers, ws, post } = await setup(page);
  const a = await post('/boards', { name: `מועדף א ${id}`, workspace_id: ws });
  const b = await post('/boards', { name: `מועדף ב ${id}`, workspace_id: ws });
  const before = (await (await page.request.get('/api/v1/me/favorite-boards', { headers })).json()) as {
    data: { id: string }[];
  };
  await page.request.put('/api/v1/me/favorite-boards', {
    headers,
    data: { board_ids: [a.id, b.id, ...before.data.map((x) => x.id)] },
  });
  await page.reload();

  const favs = page.getByTestId('favorites-section').getByTestId('favorite-board-row');
  const rowA = favs.filter({ hasText: `מועדף א ${id}` });
  const rowB = favs.filter({ hasText: `מועדף ב ${id}` });
  await expect(favs.nth(0)).toHaveAttribute('data-name', `מועדף א ${id}`);

  // Drag B above A.
  const from = (await rowB.boundingBox())!;
  const to = (await rowA.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2 - 10, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 10 });
  await page.mouse.up();
  await expect(favs.nth(0)).toHaveAttribute('data-name', `מועדף ב ${id}`);
  await expect(favs.nth(1)).toHaveAttribute('data-name', `מועדף א ${id}`);
  // A drag is not a click: still on the same page.
  await expect(page).not.toHaveURL(new RegExp(`/b/${b.id}`));

  // Saved on the server.
  await expect
    .poll(async () => {
      const now = (await (await page.request.get('/api/v1/me/favorite-boards', { headers })).json()) as {
        data: { id: string }[];
      };
      return now.data.slice(0, 2).map((x) => x.id);
    })
    .toEqual([b.id, a.id]);
  await page.reload();
  await expect(favs.nth(0)).toHaveAttribute('data-name', `מועדף ב ${id}`);

  // Leave the owner's favourites as they were.
  await page.request.put('/api/v1/me/favorite-boards', {
    headers,
    data: { board_ids: before.data.map((x) => x.id) },
  });
});

test('a guest with no shared board signs in to an explaining home — no tree, no tokens / admin links', async ({
  page,
  browser,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const email = `lonely-guest-${uid()}@client.test`;
  await page.request.post('/api/v1/users/invite', { headers, data: { emails: [email], role: 'guest' } });
  const link = /https?:\/\/\S+\/invite\/[\w-]+/.exec(await latestMail(email))![0];

  const guest = await (await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' })).newPage();
  forbidNativeDialogs(guest);
  await guest.goto(link);
  await guest.getByLabel('שם מלא').fill('אורח בלי בורדים');
  await guest.getByLabel('סיסמה').fill('a-very-good-password');
  await guest.getByRole('button', { name: 'בחירת סיסמה והצטרפות' }).click();
  await guest.waitForURL(/\/a\/demo/);

  // Home: nothing shared yet, and who to ask.
  const empty = guest.getByTestId('guest-no-boards');
  await expect(empty).toContainText('עדיין לא שותף איתכם אף בורד');
  await expect(empty).toContainText('פנו למי שהזמין אתכם');
  // The sidebar: the general icons and me — no workspace switcher, no tree.
  await expect(guest.getByTestId('sidebar-quick')).toBeVisible();
  await expect(guest.getByTestId('sidebar-no-boards')).toBeAttached();
  await expect(guest.getByRole('button', { name: 'החלפת מרחב עבודה' })).toHaveCount(0);
  await expect(guest.getByTestId('board-row')).toHaveCount(0);
  await guest.screenshot({ path: 'e2e/screens/fix4-guest-empty.png' });

  // The avatar menu: no tokens, administration, trash or archive.
  await guest.getByTestId('profile-menu').click();
  await expect(guest.getByTestId('menu-my-profile')).toBeVisible();
  await expect(guest.getByTestId('menu-tokens')).toHaveCount(0);
  await expect(guest.getByTestId('menu-trash')).toHaveCount(0);
  await expect(guest.getByTestId('menu-admin')).toHaveCount(0);
  await expect(guest.getByTestId('menu-archive')).toHaveCount(0);
  await guest.keyboard.press('Escape');

  // "אני" and "בורדים" say the same.
  await guest.goto('/a/demo/me');
  await expect(guest.getByTestId('me-page')).toBeVisible();
  await expect(guest.getByTestId('me-notification-settings')).toBeVisible();
  await expect(guest.getByTestId('me-tokens')).toHaveCount(0);
  await expect(guest.getByTestId('me-trash')).toHaveCount(0);
  await expect(guest.getByTestId('me-admin')).toHaveCount(0);
  await expect(guest.getByTestId('me-archive')).toHaveCount(0);
  await guest.goto('/a/demo/boards');
  await expect(guest.getByTestId('boards-page-empty')).toContainText('עדיין לא שותף איתכם אף בורד');

  // The collapsed rail has no boards button either.
  await guest.goto('/a/demo');
  await guest.getByTestId('sidebar-collapse').click();
  await expect(guest.getByTestId('rail-boards')).toHaveCount(0);
  await guest.getByTestId('sidebar-collapse').click();
});
