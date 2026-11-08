// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M5 (D19): tags (account-wide, typed with Enter) and vote (my 👍, counted) as real column types. */
test('tag items and vote on them', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`תגיות ${run}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  for (const type of ['תגיות', 'הצבעה']) {
    await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
    await page.getByRole('button', { name: type, exact: true }).click();
  }
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('רעיון');
  await add.press('Enter');
  const cell = (type: string) =>
    page.locator('div.grid', { hasText: 'רעיון' }).first().locator(`[data-column-type="${type}"]`);

  // A new tag by typing + Enter; it shows as a #chip.
  const tag = `tg${run}`;
  await cell('tags').click();
  await page.getByTestId('tags-input').fill(`#${tag}`);
  await page.getByTestId('tags-input').press('Enter');
  await expect(cell('tags').getByTestId('cell-value')).toHaveText(`#${tag}`);
  await page.keyboard.press('Escape');

  // My vote: 0 → 1 → 0.
  const vote = cell('vote').getByTestId('vote-button');
  await expect(vote).toHaveText(/0/);
  await vote.click();
  await expect(vote).toHaveAttribute('aria-pressed', 'true');
  await expect(vote).toHaveText(/1/);
  await vote.click();
  await expect(vote).toHaveAttribute('aria-pressed', 'false');
  await expect(vote).toHaveText(/0/);
});
