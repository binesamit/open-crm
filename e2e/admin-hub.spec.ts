// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * Account admin plan A1: Administration (`/admin/<section>`, admins only) with sections — entered from
 * the avatar menu, the "אני" page and the home page's shortcuts; and a workspace's own page (`/w/<id>`) from the
 * workspace's ⋯ menu in the sidebar: name, description, access, folders and boards, star, "new board here".
 */
test('administration: the avatar menu opens it; every section answers; home links to it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);

  // Home stays a welcome page: workspaces and shortcuts to the hub instead of the management blocks.
  await expect(page.getByTestId('home-admin')).toBeVisible();
  await expect(page.getByTestId('home-workspace').first()).toBeVisible();
  await expect(page.getByTestId('team-new')).toHaveCount(0);
  await expect(page.getByTestId('template-row')).toHaveCount(0);

  await page.getByTestId('profile-menu').first().click();
  await page.getByTestId('menu-admin').click();
  await expect(page).toHaveURL(/\/a\/demo\/admin\/general$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ניהול החשבון');
  await expect(page.getByTestId('admin-nav-general')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('admin-general-slug')).toHaveText('/a/demo');
  // A3: the account settings themselves (no more "coming soon").
  await expect(page.getByTestId('admin-general-locale')).toBeVisible();

  const nav = page.getByTestId('admin-nav');
  await nav.getByTestId('admin-nav-users').click();
  await expect(page).toHaveURL(/\/admin\/users$/);
  await expect(page.getByTestId('admin-section-users')).toBeVisible();

  await nav.getByTestId('admin-nav-teams').click();
  await expect(page.getByTestId('team-new')).toBeVisible();

  await nav.getByTestId('admin-nav-templates').click();
  await expect(page.getByTestId('template-row').first()).toBeVisible();

  await nav.getByTestId('admin-nav-connections').click();
  await expect(page.getByTestId('token-new')).toBeVisible();
  await expect(page.getByTestId('admin-webhooks')).toContainText('Webhooks');
  await page.getByTestId('admin-webhooks-automations').click();
  await expect(page).toHaveURL(/\/automations$/);
  await page.goBack();

  // A4 + A5: every section is built (no more "בשלב הבא").
  for (const s of ['security', 'usage', 'tidy', 'audit']) {
    await nav.getByTestId(`admin-nav-${s}`).click();
    await expect(page).toHaveURL(new RegExp(`/admin/${s}$`));
    await expect(page.getByTestId(`admin-${s}`)).toBeVisible();
    await expect(page.getByTestId('admin-next-stage')).toHaveCount(0);
  }
  await page.screenshot({ path: 'e2e/screens/admin-hub.png' });

  // An unknown section is not found; /admin opens "כללי".
  await page.goto('/a/demo/admin/nothing');
  await expect(page.getByText('לא נמצא')).toBeVisible();
  await page.goto('/a/demo/admin');
  await expect(page).toHaveURL(/\/admin\/general$/);

  // From home: a shortcut opens its section.
  await page.goto('/a/demo');
  await page.getByTestId('home-admin-teams').click();
  await expect(page).toHaveURL(/\/admin\/teams$/);
  await expect(page.getByTestId('admin-nav-teams')).toHaveAttribute('aria-current', 'page');
});

test('administration is for admins: a member is sent home and has no entry', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const mate = await newTeammate(page, browser, 'חבר בלי ניהול');
  await mate.goto('/a/demo/admin/users');
  await expect(mate).toHaveURL(/\/a\/demo\/?$/);
  await expect(mate.getByTestId('admin-hub')).toHaveCount(0);
  // Their home keeps the teams and templates cards.
  await expect(mate.getByTestId('home-admin')).toHaveCount(0);
  await expect(mate.getByTestId('template-row').first()).toBeVisible();
  await mate.getByTestId('profile-menu').first().click();
  await expect(mate.getByTestId('menu-my-profile')).toBeVisible();
  await expect(mate.getByTestId('menu-admin')).toHaveCount(0);
  await mate.context().close();
});

