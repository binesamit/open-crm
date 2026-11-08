// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** View tabs: my own order by drag and drop; pinned tabs always first, each kind moves only among its own. */
const tabs = (page: Page) => page.getByTestId('view-tab');
const order = (page: Page) => tabs(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-view-name')));
const pinned = (page: Page) =>
  tabs(page).evaluateAll((els) =>
    els.filter((e) => e.hasAttribute('data-pinned')).map((e) => e.getAttribute('data-view-name')),
  );
const tab = (page: Page, name: string) => tabs(page).filter({ hasText: name });

const drag = async (page: Page, from: Locator, to: Locator) => {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(150);
};

const pin = async (page: Page, name: string) => {
  await tab(page, name).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /הצמדה לראש|ביטול הצמדה/ }).click();
};

test('reorder view tabs; pinned tabs stay first', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`טאבים ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const name of ['A', 'B', 'C']) {
    await page.getByTestId('view-add').click();
    await page.getByRole('menuitem', { name: /טבלה/ }).click();
    await page.getByRole('dialog').getByRole('textbox').fill(name);
    await page.getByRole('dialog').getByRole('button', { name: 'אישור' }).click();
    await expect(tab(page, name)).toBeVisible();
  }
  await expect.poll(() => order(page)).toEqual(['טבלה', 'A', 'B', 'C']);

  // Pin C: it jumps to the front.
  await pin(page, 'C');
  await expect.poll(() => order(page)).toEqual(['C', 'טבלה', 'A', 'B']);
  await expect.poll(() => pinned(page)).toEqual(['C']);

  // An unpinned tab dropped on a pinned one stops right after the pinned ones.
  await drag(page, tab(page, 'B'), tab(page, 'C'));
  await expect.poll(() => order(page)).toEqual(['C', 'B', 'טבלה', 'A']);

  // Pin A (it becomes the last pinned), then reorder the pinned ones.
  await pin(page, 'A');
  await expect.poll(() => order(page)).toEqual(['C', 'A', 'B', 'טבלה']);
  await drag(page, tab(page, 'A'), tab(page, 'C'));
  await expect.poll(() => order(page)).toEqual(['A', 'C', 'B', 'טבלה']);

  // A pinned tab dropped among the others stays the last pinned one.
  await drag(page, tab(page, 'A'), tab(page, 'טבלה'));
  await expect.poll(() => order(page)).toEqual(['C', 'A', 'B', 'טבלה']);

  // Unpin C: it becomes the first unpinned tab. All of it survives a reload.
  await pin(page, 'C');
  await expect.poll(() => order(page)).toEqual(['A', 'C', 'B', 'טבלה']);
  await expect.poll(() => pinned(page)).toEqual(['A']);
  await page.reload();
  await expect.poll(() => order(page)).toEqual(['A', 'C', 'B', 'טבלה']);
  await expect.poll(() => pinned(page)).toEqual(['A']);

  // A click (not a drag) still opens the tab.
  await tab(page, 'B').click();
  await expect(tab(page, 'B')).toHaveAttribute('aria-selected', 'true');
});
