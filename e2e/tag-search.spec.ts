// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Fix list 2 (account area): a tag search shows the tag's items; favourite boards on top of the sidebar;
 * the profile editor (title, phone); templates renamed, described, duplicated, edited through a hidden working board
 * and deleted.
 */
const uid = () => Date.now().toString(36);

const newBoard = async (page: Page, name: string) => {
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name, workspace_id: ws } })
  ).json()) as { id: string };
  return { headers, boardId: board.id };
};

test('searching a tag lists the items that carry it; a click opens the item', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const tag = `תג${id}`;
  const { headers, boardId } = await newBoard(page, `בורד תגיות ${id}`);
  const column = (await (
    await page.request.post(`/api/v1/boards/${boardId}/columns`, { headers, data: { title: 'תגיות', type: 'tags' } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(`/api/v1/boards/${boardId}/items`, { headers, data: { name: `משימה מתויגת ${id}` } })
  ).json()) as { id: string };
  await page.request.put(`/api/v1/items/${item.id}/cells/${column.id}`, { headers, data: { value: { tags: [tag] } } });

  await page.getByTestId('search-open').first().click();
  const palette = page.getByTestId('search-palette');
  await expect(palette).toBeVisible();
  await page.mouse.move(1, 1);
  const input = page.getByTestId('search-input');
  // A plain search by the tag's name finds the tagged item (its name does not hold the tag) and the tag.
  await input.fill(tag);
  const results = palette.getByTestId('search-result');
  const itemRow = results.filter({ hasText: `משימה מתויגת ${id}` });
  await expect(itemRow).toHaveAttribute('data-kind', 'item');
  await expect(itemRow).toContainText(`#${tag}`);
  // The tag row narrows to that tag's items.
  await results
    .filter({ hasText: `#${tag}` })
    .and(page.locator('[data-kind="tag"]'))
    .click();
  await expect(input).toHaveValue(`#${tag}`);
  await expect(palette.getByRole('heading', { name: `פריטים עם התגית #${tag}` })).toBeVisible();
  await palette
    .locator('[data-testid="search-result"][data-kind="item"]')
    .filter({ hasText: `${id}` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/b/${boardId}/i/${item.id}`));
});

test('a starred board shows under "מועדפים" at the top of the sidebar, and is removed from the ⋯ menu', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `מועדף ${uid()}`;
  const { boardId } = await newBoard(page, name);
  await page.reload();
  const row = page.getByTestId('board-row').filter({ hasText: name });
  await row.hover();
  await row.getByTestId('board-favorite-toggle').click();
  await expect(row.getByTestId('board-favorite-toggle')).toHaveAttribute('aria-pressed', 'true');

  const favorites = page.getByTestId('favorites-section');
  const fav = favorites.locator(`[data-testid="favorite-board-row"][data-name="${name}"]`);
  await expect(fav).toBeVisible();
  // The section is above the workspace tree.
  const favBox = (await favorites.boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  expect(favBox.y).toBeLessThan(rowBox.y);
  await fav.getByRole('link', { name }).click();
  await expect(page).toHaveURL(new RegExp(`/b/${boardId}`));

  // Kept on the server: still there after a reload.
  await page.reload();
  await expect(fav).toBeVisible();

  await row.hover();
  await row.getByRole('button', { name: /^פעולות ל/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'הסרה מהמועדפים' }).click();
  await expect(fav).toHaveCount(0);
});

test('my profile: job title and phone from the avatar menu, shown on the "אני" page', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  await page.getByTestId('profile-menu').first().click();
  await page.getByTestId('menu-my-profile').click();
  // fix5: "הפרופיל שלי" is a page with tabs; the details form is its first tab.
  const dialog = page.getByTestId('profile-form');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('profile-title').fill(`מנהל ${id}`);
  await dialog.getByTestId('profile-phone').fill('050-1234567');
  await dialog.getByTestId('profile-department').fill('מכירות');
  await dialog.getByTestId('profile-birthday').fill('17/05/1990');
  await page.getByTestId('profile-save').click();
  await expect(page.getByText('הפרופיל נשמר')).toBeVisible();

  await page.goto('/a/demo/me');
  await expect(page.getByTestId('me-title')).toContainText(`מנהל ${id}`);
  await expect(page.getByTestId('me-phone')).toContainText('050-1234567');
  await expect(page.getByTestId('me-birthday')).toContainText('17/05/1990');

  // Edited again from the page; an empty field is cleared.
  await page.getByTestId('me-profile-edit').click();
  await expect(dialog.getByTestId('profile-title')).toHaveValue(`מנהל ${id}`);
  await dialog.getByTestId('profile-birthday').fill('');
  await page.getByTestId('profile-save').click();
  await expect(page.getByText('הפרופיל נשמר').first()).toBeVisible();
  await page.goto('/a/demo/me');
  await expect(page.getByTestId('me-birthday')).toHaveCount(0);
});

test('templates: rename, describe, duplicate, edit through a working board, delete', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const { headers, boardId } = await newBoard(page, `מקור תבנית ${id}`);
  await page.request.post(`/api/v1/boards/${boardId}/save-as-template`, {
    headers,
    data: { name: `תבנית ${id}` },
  });
  await page.goto('/a/demo/admin/templates');
  const rowOf = (name: string) => page.locator(`[data-testid="template-row"][data-name="${name}"]`);
  const menu = async (name: string, item: string) => {
    await rowOf(name)
      .getByRole('button', { name: /^פעולות לתבנית/ })
      .click();
    await page.getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click();
  };

  // Rename.
  await menu(`תבנית ${id}`, 'שינוי שם');
  await page.getByRole('dialog').getByRole('textbox').fill(`שונתה ${id}`);
  await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
  const renamed = rowOf(`שונתה ${id}`);
  await expect(renamed).toBeVisible();

  // Describe.
  await menu(`שונתה ${id}`, 'עריכת תיאור');
  await page.getByTestId('template-description-input').fill('תבנית לבדיקה');
  await page.getByTestId('template-description-save').click();
  await expect(renamed.getByTestId('template-description')).toHaveText('תבנית לבדיקה');

  // Duplicate.
  await menu(`שונתה ${id}`, 'שכפול');
  const copy = rowOf(`שונתה ${id} (עותק)`);
  await expect(copy).toBeVisible();

  // Edit (fix3): a hidden working board from the template — not among the boards; its banner saves it back over
  // the template, removes the working board and returns to the templates.
  await menu(`שונתה ${id}`, 'עריכת התבנית');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`שונתה ${id} · עריכת תבנית`);
  const banner = page.getByTestId('template-edit-banner');
  await expect(banner).toContainText(`שונתה ${id}`);
  await expect(page.getByTestId('board-row').filter({ hasText: `שונתה ${id} · עריכת תבנית` })).toHaveCount(0);
  await banner.getByTestId('template-edit-save').click();
  await page.getByTestId('template-save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'נשמרו' })).toBeVisible();
  await expect(page).toHaveURL(/\/a\/demo\/admin\/templates$/);
  await expect(banner).toHaveCount(0);
  await expect(renamed.getByTestId('template-draft')).toHaveCount(0);

  // Delete both.
  for (const name of [`שונתה ${id}`, `שונתה ${id} (עותק)`]) {
    await menu(name, 'מחיקה');
    await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
    await expect(rowOf(name)).toHaveCount(0);
  }
});
