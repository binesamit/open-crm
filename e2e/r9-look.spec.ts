// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { auditContrast } from './contrast';
import { forbidNativeDialogs, ownerContext, signIn, pickGroupColumn } from './helpers';

/** Prod ("ג2"): a label chip's tint and text (colors.ts labelSoft / labelInk). */
const CHIP: Record<string, Record<'light' | 'dark', [string, string]>> = {
  yellow: { light: ['#f9b366', '#452400'], dark: ['#905c12', '#fef0e0'] },
  forest: { light: ['#69d191', '#013214'], dark: ['#09783a', '#e1f6e9'] },
  crimson: { light: ['#ff7686', '#47070f'], dark: ['#952330', '#ffe4e7'] },
  blue: { light: ['#769df6', '#071a43'], dark: ['#2c4e9b', '#e8edfe'] },
  sage: { light: ['#69d1b4', '#013224'], dark: ['#09785b', '#e1f6f0'] },
};

/**
 * Fix: — "look":
 * 1. A status fills its cell, edge to edge, with a strong tint of its palette colour and the text in its deep shade
 * ("ג2"), in both themes; the contrast audit passes.
 * 2. The stuck group header row sits exactly at the scroll box's top edge — no strip of rows showing above it (the
 *    box's top padding used to push it 16px down), opaque, full width, above the frozen name column — in both
 *    themes, ungrouped / grouped by a column, with the subitems open and closed. Real mouse-wheel scrolling.
 */
const SCRATCH = process.env.R9_SCRATCH ?? 'e2e/.scratch';
const uid = () => Math.random().toString(36).slice(2, 7);
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const LABELS = [
  { id: 0, label: 'בעבודה', color: 'yellow', index: 0 },
  { id: 1, label: 'הושלם', color: 'forest', index: 1, is_done: true },
  { id: 2, label: 'תקוע', color: 'crimson', index: 2 },
  { id: 3, label: 'צהוב', color: 'yellow', index: 3 },
  { id: 4, label: 'תכלת', color: 'blue', index: 4 },
  { id: 5, label: 'מרווה', color: 'sage', index: 5 },
];

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = uid();
  const board = await api<{ id: string }>('post', '/boards', { name: `סבב9 ${tag}`, workspace_id: ws.id });
  const status = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'מצב',
    type: 'status',
    settings: { labels: LABELS },
  });
  await api('post', `/boards/${board.id}/columns`, { title: 'הערה', type: 'text' });
  const items: string[] = [];
  for (let i = 1; i <= 16; i++) {
    const it = await api<{ id: string }>('post', `/boards/${board.id}/items`, {
      name: `פריט ${i} ${tag}`,
      cells: { [status.id]: { index: LABELS[i % LABELS.length]!.id } },
    });
    items.push(it.id);
  }
  for (let i = 1; i <= 6; i++) await api('post', `/items/${items[2]!}/subitems`, { name: `סאב ${i} ${tag}` });
  await api('post', `/boards/${board.id}/views`, { type: 'kanban', name: 'kanban' });
  const views = (await api<{ data: { id: string; type: string }[] }>('get', `/boards/${board.id}/views`)).data;
  return { boardId: board.id, tag, views, table: `${board.id}?view=${views.find((v) => v.type === 'table')!.id}` };
};

const setTheme = async (page: Page, theme: 'light' | 'dark') => {
  await page.evaluate((t) => localStorage.setItem('bines:theme', t), theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
};

const rgb = (hex: string) => `rgb(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(', ')})`;

test('labels: a full fill in a strong tint of the colour, deep-shade text, in both themes; the audit passes', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { boardId, tag, views, table } = await setup(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  try {
    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`/a/demo/b/${table}`);
      await setTheme(page, theme);
      for (const [i, l] of LABELS.entries()) {
        const n = i === 0 ? LABELS.length : i; // item n has label n % 6
        const cell = row(page, `פריט ${n} ${tag}`).locator('[data-column-type="status"]');
        await expect(cell.locator('[data-cell-edit]')).toHaveAttribute('data-color', l.color);
        const fillEl = cell.locator('[data-cell-edit]');
        await expect(fillEl).toBeVisible();
        // The deep shade on the strong tint (ג2), regular weight.
        const [soft, ink] = CHIP[l.color]![theme];
        await expect(fillEl).toHaveCSS('color', rgb(ink));
        await expect(fillEl).toHaveCSS('font-weight', '400');
        await expect(fillEl).toHaveCSS('background-color', rgb(soft));
      }
      if (theme === 'light')
        await page
          .getByTestId('board-table')
          .screenshot({ path: `${SCRATCH}/r9-labels-${theme}.png` })
          .catch(() => undefined);
      // The audit passes, with the accepted white-on-label-fill exception (Fix: ; D30 vivid).
      const bad = await auditContrast(page, 'main');
      expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
      // Kanban lanes and cards carry the labels as solid chips too.
      await page.goto(`/a/demo/b/${boardId}?view=${views.find((v) => v.type === 'kanban')!.id}`);
      await page.waitForTimeout(600);
      const lanes = await auditContrast(page, 'main');
      expect(lanes, JSON.stringify(lanes, null, 1)).toEqual([]);
    }
  } finally {
    await page.evaluate(() => localStorage.removeItem('bines:theme'));
  }
});

