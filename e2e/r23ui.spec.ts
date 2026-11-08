// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * r23ui — four prod fixes:
 * "last updated": choose who / when / both, with the time, and only changes of chosen columns count.
 * no board-permission avatars in the board header — permissions open from ⋯ → "הרשאות".
 * phones: a menu / list with a search field opens without focusing it (no keyboard until one taps it).
 * phone table: the sticky name column is wider (45% of the screen, ≥140px) and names wrap to two lines.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const setup = async (page: Page, columns: { title: string; type: string; settings?: Json }[], items: string[]) => {
  const { headers } = await ownerContext(page);
  const api = async <T = Json>(method: 'get' | 'post' | 'put', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api('post', '/boards', { name: `r23ui ${tag}`, workspace_id: ws.id });
  const cols: Json[] = [];
  for (const c of columns) cols.push(await api('post', `/boards/${board.id}/columns`, c));
  const made: Json[] = [];
  for (const name of items) made.push(await api('post', `/boards/${board.id}/items`, { name }));
  return { api, board, cols, items: made, tag };
};

test.beforeEach(async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
});

test('last updated: only changes of the chosen column count; the settings say so', async ({ page }) => {
  const { api, board, cols, items } = await setup(
    page,
    [
      { title: 'שלב', type: 'text' },
      { title: 'אחר', type: 'text' },
      { title: 'עודכן שלב', type: 'last_updated', settings: { mode: 'date' } },
    ],
    ['עסקה'],
  );
  const [stage, other, watch] = cols as [Json, Json, Json];
  const item = items[0]!;
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, 'עסקה')).toBeVisible();

  // The column's settings: watch "שלב" only, show the time.
  await page.locator(`[data-header="${watch.id}"]`).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /הגדרות|settings/i }).click();
  await page.getByTestId('last-updated-columns').click();
  await page.getByTestId(`last-updated-column-${stage.id}`).click();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('last-updated-columns')).toHaveText('שלב');
  await page.getByTestId('meta-log-show-time').click();
  await page.getByTestId('column-settings-save').click();
  await expect(page.getByTestId('column-settings-save')).toHaveCount(0);

  const cell = row(page, 'עסקה').locator(`[data-column="${watch.id}"]`);
  // Nothing chosen changed yet: empty. Another column changing leaves it empty.
  await api('put', `/items/${item.id}/cells/${other.id}`, { value: 'x' });
  await page.reload();
  await expect(cell).toHaveText('');
  // The chosen column changes: date and time.
  await api('put', `/items/${item.id}/cells/${stage.id}`, { value: 'qualified' });
  await page.reload();
  await expect(cell).toHaveText(/\d{2}\/\d{2}\/\d{4} \d{1,2}:\d{2}/);
  const shown = await cell.textContent();
  // Later changes elsewhere do not move it.
  await page.waitForTimeout(1100);
  await api('put', `/items/${item.id}/cells/${other.id}`, { value: 'y' });
  await page.reload();
  await expect(cell).toHaveText(shown!);
});

test('board header: no permission avatars; ⋯ → הרשאות opens the permissions', async ({ page }) => {
  const { board } = await setup(page, [], ['פריט']);
  await page.goto(`/a/demo/b/${board.id}`);
  await expect(row(page, 'פריט')).toBeVisible();
  await expect(page.getByTestId('board-avatars')).toHaveCount(0);
  await page.getByTestId('board-more').click();
  await page.getByTestId('board-permissions').click();
  await expect(page.getByTestId('permissions-dialog')).toBeVisible();
});

