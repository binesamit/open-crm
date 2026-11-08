// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/** M1.1 #7 + #14: rich updates (toolbar, checklist, bold, autolink, edit) and emoji reactions. */
test('rich update, edit and reactions', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.locator('aside a', { hasText: 'לידים' }).first().click();
  const name = `עשיר ${Date.now().toString(36)}`;
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(name);
  await add.press('Enter');
  const row = page.locator('div.grid', { hasText: name }).first();
  await row.hover();
  await row.getByRole('link', { name: 'פתיחה' }).click();
  const dialog = page.getByRole('dialog');

  const box = dialog.getByLabel(/כתבו עדכון/);
  await box.click();
  await page.keyboard.type('משימות להיום');
  await page.keyboard.press('Enter');
  // N18: the checklist moved into the toolbar's "more" menu.
  await dialog.getByTestId('rich-more').first().click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'רשימת משימות' }).click();
  // Typed the moment the menu closes, the first letters could land outside the new item: wait until the menu is
  // gone and the editor has its focus back.
  await expect(box.locator('li[data-type="taskItem"]')).toHaveCount(1);
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(box).toBeFocused();
  await page.keyboard.type('לבדוק חוזה');
  await page.keyboard.press('Enter');
  await page.keyboard.type('לשלוח הצעה');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter'); // leaves the list
  await dialog.getByRole('button', { name: 'מודגש' }).click();
  await page.keyboard.type('חשוב');
  await dialog.getByRole('button', { name: 'מודגש' }).click();
  await page.keyboard.type(' <script>x</script> https://example.com ');
  await dialog.getByRole('button', { name: 'עדכון', exact: true }).click();

  const card = dialog.locator('article').first();
  const body = card.locator('.update-body');
  await expect(body.locator('li[data-type="taskItem"]')).toHaveCount(2);
  await expect(body.locator('strong')).toHaveText('חשוב');
  await expect(body.locator('a[href="https://example.com"]')).toBeVisible();
  await expect(body).toContainText('<script>x</script>');
  await expect(body.locator('script')).toHaveCount(0);
  await expect(box).toHaveText(''); // the composer cleared

  // Edit my update: the editor reopens with its content.
  await card.getByTestId('update-entry').first().getByRole('button', { name: 'פעולות לעדכון' }).first().click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'עריכה' }).click();
  const editor = card.getByLabel(/כתבו עדכון/);
  await expect(editor.locator('li')).toHaveCount(2);
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('גרסה מעודכנת');
  await card.getByRole('button', { name: 'שמירה' }).click();
  await expect(body).toHaveText('גרסה מעודכנת');
  await expect(card).toContainText('נערך');

  // Reactions: add ❤️ and 🎉, then take ❤️ back.
  for (const r of ['לב', 'חגיגה']) {
    await card.getByRole('button', { name: 'הוספת אימוג׳י' }).first().click();
    await page.getByRole('menuitemcheckbox', { name: r }).click();
  }
  await expect(card.getByRole('button', { name: '❤️ (1)' })).toHaveAttribute('aria-pressed', 'true');
  await expect(card.getByRole('button', { name: '🎉 (1)' })).toBeVisible();
  await card.getByRole('button', { name: '❤️ (1)' }).click();
  await expect(card.getByRole('button', { name: /❤️/ })).toHaveCount(0);

  await page.reload();
  // After a reload the dev server compiles the card again: allow more than the default 5s.
  await expect(page.getByRole('dialog').locator('article').first().locator('.update-body')).toHaveText('גרסה מעודכנת', {
    timeout: 15_000,
  });
});