test('phone: the "אני" page links to administration; the sections scroll as chips', async ({ page }) => {
  forbidNativeDialogs(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto('/a/demo/me');
  await page.getByTestId('me-admin').click();
  await expect(page).toHaveURL(/\/admin\/general$/);
  await page.getByTestId('admin-nav-templates').click();
  await expect(page.getByTestId('template-row').first()).toBeVisible();
  // No page-wide horizontal scroll.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'e2e/screens/admin-hub.m.png' });
});

test('workspace page: from the sidebar ⋯; rename, describe, access, boards by folder, star, new board here', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const id = Date.now().toString(36);
  const name = `מרחב דף ${id}`;
  const ws = (await (await page.request.post('/api/v1/workspaces', { headers, data: { name } })).json()) as {
    id: string;
  };
  const folder = (await (
    await page.request.post('/api/v1/folders', { headers, data: { workspace_id: ws.id, name: `תיקייה ${id}` } })
  ).json()) as { id: string };
  await page.request.post('/api/v1/boards', {
    headers,
    data: { name: `בתיקייה ${id}`, workspace_id: ws.id, folder_id: folder.id },
  });
  await page.request.post('/api/v1/boards', { headers, data: { name: `בשורש ${id}`, workspace_id: ws.id } });

  // The sidebar: switch to it, then ⋯ → "דף המרחב".
  await page.goto('/a/demo');
  const sidebar = page.locator('aside').first();
  await sidebar.getByRole('button', { name: 'החלפת מרחב עבודה' }).click();
  await page.getByRole('menu').getByRole('menuitemradio', { name }).click();
  await sidebar.getByRole('button', { name: `פעולות ל${name}` }).click();
  await page.getByTestId('workspace-page-link').click();
  await expect(page).toHaveURL(new RegExp(`/w/${ws.id}$`));
  await expect(page.getByTestId('workspace-name')).toHaveText(name);
  await expect(page.getByTestId('workspace-counts')).toContainText('2 בורדים');

  // Boards by folder: the root first, then the folder.
  const folders = page.getByTestId('workspace-folder');
  await expect(folders).toHaveCount(2);
  await expect(folders.nth(0)).toContainText(`בשורש ${id}`);
  await expect(folders.nth(1)).toHaveAttribute('data-name', `תיקייה ${id}`);
  await expect(folders.nth(1)).toContainText(`בתיקייה ${id}`);

  // Rename in place.
  await page.getByTestId('workspace-rename').click();
  await page.getByTestId('workspace-name-input').fill(`${name} חדש`);
  await page.getByTestId('workspace-name-input').press('Enter');
  await expect(page.getByTestId('workspace-name')).toHaveText(`${name} חדש`);
  await expect(sidebar.getByRole('button', { name: 'החלפת מרחב עבודה' })).toContainText(`${name} חדש`);

  // A description.
  await expect(page.getByTestId('workspace-description-empty')).toBeVisible();
  await page.getByTestId('workspace-description-edit').click();
  await page.getByTestId('workspace-description-input').fill('מרחב לבדיקות הדף');
  await page.getByTestId('workspace-description-save').click();
  await expect(page.getByTestId('workspace-description')).toHaveText('מרחב לבדיקות הדף');
  await page.reload();
  await expect(page.getByTestId('workspace-description')).toHaveText('מרחב לבדיקות הדף');

  // Access: closed, then open again.
  await page.getByTestId('workspace-kind-closed').click();
  await expect(page.getByTestId('workspace-kind-badge')).toHaveAttribute('data-kind', 'closed');
  await page.getByTestId('workspace-kind-open').click();
  await expect(page.getByTestId('workspace-kind-badge')).toHaveAttribute('data-kind', 'open');

  // List layout; star a board — it shows among the sidebar's favourites; unstar it.
  await page.getByTestId('workspace-layout-list').click();
  const tile = page.locator(`[data-testid="workspace-board"][data-name="בשורש ${id}"]`);
  const star = tile.getByTestId('workspace-board-favorite');
  await tile.hover();
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(sidebar.getByText('מועדפים').first()).toBeVisible();
  await star.click();
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await page.screenshot({ path: 'e2e/screens/workspace-page.png' });

  // "New board here" in the folder: the dialog starts in that folder.
  await folders.nth(1).getByTestId('workspace-folder-new-board').click();
  await page.getByLabel('שם הבורד').fill(`חדש בדף ${id}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`חדש בדף ${id}`);
  await page.goBack();
  await expect(
    page.getByTestId('workspace-folder').nth(1).locator(`[data-testid="workspace-board"][data-name="חדש בדף ${id}"]`),
  ).toBeVisible();

  // A board opens from its tile.
  await tile.getByTestId('workspace-board-open').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`בשורש ${id}`);
});