/** The table's scroll box and the stuck header's geometry; probes along its rows report what is hit there. */
const stickyState = (page: Page) =>
  page.evaluate(() => {
    let box = document.querySelector('[data-testid="board-table"]')!.parentElement;
    while (box && getComputedStyle(box).overflowY !== 'auto') box = box.parentElement;
    const b = box!.getBoundingClientRect();
    const top = b.top + box!.clientTop;
    const stuck = document.querySelector('[data-testid="sticky-header"]');
    if (!stuck) return { scrollTop: box!.scrollTop, stuck: null };
    const s = stuck.getBoundingClientRect();
    // Points across the whole visible width (to the empty area past the last column), on every pixel row of the
    // band from the box's top edge to the header's bottom: each must land in the stuck header.
    const misses: string[] = [];
    const right = b.left + box!.clientWidth;
    for (let y = top + 0.5; y < s.bottom - 0.5; y += 3)
      for (let x = b.left + 2; x < right - 2; x += 40) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || !stuck.contains(hit)) misses.push(`${Math.round(x)},${Math.round(y)}:${hit?.tagName}`);
      }
    // Opaque: the stuck strip and its box paint a solid background.
    const bgs = [stuck, stuck.firstElementChild!].map((e) => getComputedStyle(e).backgroundColor);
    return {
      scrollTop: box!.scrollTop,
      stuck: { gap: s.top - top, height: s.height, width: s.width, boxWidth: box!.clientWidth, misses, bgs },
    };
  });

const wheelAndCheck = async (page: Page, label: string) => {
  const table = (await page.getByTestId('board-table').boundingBox())!;
  await page.mouse.move(table.x + table.width / 2, Math.max(table.y, 300) + 100);
  let checked = 0;
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, 45);
    await page.waitForTimeout(120);
    const st = await stickyState(page);
    if (!st.stuck || st.stuck.gap < -0.5) continue; // not stuck yet, or being pushed away by the next group
    checked++;
    expect(Math.abs(st.stuck.gap), `${label} @${st.scrollTop}: gap above the stuck header`).toBeLessThan(0.6);
    expect(st.stuck.width, `${label}: full width`).toBeGreaterThanOrEqual(st.stuck.boxWidth - 1);
    expect(st.stuck.misses, `${label} @${st.scrollTop}: rows show through`).toEqual([]);
    for (const bg of st.stuck.bgs) expect(bg, `${label}: opaque`).toMatch(/^rgb\(/);
  }
  expect(checked, `${label}: the header got stuck while scrolling`).toBeGreaterThan(3);
};

test('sticky header: at the very top edge, opaque, full width — light/dark, grouped/ungrouped, subitems open/closed', async ({
  page,
}) => {
  test.setTimeout(180_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { tag, table: tableUrl } = await setup(page);
  await page.setViewportSize({ width: 1500, height: 800 });
  const scrollBox = () =>
    page.evaluate(() => {
      let e = document.querySelector('[data-testid="board-table"]')!.parentElement;
      while (e && getComputedStyle(e).overflowY !== 'auto') e = e.parentElement;
      e!.scrollTop = 0;
    });
  try {
    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`/a/demo/b/${tableUrl}`);
      await setTheme(page, theme);
      await expect(row(page, `פריט 1 ${tag}`)).toBeVisible();
      await wheelAndCheck(page, `${theme} ungrouped closed`);

      await scrollBox();
      const parent = row(page, `פריט 3 ${tag}`);
      await parent.hover();
      await parent.getByTestId('subitems-toggle').click();
      await expect(row(page, `סאב 6 ${tag}`)).toBeVisible();
      await wheelAndCheck(page, `${theme} ungrouped open`);

      // Grouped by the status column (sections, each with its own stuck header).
      await scrollBox();
      await page.getByTestId('toolbar-group').click();
      await pickGroupColumn(page, 'מצב');
      await page.keyboard.press('Escape');
      await expect(row(page, `סאב 6 ${tag}`)).toBeVisible();
      await scrollBox();
      await wheelAndCheck(page, `${theme} grouped open`);

      // A frame like the reported one: the parent row and its subitems scrolled up under the stuck header.
      await scrollBox();
      const table = (await page.getByTestId('board-table').boundingBox())!;
      await page.mouse.move(table.x + table.width / 2, 400);
      // Wheel until the open parent row sits a little under the stuck header (its subitems' header half hidden).
      const parentTop = (await row(page, `פריט 3 ${tag}`).boundingBox())!.y;
      await page.mouse.wheel(0, parentTop - table.y + 20);
      await page.waitForTimeout(300);
      const st = await stickyState(page);
      expect(st.stuck?.gap ?? 0).toBeLessThan(0.6);
      expect(st.stuck?.misses ?? []).toEqual([]);
      await page.screenshot({ path: `${SCRATCH}/r9-sticky-${theme}.png` });
      // Leave the view's grouping as it was.
      await page.getByTestId('toolbar-group').click();
      await pickGroupColumn(page, 'מצב');
      await page.keyboard.press('Escape');
    }
  } finally {
    await page.evaluate(() => localStorage.removeItem('bines:theme'));
  }
});
