// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M1.1 #16–17: column menu (add right/left, rename), drag to reorder, drag the edge to resize. */
const titles = async (page: Page) =>
  (await page.getByTestId('header-row').first().locator('[data-header]').allTextContents()).map((x) =>
    x.replace('⋯', '').trim(),
  );
const header = (page: Page, title: string) =>
  page.getByTestId('header-row').first().locator('[data-header]').filter({ hasText: title });
const openMenu = async (page: Page, title: string) => {
  await header(page, title).hover();
  await header(page, title)
    .getByRole('button', { name: `פעולות לעמודה ${title}` })
    .click();
};
const choose = (page: Page, name: string) => page.getByRole('menu').getByRole('menuitem', { name }).click();

test('add, reorder, resize and rename columns', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`עמודות ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of ['טקסט', 'מספרים']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  await expect.poll(() => titles(page)).toEqual(['טקסט', 'מספרים']);

  // Add right of "מספרים" (= before it in RTL) and left of "טקסט" (= after it).
  await openMenu(page, 'מספרים');
  await choose(page, 'הוספת עמודה מימין');
  await choose(page, 'תאריך');
  await expect.poll(() => titles(page)).toEqual(['טקסט', 'תאריך', 'מספרים']);
  await openMenu(page, 'טקסט');
  await choose(page, 'הוספת עמודה משמאל');
  await choose(page, 'סטטוס');
  await expect.poll(() => titles(page)).toEqual(['טקסט', 'סטטוס', 'תאריך', 'מספרים']);

  // Drag "מספרים" onto "טקסט": it becomes first.
  const from = (await header(page, 'מספרים').boundingBox())!;
  const to = (await header(page, 'טקסט').boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 40, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();
  await expect.poll(() => titles(page)).toEqual(['מספרים', 'טקסט', 'סטטוס', 'תאריך']);

  // Resize "טקסט": in RTL its edge is on the left, so dragging left widens it.
  const before = (await header(page, 'טקסט').boundingBox())!.width;
  const edge = (await header(page, 'טקסט').getByTestId('column-resize').boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 - 60, edge.y + edge.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await header(page, 'טקסט').boundingBox())!.width))
    .toBe(Math.round(before + 60));

  // Rename from the menu.
  await openMenu(page, 'תאריך');
  await choose(page, 'שינוי שם');
  const rename = page.getByTestId('header-row').first().locator('[data-header] input');
  await rename.fill('תאריך יעד');
  await rename.press('Enter');
  await expect.poll(() => titles(page)).toEqual(['מספרים', 'טקסט', 'סטטוס', 'תאריך יעד']);

  await page.reload();
  await expect.poll(() => titles(page)).toEqual(['מספרים', 'טקסט', 'סטטוס', 'תאריך יעד']);
  expect(Math.round((await header(page, 'טקסט').boundingBox())!.width)).toBe(Math.round(before + 60));
});
