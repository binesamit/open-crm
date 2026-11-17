// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Round 15 — automations & activity (prod fixes,): a custom automation starts
 * with no action and every action can be removed; the recipe catalogue reads as sentences with search and categories;
 * the board log shows before → after and filters on the server.
 */
test('builder: starts empty, every action removable, save asks for an action', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`r15 auto ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();

  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  await page.getByTestId('auto-custom').click();
  const builder = page.getByTestId('automation-builder');
  await expect(builder).toBeVisible();
  // Nothing pre-filled under "then".
  await expect(builder.getByTestId('auto-action')).toHaveCount(0);
  await expect(builder.getByTestId('auto-no-actions')).toBeVisible();

  // Saving without an action says so (no request, no server error).
  await page.getByTestId('auto-save').click();
  await expect(builder.getByTestId('auto-no-actions')).toHaveClass(/text-danger-fg/);
  await expect(builder).toBeVisible();

  // Two actions; the first one goes away with its own button.
  for (let i = 0; i < 2; i++) {
    await builder.getByTestId('auto-add-action').click();
    await page.getByRole('menu').getByRole('menuitem').first().click();
  }
  await expect(builder.getByTestId('auto-action')).toHaveCount(2);
  await builder.getByTestId('auto-action').first().getByTestId('auto-remove-action').click();
  await expect(builder.getByTestId('auto-action')).toHaveCount(1);
  // …and the last one too.
  await builder.getByTestId('auto-action').first().getByTestId('auto-remove-action').click();
  await expect(builder.getByTestId('auto-action')).toHaveCount(0);
  await expect(builder.getByTestId('auto-no-actions')).toBeVisible();
});

test('recipe catalogue: sentences with highlighted blanks, categories and search', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`r15 tpl ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();

  const all = page.getByTestId('automation-template');
  const total = await all.count();
  expect(total).toBeGreaterThan(10);
  // Each card reads "…, אז …" with its blanks marked.
  const card = page.locator('[data-testid="automation-template"][data-id="status_notify"]');
  await expect(card.getByTestId('automation-template-sentence')).toContainText('אז');
  await expect(card.locator('[data-slot]').first()).toBeVisible();

  // A category narrows the list to its section.
  await page.getByTestId('auto-template-cat-dates').click();
  await expect(page.getByTestId('auto-template-section')).toHaveCount(1);
  await expect(page.getByTestId('auto-template-section')).toHaveAttribute('data-category', 'dates');
  await page.getByTestId('auto-template-cat-all').click();
  await expect(all).toHaveCount(total);

  // Search over the sentences.
  await page.getByTestId('auto-template-search').fill('webhook');
  await expect(all.first()).toBeVisible();
  expect(await all.count()).toBeLessThan(total);
  await page.getByTestId('auto-template-search').fill('zzzz-nothing');
  await expect(page.getByTestId('auto-templates-empty')).toBeVisible();
  await page.getByTestId('auto-template-search').fill('');

  // Choosing one opens the builder with it.
  await card.click();
  await expect(page.getByTestId('automation-builder')).toBeVisible();
  await expect(page.locator('[data-testid="auto-action"][data-type="notify"]')).toHaveCount(1);
});

test('board log: before → after, and server-side filters', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`r15 log ${Date.now().toString(36)}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['Alpha', 'Beta']) {
    await add.fill(name);
    await add.press('Enter');
  }
  const row = (name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
  await expect(row('Beta')).toBeVisible();
  // Rename Alpha → Alpha 2 (a before → after of names).
  await expect(async () => {
    await row('Alpha').getByText('Alpha', { exact: true }).click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: /^שינוי שם/ })
    .click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Alpha 2');
  await page.keyboard.press('Enter');
  await expect(row('Alpha 2')).toBeVisible();

  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'יומן פעילות' }).click();
  const log = page.getByTestId('board-activity');
  const renamed = log.locator('[data-testid="activity-entry"][data-type="item.renamed"]').first();
  await expect(renamed.getByTestId('activity-before')).toHaveText('Alpha');
  await expect(renamed.getByTestId('activity-after')).toHaveText('Alpha 2');
  await expect(renamed.getByTestId('activity-before')).toHaveClass(/line-through/);

  // By type: only renames.
  await log.getByTestId('activity-filter-type').click();
  await page.getByTestId('activity-type-item.renamed').click();
  await expect(log.getByTestId('activity-entry')).toHaveCount(1);
  await log.getByTestId('activity-filter-clear').click();
  await expect(log.locator('[data-testid="activity-entry"][data-type="item.created"]')).toHaveCount(2);

  // Free text: the item's name.
  await log.getByTestId('activity-filter-q').fill('Beta');
  await expect(log.getByTestId('activity-entry')).toHaveCount(1);
  await log.getByTestId('activity-filter-q').fill('nothing-like-this');
  await expect(log.getByTestId('activity-filter-empty')).toBeVisible();
  await log.getByTestId('activity-filter-clear').click();

  // By person: automations / the system did nothing here.
  await log.getByTestId('activity-filter-actor').click();
  await page.getByTestId('activity-filter-actor-system').click();
  await expect(log.getByTestId('activity-filter-empty')).toBeVisible();
  await log.getByTestId('activity-filter-clear').click();

  // Dates: our own calendar (never a native picker) opens.
  await log.getByTestId('activity-filter-dates').click();
  await expect(page.locator('input[type="date"]')).toHaveCount(0);
});
