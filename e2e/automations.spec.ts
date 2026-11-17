// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from './fixtures';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * M6 stage 5 — the automations screen: a template filled in the sentence builder, saved on, and run by the real
 * engine (the api's runner) when an item is created; then its history, a dry-run test, switching it off.
 */
test('create an automation from a template, watch it run, test it, switch it off', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`אוטו ${run}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'סטטוס', exact: true }).click();

  // Center → create → "when an item is created, set status".
  await page.getByTestId('board-automations').click();
  const dialog = page.getByTestId('automations-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('auto-tab-create').click();
  await page.locator('[data-testid="automation-template"][data-id="created_set_status"]').click();
  const builder = page.getByTestId('automation-builder');
  await expect(builder).toBeVisible();

  // Blanks: the column, then the label.
  await builder.locator('[data-slot="actions.0.column"]').click();
  await page.getByTestId('slot-option').filter({ hasText: 'סטטוס' }).first().click();
  await builder.locator('[data-slot="actions.0.label"]').click();
  const option = page.getByTestId('slot-option').filter({ hasText: /\S/ }).first();
  const label = (await option.getAttribute('data-value'))!;
  await option.click();
  await expect(builder.locator('[data-slot="actions.0.label"]')).toHaveText(label);
  await page.getByTestId('auto-title').fill(`סטטוס ${run}`);
  await page.getByTestId('auto-save').click();

  const row = page.locator('[data-testid="automation-row"]', { hasText: `סטטוס ${run}` });
  await expect(row).toBeVisible();
  await expect(row.getByTestId('automation-toggle')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('board-automations-count')).toHaveText('1');
  await page.getByRole('button', { name: 'סגירת החלון' }).last().click();

  // The engine runs it when an item is created.
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill('משימה ראשונה');
  await add.press('Enter');
  const status = page
    .locator('[data-testid="item-row"][data-item-name="משימה ראשונה"]')
    .locator('[data-column-type="status"]');
  await expect(status).toHaveText(label, { timeout: 20_000 });

  // History shows the run; a dry run on the item previews the action without writing.
  await page.getByTestId('board-automations').click();
  await row.getByTestId('automation-history').click();
  await expect(page.locator('[data-testid="automation-run"][data-status="succeeded"]').first()).toBeVisible();
  await page.getByTestId('automation-runs').press('Escape');

  await row.getByTestId('automation-test').click();
  await page.getByTestId('auto-test-search').fill('משימה');
  await page.locator('[data-testid="auto-test-hit"][data-name="משימה ראשונה"]').click();
  await page.getByTestId('auto-test-preview').click();
  await expect(page.getByTestId('auto-test-conditions')).toHaveAttribute('data-matched', 'true');
  await expect(page.locator('[data-testid="auto-test-rendered"][data-field="label"]')).toHaveText(label);
  await page.getByTestId('automation-test-dialog').press('Escape');

  // Off, then delete (keeps the local account clean).
  await row.getByTestId('automation-toggle').click();
  await expect(row.getByTestId('automation-toggle')).toHaveAttribute('aria-checked', 'false');
  await row.getByTestId('automation-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row).toHaveCount(0);
});

test('the builder shows what the board cannot satisfy', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`אוטו ב ${run}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  await page.locator('[data-testid="automation-template"][data-id="status_move_group"]').click();
  // No status column on this board: saving outlines the blanks it could not fill.
  await page.getByTestId('auto-save').click();
  await expect(page.getByTestId('auto-issues')).toBeVisible();
  await expect(page.locator('[data-slot="trigger.column"]')).toHaveClass(/ring-2/);
});

test('map columns of a "create an item" action', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`מיפוי ${run}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'סטטוס', exact: true }).click();

  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-create').click();
  await page.locator('[data-testid="automation-template"][data-id="status_create_item"]').click();
  const builder = page.getByTestId('automation-builder');
  await builder.locator('[data-slot="trigger.column"]').click();
  await page.getByTestId('slot-option').filter({ hasText: 'סטטוס' }).first().click();
  await builder.locator('[data-slot="trigger.labels"]').click();
  await page.getByTestId('slot-labels').getByRole('checkbox').nth(1).click();
  await page.keyboard.press('Escape');

  // Target: this board; map its status from ours, by name.
  await builder.locator('[data-slot="actions.0.board"]').click();
  await page.getByTestId('slot-option').filter({ hasText: 'הבורד הזה' }).click();
  await builder.getByTestId('auto-mapping').click();
  const editor = page.getByTestId('mapping-editor');
  await expect(editor).toBeVisible();
  await editor.getByTestId('mapping-by-name').click();
  await expect(
    editor.locator('[data-testid="mapping-target"]').filter({ hasText: 'סטטוס' }).getByTestId('mapping-source'),
  ).toContainText('סטטוס');
  await page.keyboard.press('Escape');
  await expect(builder.getByTestId('auto-mapping')).toContainText(/\((2|3)\)/); // name + status (+ the name target)
  await page.getByTestId('auto-title').fill(`מיפוי ${run}`);
  await page.getByTestId('auto-save-inactive').click();
  await expect(page.locator('[data-testid="automation-row"]', { hasText: `מיפוי ${run}` })).toBeVisible();
});

test('the account-wide automations page: usage and every board automations', async ({ page, scratch, ownerApi }) => {
  // Its own board and automation: a database without the local demo's seeded leads board has nothing
  // to list otherwise.
  const board = await scratch.board('autoall');
  await ownerApi.call('post', `/boards/${board.id}/automations`, {
    title: `autoall ${board.name}`,
    recipe: {
      trigger: { type: 'item_created' },
      actions: [{ type: 'notify', to: '@board_owners', message: '{item.name}' }],
    },
  });
  forbidNativeDialogs(page);
  await signIn(page);
  await page.getByTestId('nav-automations').click();
  const pageEl = page.getByTestId('account-automations');
  await expect(pageEl).toBeVisible();
  await expect(page.getByTestId('usage-tile')).toHaveCount(5);
  await expect(page.getByTestId('usage-chart')).toBeVisible();
  // The board's automation is listed, with its switch.
  await expect(page.getByTestId('autoall-board').filter({ hasText: board.name })).toBeVisible();
  const row = page.locator(`[data-testid="autoall-row"][data-title="autoall ${board.name}"]`);
  await expect(row.getByTestId('autoall-toggle')).toHaveAttribute('aria-checked', /true|false/);
});
