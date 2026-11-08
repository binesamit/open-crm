// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Owner fixes (fix4-board): an unsent update / reply is kept as a draft in the browser (12 hours) and restored
 * when the card opens again; a subitem's card shows its ancestors in the breadcrumb (each one opens); open subitem
 * lists are not kept across visits (entering a board shows them closed — also when a legacy value is stored).
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, items: string[]) => {
  const name = `תיקון4 ${Date.now().toString(36)}`;
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(name);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  const add = page.getByPlaceholder(/\+ הוספת/).first();
  for (const item of items) {
    await add.fill(item);
    await add.press('Enter');
    await expect(row(page, item)).toBeVisible();
  }
  return name;
};

const openCard = async (page: Page, itemName: string) => {
  const r = row(page, itemName);
  await r.hover();
  await r.getByRole('link', { name: 'פתיחה' }).click();
  const card = page.getByRole('dialog', { name: itemName });
  await expect(card).toBeVisible();
  return card;
};

const addSubitems = async (page: Page, parent: string, names: string[]) => {
  await row(page, parent).hover();
  await row(page, parent).getByTestId('subitems-toggle').click();
  const field = page.getByLabel('+ הוספת תת-פריט');
  for (const n of names) {
    await field.fill(n);
    await field.press('Enter');
    await expect(row(page, n)).toBeVisible();
  }
};

test('update drafts: kept when the card closes, restored, cleared by posting or "ניקוי"', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['טיוטות']);
  let card = await openCard(page, 'טיוטות');

  // Type and close: the card closes at once, the text is kept.
  await card.getByLabel(/כתבו עדכון/).click();
  await page.keyboard.type('חצי משפט שלא נשלח');
  await card.getByRole('button', { name: 'סגירה' }).last().click();
  await expect(card).toBeHidden();

  // Reopen (also after a reload): the draft is back, marked subtly.
  await page.reload();
  card = await openCard(page, 'טיוטות');
  await expect(card.getByLabel(/כתבו עדכון/)).toContainText('חצי משפט שלא נשלח');
  await expect(card.getByTestId('composer-draft')).toContainText('טיוטה שמורה');

  // "ניקוי" empties the box and forgets the draft.
  await card.getByTestId('composer-draft-clear').click();
  await expect(card.getByTestId('composer-draft')).toHaveCount(0);
  await expect(card.getByLabel(/כתבו עדכון/)).not.toContainText('חצי משפט');
  await card.getByRole('button', { name: 'סגירה' }).last().click();
  card = await openCard(page, 'טיוטות');
  await expect(card.getByLabel(/כתבו עדכון/)).not.toContainText('חצי משפט');

  // Posting clears the draft.
  await card.getByLabel(/כתבו עדכון/).click();
  await page.keyboard.type('עדכון שנשלח');
  await card.getByRole('button', { name: 'עדכון', exact: true }).click();
  await expect(card.getByTestId('update-entry').first()).toContainText('עדכון שנשלח');
  await card.getByRole('button', { name: 'סגירה' }).last().click();
  card = await openCard(page, 'טיוטות');
  await expect(card.getByLabel(/כתבו עדכון/)).not.toContainText('עדכון שנשלח');
  await expect(card.getByTestId('composer-draft')).toHaveCount(0);

  // A reply keeps its own draft (per update).
  await card.getByTestId('update-entry').first().getByRole('button', { name: 'תגובה', exact: true }).click();
  await card.getByLabel(/כתבו תגובה/).click();
  await page.keyboard.type('תגובה בהמתנה');
  await card.getByRole('button', { name: 'סגירה' }).last().click();
  card = await openCard(page, 'טיוטות');
  await expect(card.getByLabel(/כתבו עדכון/)).not.toContainText('תגובה בהמתנה');
  await card.getByTestId('update-entry').first().getByRole('button', { name: 'תגובה', exact: true }).click();
  await expect(card.getByLabel(/כתבו תגובה/)).toContainText('תגובה בהמתנה');

  // An expired draft (over 12 hours old) is dropped.
  await card.getByRole('button', { name: 'סגירה' }).last().click();
  await page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      if (!k.startsWith('bos:draft:')) continue;
      const v = JSON.parse(localStorage.getItem(k)!) as { doc: unknown; at: number };
      localStorage.setItem(k, JSON.stringify({ ...v, at: Date.now() - 13 * 60 * 60 * 1000 }));
    }
  });
  card = await openCard(page, 'טיוטות');
  await card.getByTestId('update-entry').first().getByRole('button', { name: 'תגובה', exact: true }).click();
  await expect(card.getByLabel(/כתבו תגובה/)).not.toContainText('תגובה בהמתנה');
  await expect(card.getByTestId('composer-draft')).toHaveCount(0);
});

