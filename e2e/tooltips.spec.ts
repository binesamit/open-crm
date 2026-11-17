// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Owner fix (fix6): every hover explanation is the system tooltip, never the browser's native `title` bubble.
 * The `title` moves to `data-tip` on the first hover; icon buttons keep their accessible name.
 */
test('hovering a titled control shows the system tooltip and drops the native title', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const tip = page.getByTestId('system-tooltip');

  // The sidebar collapse button: an icon button with a title.
  const collapse = page.getByTestId('sidebar-collapse');
  const label = (await collapse.getAttribute('title'))!;
  expect(label).toBeTruthy();
  await collapse.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText(label);
  await expect(tip).toHaveAttribute('role', 'tooltip');
  await expect(collapse).not.toHaveAttribute('title');
  await expect(collapse).toHaveAttribute('data-tip', label);
  await expect(collapse).toHaveAccessibleName(label);
  await expect(collapse).toHaveAttribute('aria-describedby', /system-tooltip/);

  // On top of the page and above the button (it fits there).
  const box = (await tip.boundingBox())!;
  const anchor = (await collapse.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(anchor.y + 1);

  // Leaving hides it; Esc hides it too.
  await page.mouse.move(2, 400);
  await expect(tip).toBeHidden();
  await expect(collapse).not.toHaveAttribute('aria-describedby', /system-tooltip/);
  await collapse.hover();
  await expect(tip).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();
});

test('the board toolbar and the footer battery use the system tooltip', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`טולטיפ ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('פריט');
  await add.press('Enter');
  await expect(page.locator('[data-testid="item-row"][data-item-name="פריט"]')).toBeVisible();
  const tip = page.getByTestId('system-tooltip');

  // A toolbar icon button.
  const more = page.getByTestId('board-more');
  await more.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toHaveText('עוד פעולות');
  await expect(more).not.toHaveAttribute('title');
  await expect(more).toHaveAccessibleName('עוד פעולות');

  // A status battery segment in the section footer.
  const boardId = /\/b\/([^/?]+)/.exec(page.url())![1]!;
  const accounts = (await (await page.request.get('/api/v1/me/accounts')).json()) as {
    data: { id: string; slug: string }[];
  };
  const headers = { 'x-account-id': accounts.data.find((a) => a.slug === 'demo')!.id };
  const res = await page.request.post(`/api/v1/boards/${boardId}/columns`, {
    headers,
    data: { title: 'סטטוס', type: 'status' },
  });
  expect(res.ok()).toBe(true);
  await page.reload();
  const segment = page.getByTestId('summary-row').first().locator('[role="img"] > div').first();
  await segment.hover();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('1 (100%)');
  await expect(segment).not.toHaveAttribute('title');
});
