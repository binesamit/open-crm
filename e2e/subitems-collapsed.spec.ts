// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * Owner fixes (fix5-board): entering a board shows the subitems closed even when the view comes with a search
 * (restored draft); the subitems toggle reads "count, chevron" with the chevron pointing down when open and along
 * the reading direction when closed; the timeline cell always shows its dates (the days only in a hover bubble);
 * the board search is a compact "magnifier + Ctrl F" tool that opens on click / Ctrl+F and folds back when empty.
 */
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const newBoard = async (page: Page, items: string[]) => {
  const name = `תיקון5 ${Date.now().toString(36)}`;
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

const addSubitems = async (page: Page, parent: string, names: string[]) => {
  await row(page, parent).hover();
  await row(page, parent).getByTestId('subitems-toggle').click();
  // The parent's own add row (the first one under it; nested levels have their own).
  const field = page.getByLabel('+ הוספת תת-פריט').first();
  for (const n of names) {
    await field.fill(n);
    await field.press('Enter');
    await expect(row(page, n)).toBeVisible();
  }
};

const rotation = (page: Page, parent: string) =>
  row(page, parent)
    .getByTestId('subitems-chevron')
    .evaluate((el) => getComputedStyle(el).rotate);

test('subitems start closed on entry, also when a search comes back with the view', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['Parent', 'Other']);
  await addSubitems(page, 'Parent', ['alpha step']);
  const toggle = row(page, 'Parent').getByTestId('subitems-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');

  // A search typed now opens the path to its match.
  await page.getByTestId('toolbar-search').fill('alpha');
  await expect(row(page, 'Other')).toHaveCount(0);
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'alpha step')).toBeVisible();

  // Entering again (the search is restored from the view's draft): the board shows, the subitems stay closed.
  await page.reload();
  await expect(page.getByTestId('toolbar-search')).toHaveValue('alpha');
  await expect(row(page, 'Parent')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'alpha step')).toHaveCount(0);

  // Changing the search in this visit opens its matches again.
  await page.getByTestId('toolbar-search').fill('alpha s');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'alpha step')).toBeVisible();

  // Cleared: nothing is open by itself; a fresh entry is closed too.
  await page.getByTestId('toolbar-search').fill('');
  await expect(row(page, 'Other')).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(row(page, 'Parent').getByTestId('subitems-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(row(page, 'alpha step')).toHaveCount(0);
});

test('subitems toggle: the chevron after the count, down when open, along the reading direction when closed', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['Parent']);
  await addSubitems(page, 'Parent', ['child one', 'child two']);
  const toggle = row(page, 'Parent').getByTestId('subitems-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  // Hebrew (RTL): the chevron sits to the left of the number.
  const count = await toggle.getByTestId('subitems-count').boundingBox();
  const chevron = await toggle.getByTestId('subitems-chevron').boundingBox();
  expect(count && chevron && chevron.x + chevron.width <= count.x + 1).toBeTruthy();
  await expect(toggle.getByTestId('subitems-count')).toHaveText('2');

  // Open → points down (the right-pointing chevron turned 90°); closed in RTL → points left (180°).
  await expect.poll(() => rotation(page, 'Parent')).toBe('90deg');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => rotation(page, 'Parent')).toBe('180deg');

  // Nested levels use the same toggle.
  await toggle.click();
  await addSubitems(page, 'child one', ['grandchild']);
  const nested = row(page, 'child one').getByTestId('subitems-toggle');
  await expect(nested).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(() => rotation(page, 'child one')).toBe('90deg');
  await nested.click();
  await expect.poll(() => rotation(page, 'child one')).toBe('180deg');
});

test('timeline cell: the dates as its text, the days only in a hover bubble', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['Range']);
  await page.getByRole('button', { name: 'הוספת עמודה' }).first().click();
  await page.getByRole('button', { name: 'ציר זמן', exact: true }).click();

  const now = new Date();
  // Next month's days: a range that never ends before today (on the 13th, the 3rd–12th of this month was already
  // overdue — a red pill and "באיחור").
  const day = (n: number) => new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, n)).toISOString().slice(0, 10);
  const label = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
  // Day/month, plus a two-digit year outside the current year (formatTimeline).
  const short = (s: string) =>
    s.slice(0, 4) === String(now.getFullYear())
      ? `${s.slice(8, 10)}/${s.slice(5, 7)}`
      : `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(2, 4)}`;
  const cell = row(page, 'Range').locator('[data-column-type="timeline"]');
  await cell.click();
  await page.getByRole('button', { name: 'החודש הבא' }).click();
  await page.getByRole('button', { name: label(day(3)), exact: true }).click();
  await page.getByRole('button', { name: label(day(12)), exact: true }).click();
  await page.keyboard.press('Escape');

  const pill = cell.getByTestId('timeline-pill');
  await expect(pill).toHaveText(`${short(day(3))} – ${short(day(12))}`);
  await expect(page.getByTestId('timeline-days')).toBeHidden();

  // Hover: the dates stay, the days show in the bubble — in Hebrew order, not inside the LTR pill.
  await pill.hover();
  await expect(pill).toHaveText(`${short(day(3))} – ${short(day(12))}`);
  const days = page.getByTestId('timeline-days');
  await expect(days).toBeVisible();
  await expect(days).toHaveText('10 ימים');
  expect(await days.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');

  // Dark theme: the same.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.mouse.move(0, 0);
  await expect(days).toBeHidden();
  await pill.hover();
  await expect(days).toBeVisible();
  await expect(pill).toHaveText(`${short(day(3))} – ${short(day(12))}`);
});

test('board search: a compact "magnifier + Ctrl F" tool that opens on click or Ctrl+F', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await newBoard(page, ['alpha', 'beta']);
  const box = page.getByTestId('board-search');
  const input = page.getByTestId('toolbar-search');
  const width = async () => (await input.boundingBox())?.width ?? 0;

  // Idle: folded, the shortcut hint beside the magnifier.
  await expect(box).toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('search-kbd')).toBeVisible();
  await expect(page.getByTestId('search-kbd')).toHaveText(/F$/);
  await expect.poll(width).toBeLessThan(110);

  // A click opens the field.
  await input.click();
  await expect(box).not.toHaveAttribute('data-collapsed', 'true');
  await expect(page.getByTestId('search-kbd')).toHaveCount(0);
  await expect.poll(width).toBeGreaterThan(180);

  // Left empty: folds back.
  await page.getByRole('heading', { level: 1 }).click();
  await expect(box).toHaveAttribute('data-collapsed', 'true');
  await expect.poll(width).toBeLessThan(110);

  // Ctrl+F: opens with the accent ring.
  await page.keyboard.press('Control+f');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('data-summoned', 'true');
  await expect.poll(width).toBeGreaterThan(180);

  // With a query it stays open after leaving it.
  await page.keyboard.type('alp');
  await expect(row(page, 'beta')).toHaveCount(0);
  await page.getByRole('heading', { level: 1 }).click();
  await expect(box).not.toHaveAttribute('data-collapsed', 'true');
  await expect(input).toHaveValue('alp');
  await expect.poll(width).toBeGreaterThan(180);

  // Esc clears it and it folds again.
  await input.click();
  await page.keyboard.press('Escape');
  await expect(input).toHaveValue('');
  await expect(box).toHaveAttribute('data-collapsed', 'true');
  await expect(row(page, 'beta')).toBeVisible();
});
