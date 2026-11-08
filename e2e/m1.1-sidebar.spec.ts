// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/** M1.1 #12 + known item 1: manage workspaces, folders and boards from the sidebar (14 §6–8). */
const answerPrompt = async (page: Page, value: string) => {
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill(value);
  await dialog.getByRole('button', { name: 'יצירה' }).click();
  await expect(dialog).toBeHidden();
};
const confirm = async (page: Page) => {
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(page.getByRole('alertdialog')).toBeHidden();
};
const menuOf = async (row: Locator, name: string) => {
  await row.hover();
  await row.getByRole('button', { name: `פעולות ל${name}` }).click();
};
const choose = (page: Page, item: string | RegExp) => {
  const menu = page.getByRole('menu');
  return menu
    .getByRole('menuitem', { name: item })
    .or(menu.getByRole('menuitemradio', { name: item }))
    .click();
};

test('workspaces, folders and boards from the sidebar', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const stamp = Date.now().toString(36);
  const sidebar = page.locator('aside').first();

  // A fresh workspace keeps this test out of the real one.
  const ws = `סביבת בדיקה ${stamp}`;
  await sidebar.getByRole('button', { name: 'החלפת מרחב עבודה' }).click();
  await choose(page, '+ מרחב עבודה חדש');
  await answerPrompt(page, ws);
  await expect(sidebar.getByRole('button', { name: 'החלפת מרחב עבודה' })).toContainText(ws);

  // Folder and sub-folder from the menus.
  const wsHeader = sidebar.getByRole('button', { name: 'החלפת מרחב עבודה' }).locator('..');
  await menuOf(wsHeader, ws);
  await choose(page, 'תיקייה חדשה');
  await answerPrompt(page, 'לקוחות');
  const folder = sidebar.getByTestId('folder-row').filter({ hasText: 'לקוחות' });
  await expect(folder).toBeVisible();
  await menuOf(folder, 'לקוחות');
  await choose(page, 'תת-תיקייה חדשה');
  await answerPrompt(page, 'ארכיון');
  const sub = sidebar.getByTestId('folder-row').filter({ hasText: 'ארכיון' });
  await expect(sub).toBeVisible();

  // A board created "here" lands in the folder.
  await menuOf(folder, 'לקוחות');
  // Anchored: "בורד חדש כאן" is also inside "דשבורד חדש כאן".
  await choose(page, /^בורד חדש כאן$/);
  await page.getByLabel('שם הבורד').fill('לקוחות פעילים');
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('לקוחות פעילים');
  const inFolder = (f: Locator) => f.locator('xpath=..').getByTestId('board-row');
  await expect(inFolder(folder).filter({ hasText: 'לקוחות פעילים' })).toBeVisible();

  // Rename in place.
  const board = sidebar.getByTestId('board-row').filter({ hasText: 'לקוחות פעילים' });
  await menuOf(board, 'לקוחות פעילים');
  await choose(page, 'שינוי שם');
  await sidebar.getByRole('textbox', { name: 'שינוי שם' }).fill('לקוחות VIP');
  await sidebar.getByRole('textbox', { name: 'שינוי שם' }).press('Enter');
  const vip = sidebar.getByTestId('board-row').filter({ hasText: 'לקוחות VIP' });
  await expect(vip).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('לקוחות VIP');

  // Move to the sub-folder through the submenu, then drag it onto the root zone.
  await menuOf(vip, 'לקוחות VIP');
  await choose(page, 'העברה ל…');
  await choose(page, 'לקוחות / ארכיון');
  await expect(inFolder(sub).filter({ hasText: 'לקוחות VIP' })).toBeVisible();

  // Grab the row by its name (the inline-end buttons — star, ⋯ — don't start a drag).
  const box = (await vip.boundingBox())!;
  const grabX = box.x + box.width - 50;
  await page.mouse.move(grabX, box.y + box.height / 2);
  await page.mouse.down();
  // Past the drag threshold (5px) whatever the row height.
  await page.mouse.move(grabX, box.y + box.height / 2 + 12, { steps: 5 });
  const zone = sidebar.getByText('שחררו כאן כדי להוציא מתיקייה');
  const z = (await zone.boundingBox())!;
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(inFolder(folder).filter({ hasText: 'לקוחות VIP' })).toHaveCount(0);
  await expect(vip).toBeVisible();

  // Back into the folder by drag, then delete the folder: the board survives at the root.
  const v2 = (await vip.boundingBox())!;
  const f = (await folder.boundingBox())!;
  await page.mouse.move(v2.x + v2.width - 50, v2.y + v2.height / 2);
  await page.mouse.down();
  await page.mouse.move(v2.x + v2.width - 50, v2.y - 10, { steps: 5 });
  await page.mouse.move(f.x + f.width / 2, f.y + f.height / 2, { steps: 10 });
  await page.mouse.up();
  await expect(inFolder(folder).filter({ hasText: 'לקוחות VIP' })).toBeVisible();

  await folder.click({ button: 'right' });
  await choose(page, 'מחיקה');
  await confirm(page);
  await expect(sidebar.getByTestId('folder-row')).toHaveCount(0);
  await expect(vip).toBeVisible();

  // An empty workspace can be deleted; with a board it can't.
  await menuOf(wsHeader, ws);
  await choose(page, 'מחיקת מרחב העבודה');
  await confirm(page);
  await expect(sidebar.getByRole('alert')).toContainText('יש עדיין בורדים');
  await menuOf(vip, 'לקוחות VIP');
  await choose(page, 'מחיקה');
  await confirm(page);
  await expect(vip).toHaveCount(0);
  await menuOf(wsHeader, ws);
  await choose(page, 'מחיקת מרחב העבודה');
  await confirm(page);
  await expect(sidebar.getByRole('button', { name: 'החלפת מרחב עבודה' })).not.toContainText(ws);
});
