// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn } from './helpers';

/** M7.6 shell: N1 phone bottom navigation + the "בורדים" / "אני" screens, N13 "בורד חדש" as a dialog. */

test('phone: bottom navigation, screen titles, boards and me screens', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  // A board at the root of the first workspace (the one the boards screen opens on in a fresh browser).
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const boardName = `נייד ${Date.now().toString(36)}`;
  await page.request.post('/api/v1/boards', { headers, data: { name: boardName, workspace_id: ws } });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/a/demo');
  const nav = page.getByTestId('bottom-nav');
  await expect(nav).toBeVisible();
  for (const key of ['home', 'my-work', 'inbox', 'boards', 'me']) {
    await expect(nav.getByTestId(`bottom-nav-${key}`)).toBeVisible();
  }
  await expect(nav.getByTestId('bottom-nav-home')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('mobile-title')).toHaveText('בית');
  await expect(nav.getByTestId('bottom-nav-inbox')).toContainText('עדכונים');

  // Content ends above the bottom nav (the nav is in the flow, not over the panel).
  const panel = await page.locator('.app-panel').boundingBox();
  const navBox = await nav.boundingBox();
  expect(panel!.y + panel!.height).toBeLessThanOrEqual(navBox!.y + 1);

  // My work and updates: the tab lights and the top bar names the screen.
  await nav.getByTestId('bottom-nav-my-work').click();
  await expect(page).toHaveURL(/\/a\/demo\/my-work$/);
  await expect(page.getByTestId('mobile-title')).toHaveText('העבודה שלי');
  await expect(nav.getByTestId('bottom-nav-my-work')).toHaveAttribute('aria-current', 'page');
  await nav.getByTestId('bottom-nav-inbox').click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByTestId('mobile-title')).toHaveText('תיבת עדכונים');

  // Boards: the workspace tree full-screen; a tap opens the board, which stays under "בורדים" with its name on top.
  await nav.getByTestId('bottom-nav-boards').click();
  await expect(page).toHaveURL(/\/boards$/);
  await expect(page.getByTestId('boards-page')).toBeVisible();
  await expect(page.getByTestId('mobile-title')).toHaveText('בורדים');
  await expect(page.getByTestId('boards-workspace-switcher')).toBeVisible();
  await page.getByTestId('boards-page-board').filter({ hasText: boardName }).click();
  await expect(page).toHaveURL(/\/b\/[\w-]+/);
  await expect(page.getByTestId('mobile-title')).toHaveText(boardName);
  await expect(nav.getByTestId('bottom-nav-boards')).toHaveAttribute('aria-current', 'page');

  // Me: profile, theme, settings links, sign out.
  await nav.getByTestId('bottom-nav-me').click();
  const me = page.getByTestId('me-page');
  await expect(me).toBeVisible();
  await expect(page.getByTestId('mobile-title')).toHaveText('אני');
  await expect(me.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('me-sign-out')).toBeVisible();
  // fix5: appearance and notification settings are tabs of "הפרופיל שלי".
  await page.getByTestId('me-appearance').click();
  await page.getByTestId('theme-dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByTestId('theme-system').click();
  await page.goBack();
  await page.getByTestId('me-notification-settings').click();
  await expect(page).toHaveURL(/\/profile\?tab=notifications$/);
  await expect(page.getByTestId('notif-settings')).toBeVisible();
  await expect(page.getByTestId('mobile-title')).toHaveText('הפרופיל שלי');
  await expect(nav.getByTestId('bottom-nav-me')).toHaveAttribute('aria-current', 'page');

  // The drawer still opens from the top bar.
  await page.getByTestId('nav-drawer-open').click();
  await expect(page.getByRole('complementary', { name: 'תפריט' })).toBeVisible();
});

test('desktop: no bottom nav; "+" next to the workspace heading → "בורד חדש" opens the new-board dialog', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await expect(page.getByTestId('bottom-nav')).toHaveCount(0);

  // Fix: the "+" opens the "add new" menu; its first item is "בורד חדש".
  await openNewBoard(page);
  const dialog = page.getByRole('dialog', { name: 'בורד חדש', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('new-board-kind-main').getByRole('radio')).toBeChecked();
  await dialog.getByTestId('new-board-kind-private').click();
  await expect(dialog.getByTestId('new-board-kind-private').getByRole('radio')).toBeChecked();
  // Cancel closes without creating.
  await dialog.getByTestId('new-board-cancel').click();
  await expect(dialog).toBeHidden();

  await openNewBoard(page);
  const name = `דיאלוג ${Date.now().toString(36)}`;
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByTestId('new-board-kind-private').click();
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  // The phone screens are plain routes on desktop too.
  await page.goto('/a/demo/boards');
  await expect(page.getByTestId('boards-page')).toBeVisible();
  await page.goto('/a/demo/me');
  await expect(page.getByTestId('me-page')).toBeVisible();
});
