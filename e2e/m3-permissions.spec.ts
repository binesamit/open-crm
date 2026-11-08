// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/** M3 step 6 (05 §4–7): teams in Administration, a team in a people cell, the board permissions dialog. */
test('create a team, assign it, and set board permissions', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const suffix = Date.now().toString(36);

  // A team, with the owner in it (Administration → teams).
  await page.goto('/a/demo/admin/teams');
  await page.getByTestId('team-new').click();
  await page.getByRole('dialog').getByRole('textbox').fill(`צוות ${suffix}`);
  await page.getByRole('dialog').getByRole('button', { name: 'יצירה' }).click();
  const team = page.locator(`[data-testid="team-row"][data-name="צוות ${suffix}"]`);
  await expect(team).toContainText('0 חברים');
  await team.hover();
  await team.getByRole('button', { name: /^פעולות לצוות/ }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'חברי הצוות' }).click();
  await page.getByTestId('team-members').locator('input[type="checkbox"]').first().check();
  await page.getByTestId('team-members-save').click();
  await expect(team).toContainText('1 חברים');

  // A board with a people column; the team goes into a cell.
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`הרשאות ${suffix}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`הרשאות ${suffix}`);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'אנשים', exact: true }).click();
  const add = page.getByPlaceholder(/\+ הוספת פריט/).first();
  await add.fill('Shared task');
  await add.press('Enter');
  const row = page.locator('[data-testid="item-row"][data-item-name="Shared task"]');
  await row.locator('[data-column-type="people"]').click();
  const teamOption = page
    .getByTestId('people-team')
    .filter({ hasText: `צוות ${suffix}` })
    .locator('input');
  await teamOption.click();
  await expect(teamOption).toBeChecked(); // after the server stored it
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(row.locator('[data-column-type="people"]').getByRole('img').first()).toHaveAttribute(
    'aria-label',
    `צוות ${suffix}`,
  );

  // r15board: the toolbar's "Person" button is gone — people (and teams) are filtered in the filter panel.

  // Permissions: content only, items by assignment, an owner-only column.
  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'הרשאות', exact: true }).click();
  const dialog = page.getByTestId('permissions-dialog');
  await dialog.getByTestId('perm-set-edit_content').click();
  await expect(dialog.getByTestId('perm-set-edit_content').getByRole('radio')).toBeChecked();
  const onlyMine = dialog.getByTestId('perm-view-items').getByRole('radio', { name: 'רק מה שיצרו או הוקצה להם' });
  await onlyMine.click();
  await expect(onlyMine).toHaveAttribute('aria-checked', 'true');
  // Only restricted columns are listed (N15): "+ הגבלה" → a column → the kind.
  await expect(dialog.locator('[data-testid="perm-column"]')).toHaveCount(0);
  await dialog.getByTestId('perm-add-restriction').click();
  await page.getByRole('menu').getByRole('menuitem').first().click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'עריכה מוגבלת' }).click();
  const column = dialog.locator('[data-testid="perm-column"]').first();
  await expect(column).toContainText('עריכה מוגבלת');
  // Owners only, until a team is allowed too.
  const allowed = column.getByTestId('perm-column-allowed');
  await expect(allowed).toHaveText(/רק בעלים/);
  await allowed.click();
  await page
    .getByRole('menu')
    .getByRole('menuitemradio', { name: `צוות ${suffix}` })
    .click();
  await expect(allowed).toContainText(`צוות ${suffix}`);
  await expect(dialog.locator('[data-testid="perm-member"]')).toHaveCount(1);

  // The team subscribes, with an explicit role below the set's (content editors → view and comment).
  await dialog.getByTestId('perm-add-team').click();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: `צוות ${suffix}` })
    .click();
  const teamRow = dialog.locator(`[data-testid="perm-team"][data-name="צוות ${suffix}"]`);
  await expect(teamRow).toContainText('מנוי — לפי ההגדרה');
  await teamRow.getByRole('button').first().click();
  const levels = page.getByRole('menu').getByRole('menuitemradio');
  await expect(levels.filter({ hasText: 'עורך הכול' })).toHaveCount(0); // never above the set
  await levels.filter({ hasText: 'צופה ומגיב' }).click();
  await expect(teamRow).toContainText('מנוי — צופה ומגיב');
  await page.keyboard.press('Escape');

  await page.reload();
  await page.getByTestId('board-more').click();
  await page.getByRole('menuitem', { name: 'הרשאות', exact: true }).click();
  await expect(page.getByTestId('perm-set-edit_content').getByRole('radio')).toBeChecked();
  await expect(page.getByTestId('perm-view-items')).toContainText('רק מה שיצרו');
  await expect(page.locator(`[data-testid="perm-team"][data-name="צוות ${suffix}"]`)).toContainText('צופה ומגיב');
});
