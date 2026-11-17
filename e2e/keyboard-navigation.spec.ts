// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Accessibility stage 2 (Israeli Standard 5568 / WCAG 2.1 AA): keyboard and screen-reader basics
 * "skip to the content" first in the tab order (2.4.1), a tab title per screen (2.4.2), and panels opened from the
 * keyboard that close with Esc and give the focus back to the control that opened them (2.4.3).
 */
const boardWithItem = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async (method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as Record<string, unknown>;
  const ws = ((await api('get', '/workspaces')).data as { id: string }[])[0]!;
  const name = `מקלדת ${Math.random().toString(36).slice(2, 7)}`;
  const board = await api('post', '/boards', { name, workspace_id: ws.id });
  const item = await api('post', `/boards/${board.id as string}/items`, { name: 'Alpha' });
  return { name, boardId: board.id as string, itemId: item.id as string };
};

test('skip to the content: the first Tab stop, it moves the focus to the main area', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/my-work');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Tab');
  const skip = page.getByTestId('skip-to-content');
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await expect(skip).toHaveText('דילוג לתוכן הראשי');
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
});

test('every screen has its own tab title: the board, the open item, the profile', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { name, boardId, itemId } = await boardWithItem(page);
  await page.goto(`/a/demo/b/${boardId}`);
  await expect(page).toHaveTitle(new RegExp(`^${name} · `));
  await page.goto(`/a/demo/b/${boardId}/i/${itemId}`);
  await expect(page).toHaveTitle(/^Alpha · /);
  await page.goto('/a/demo/profile');
  await expect(page).toHaveTitle(/^הפרופיל שלי · /);
});

test('keyboard: the filter panel opens with Enter, closes with Esc, and the focus comes back', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { boardId } = await boardWithItem(page);
  await page.goto(`/a/demo/b/${boardId}`);
  const trigger = page.getByTestId('toolbar-filter');
  await trigger.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByTestId('filter-panel');
  await expect(panel).toBeVisible();
  // The focus moved into the panel.
  await expect
    .poll(() => panel.evaluate((el) => el.closest('[data-testid="popover"]')!.contains(document.activeElement)))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(trigger).toBeFocused();
});