test("a subitem's card shows its ancestors in the breadcrumb; each one opens", async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const boardName = await newBoard(page, ['הורה']);
  const card = await openCard(page, 'הורה');
  await card.locator('[data-testid="card-tab"][data-tab-id="subitems"]').click();
  await card.getByTestId('card-subitem-add').first().fill('ילד');
  await card.getByTestId('card-subitem-add').first().press('Enter');
  const child = card.locator('[data-testid="card-subitem"][data-item-name="ילד"]');
  await expect(child).toBeVisible();
  const childId = await child.getAttribute('data-item-id');
  await child.getByTestId('card-subitem-toggle').click();
  const nestedAdd = card.locator(`[data-testid="card-subitem-add"][data-parent-id="${childId}"]`);
  await nestedAdd.fill('נכד');
  await nestedAdd.press('Enter');
  const grandchild = card.locator('[data-testid="card-subitem"][data-item-name="נכד"]');
  await expect(grandchild).toBeVisible();

  // The grandchild: only its ancestors, הורה / ילד — no board, no group (fix5).
  await grandchild.getByTestId('card-subitem-open').click();
  const gCard = page.getByRole('dialog', { name: 'נכד' });
  await expect(gCard).toBeVisible();
  const crumb = gCard.getByTestId('card-breadcrumb');
  await expect(crumb).not.toContainText(boardName);
  await expect(crumb.getByTestId('card-breadcrumb-board')).toHaveCount(0);
  const steps = crumb.getByTestId('card-breadcrumb-item');
  await expect(steps).toHaveText(['הורה', 'ילד']);

  // Its parent opens the parent's card, whose breadcrumb ends with the top item.
  await steps.nth(1).click();
  const cCard = page.getByRole('dialog', { name: 'ילד' });
  await expect(cCard).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/i/${childId}`));
  await expect(cCard.getByTestId('card-breadcrumb-item')).toHaveText(['הורה']);
  await cCard.getByTestId('card-breadcrumb-item').click();
  const pCard = page.getByRole('dialog', { name: 'הורה' });
  await expect(pCard).toBeVisible();
  // A top-level item has no ancestors; the board link opens the board.
  await expect(pCard.getByTestId('card-breadcrumb-item')).toHaveCount(0);
  await pCard.getByTestId('card-breadcrumb-board').click();
  await expect(page).not.toHaveURL(/\/i\//);
});

test('open subitem lists are not kept across visits (nor a legacy stored value)', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['P']);
  await addSubitems(page, 'P', ['s1']);
  await expect(row(page, 's1')).toBeVisible();
  const url = page.url();

  // Nothing is stored for the next visit.
  const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('bos:subitems-open:')));
  expect(stored).toEqual([]);

  // A reload (a new visit): closed.
  await page.reload();
  await expect(row(page, 'P')).toBeVisible();
  await expect(row(page, 's1')).toHaveCount(0);

  // Away and back: closed.
  await addSubitems(page, 'P', []);
  await expect(row(page, 's1')).toBeVisible();
  await page.locator('aside a', { hasText: 'לידים' }).first().click();
  await expect(page).not.toHaveURL(url);
  await page.goto(url);
  await expect(row(page, 'P')).toBeVisible();
  await expect(row(page, 's1')).toHaveCount(0);

  // A legacy stored value is ignored.
  const parentId = await row(page, 'P').getAttribute('data-item-id');
  const boardId = /\/b\/([^/?]+)/.exec(url)![1];
  await page.evaluate(
    ([b, p]) => localStorage.setItem(`bos:subitems-open:${b}`, JSON.stringify([p])),
    [boardId, parentId],
  );
  await page.reload();
  await expect(row(page, 'P')).toBeVisible();
  await expect(row(page, 's1')).toHaveCount(0);

  // A search still opens the matching subitems.
  await page.getByTestId('toolbar-search').fill('s1');
  await expect(row(page, 's1')).toBeVisible();
});