test.describe('phones', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('a menu or a picker with a search opens without focusing it; a tap focuses it', async ({ page }) => {
    const text = Array.from({ length: 8 }, (_, i) => ({ title: `עמודה ${i + 1}`, type: 'text' }));
    const { board, cols } = await setup(page, [{ title: 'אחראי', type: 'people' }, ...text], ['פריט']);
    await page.goto(`/a/demo/b/${board.id}`);
    await expect(row(page, 'פריט')).toBeVisible();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);

    // A menu with a search (the filter's column picker).
    await page.getByTestId('mobile-filter-open').click();
    const tools = page.getByTestId('mobile-filter-sheet');
    await tools.getByTestId('toolbar-filter').click();
    const panel = page.getByTestId('filter-panel');
    await panel.getByTestId('filter-rail-advanced').click();
    await panel.getByTestId('filter-add-rule').click();
    await panel.getByTestId('filter-rule').last().getByTestId('rule-column').click();
    const search = page.getByRole('menu').getByTestId('menu-search');
    await expect(search).toBeVisible();
    await page.waitForTimeout(300);
    await expect(search).not.toBeFocused();
    await search.tap();
    await expect(search).toBeFocused();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(row(page, 'פריט')).toBeVisible();

    // A picker with a search (the people cell's sheet).
    await row(page, 'פריט').locator(`[data-column="${cols[0]!.id}"]`).tap();
    const people = page.getByTestId('people-search');
    await expect(people).toBeVisible();
    await page.waitForTimeout(300);
    await expect(people).not.toBeFocused();
    await people.tap();
    await expect(people).toBeFocused();
  });

  test('the phone table: a wide sticky name column; long names wrap to two lines in the same row height', async ({
    page,
  }) => {
    const long = 'שם ארוך מאוד של פריט שצריך לראות כמעט את כולו גם כשגוללים את הטבלה הצידה';
    const { board } = await setup(
      page,
      Array.from({ length: 5 }, (_, i) => ({ title: `עמודה ${i + 1}`, type: 'text' })),
      ['קצר', long],
    );
    await page.goto(`/a/demo/b/${board.id}`);
    await expect(row(page, 'קצר')).toBeVisible();
    const nameCell = row(page, 'קצר').getByRole('rowheader');
    const width = (await nameCell.boundingBox())!.width;
    expect(width).toBeGreaterThanOrEqual(Math.max(140, 390 * 0.4));
    // r25: wider at the start of the sideways scroll (65% of the screen).
    expect(width).toBeLessThanOrEqual(390 * 0.7);

    const text = row(page, long).getByTestId('mobile-item-name-text');
    expect(await text.evaluate((el) => getComputedStyle(el).webkitLineClamp)).toBe('2');
    const lineHeight = await text.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    expect((await text.boundingBox())!.height).toBeGreaterThan(lineHeight * 1.5);
    // Both rows keep the same height (no jump).
    const [a, b] = [(await row(page, 'קצר').boundingBox())!, (await row(page, long).boundingBox())!];
    expect(Math.abs(a.height - b.height)).toBeLessThan(1);

    // Scrolled sideways, the name column stays in place at the inline-start edge.
    const before = (await nameCell.boundingBox())!;
    const scrolled = await page.getByTestId('mobile-table').evaluate((el) => {
      let scroller: HTMLElement | null = el.parentElement;
      while (
        scroller &&
        !(scroller.scrollWidth > scroller.clientWidth && /auto|scroll/.test(getComputedStyle(scroller).overflowX))
      )
        scroller = scroller.parentElement;
      if (!scroller) return false;
      scroller.scrollLeft = getComputedStyle(scroller).direction === 'rtl' ? -300 : 300;
      return scroller.scrollLeft !== 0;
    });
    expect(scrolled).toBe(true);
    await page.waitForTimeout(200);
    const rtl = await page.evaluate(() => getComputedStyle(document.documentElement).direction === 'rtl');
    const after = (await nameCell.boundingBox())!;
    // r25: it stays pinned at the inline-start edge (it narrows as it scrolls — see r25.spec.ts).
    const edge = (b: { x: number; width: number }) => (rtl ? b.x + b.width : b.x);
    expect(Math.abs(edge(after) - edge(before))).toBeLessThan(2);
  });
});
