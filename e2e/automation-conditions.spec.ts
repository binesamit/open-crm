// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Round 16 — "and" / "or" and groups in automation conditions: the builder's "only if" is the board
 * filter's group editor. Build A and (B or C), read it as a sentence, save, reopen unchanged, and test it on items.
 */
const pickColumn = async (page: Page, rule: Locator, title: string) => {
  await rule.getByTestId('rule-column').click();
  await page.getByRole('menuitemradio', { name: title, exact: true }).click();
};
const nameContains = async (page: Page, rule: Locator, text: string) => {
  await pickColumn(page, rule, 'שם');
  await rule.getByTestId('rule-operator').click();
  await page.getByRole('menuitemradio', { name: 'מכיל', exact: true }).click();
  await rule.getByTestId('rule-text').fill(text);
};

test('automation conditions: A and (B or C) — build, save, reopen, test', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`r16 andor ${run}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'סטטוס', exact: true }).click();
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const name of ['Alpha', 'Beta']) {
    await add.fill(name);
    await add.press('Enter');
  }
  await expect(page.locator('[data-testid="item-row"][data-item-name="Beta"]')).toBeVisible();

  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  await page.locator('[data-testid="automation-template"][data-id="created_set_status"]').click();
  const builder = page.getByTestId('automation-builder');
  await builder.locator('[data-slot="actions.0.column"]').click();
  await page.getByTestId('slot-option').filter({ hasText: 'סטטוס' }).first().click();
  await builder.locator('[data-slot="actions.0.label"]').click();
  await page.getByTestId('slot-option').filter({ hasText: /\S/ }).first().click();

  // A: name contains "Alpha".
  await builder.getByTestId('auto-add-condition').click();
  const root = builder.getByTestId('filter-group-1');
  await nameContains(page, root.getByTestId('filter-rule').first(), 'Alpha');
  // (B or C): a nested group — an "or" inside an "and".
  await root.getByTestId('filter-add-group').last().click();
  const inner = builder.getByTestId('filter-group-2');
  await expect(inner).toBeVisible();
  await pickColumn(page, inner.getByTestId('filter-rule').first(), 'סטטוס'); // B: status is not empty
  await inner.getByTestId('filter-add-rule').click();
  await nameContains(page, inner.getByTestId('filter-rule').nth(1), 'lph'); // C
  await expect(inner.getByTestId('filter-rule')).toHaveCount(2);
  // An empty group is not saved: add one and leave it empty (its only rule removed).
  await root.getByTestId('filter-add-group').last().click();
  await expect(builder.getByTestId('filter-group-2')).toHaveCount(2);
  await builder.getByTestId('filter-group-2').nth(1).getByRole('button', { name: 'הסרת תנאי' }).click();

  // The sentence: "and" with the group in parentheses.
  const sentence = builder.getByTestId('auto-condition-text');
  await expect(sentence).toContainText('Alpha');
  await expect(sentence).toContainText('וגם (');
  await expect(sentence).toContainText(' או ');
  // The round-15 read-only notice is gone.
  await expect(builder.getByTestId('auto-advanced-conditions')).toHaveCount(0);

  await page.getByTestId('auto-title').fill(`andor ${run}`);
  await page.getByTestId('auto-save-inactive').click();
  const row = page.locator('[data-testid="automation-row"]', { hasText: `andor ${run}` });
  await expect(row).toBeVisible();

  // Reopen: the same tree, the empty group dropped.
  await row.getByTestId('automation-edit').click();
  await expect(builder.getByTestId('filter-group-2')).toHaveCount(1);
  await expect(builder.getByTestId('filter-group-1').getByTestId('filter-rule')).toHaveCount(3);
  await expect(builder.getByTestId('filter-group-2').getByTestId('filter-rule')).toHaveCount(2);
  await expect(builder.getByTestId('auto-condition-text')).toContainText('וגם (');
  await page.getByRole('button', { name: 'ביטול' }).click();

  // Test on an item that matches, then on one that fails A.
  await row.getByTestId('automation-test').click();
  await page.getByTestId('auto-test-search').fill('Alpha');
  await page.locator('[data-testid="auto-test-hit"][data-name="Alpha"]').click();
  await page.getByTestId('auto-test-preview').click();
  await expect(page.getByTestId('auto-test-conditions')).toHaveAttribute('data-matched', 'true');
  await expect(page.getByTestId('auto-test-condition-text')).toContainText('וגם (');

  await page.getByTestId('automation-test-dialog').getByRole('button', { name: 'החלפה', exact: true }).click();
  await page.getByTestId('auto-test-search').fill('Beta');
  await page.locator('[data-testid="auto-test-hit"][data-name="Beta"]').click();
  await page.getByTestId('auto-test-preview').click();
  await expect(page.getByTestId('auto-test-conditions')).toHaveAttribute('data-matched', 'false');
  await expect(page.getByTestId('auto-test-failed')).toHaveAttribute('data-part', '0');
  await expect(page.getByTestId('auto-test-failed')).toContainText('Alpha');
  await page.getByTestId('automation-test-dialog').press('Escape');

  // Clean up.
  await row.getByTestId('automation-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row).toHaveCount(0);
});
