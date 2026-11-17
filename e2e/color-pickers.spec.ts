// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Locator, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * pal40
 * 1. The colour picker (a label's colour in the label editor) shows the forty palette colours, five rows of eight,
 *    grouped vivid / deep with the neutral greys / soft; a new label takes an unused vivid colour.
 * 2. The status picker with many labels (34): the labels flow into columns of eight; the picker floats beside the
 *    centre of the viewport (no backdrop — the page stays usable, the clicked cell stays in sight); the arrow keys
 *    move across the columns (RTL: ← is the next column) and Enter picks; Esc closes. Narrower than its columns,
 *    the picker scrolls across inside (its start on the right) with a visible scrollbar.
 * PAL40_SHOTS=<dir> saves pal40-picker.png and status-picker-many.png there.
 */
const SHOTS = process.env.PAL40_SHOTS;
const COLORS = [
  'forest',
  'yellow',
  'crimson',
  'turquoise',
  'navy',
  'purple',
  'green',
  'orange',
  'rust',
  'amber_deep',
  'olive_deep',
  'moss',
  'emerald_deep',
  'teal_deep',
  'ocean',
  'midnight',
  'grape',
  'magenta_deep',
  'wine',
  'maroon',
  'rose',
  'peach',
  'apricot',
  'sky_soft',
  'iris',
  'lilac',
  'orchid',
  'blush',
  'taupe',
  'stone',
  'graphite',
  'steel',
  'blue',
  'pink',
];
const NAMES = [
  'ליד חדש',
  'שיחה ראשונה',
  'נשלחה הצעה',
  'ממתין לחתימה',
  'בתהליך',
  'הושלם',
  'חסום',
  'לבדיקה',
  'פגישה נקבעה',
  'פולואפ',
  'לא רלוונטי',
  'ממתין לתשלום',
  'שולם',
  'הוחזר',
  'בהקפאה',
  'דחוף',
  'בטיפול צוות',
  'אושר',
  'נדחה',
  'טיוטה',
  'בעיצוב',
  'בפיתוח',
  'בבדיקות',
  'מוכן להשקה',
  'הושק',
  'ארכיון',
  'משוב לקוח',
  'שאלה פתוחה',
  'ממתין לספק',
  'בדרך',
  'נמסר',
  'הזמנה חוזרת',
  'VIP',
  'אחר',
];
const LABELS = NAMES.map((label, i) => ({ id: i, label, color: COLORS[i]!, index: i }));

const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = Date.now().toString(36);
  const board = await api<{ id: string }>('post', '/boards', { name: `פלטה 40 ${tag}`, workspace_id: ws.id });
  const status = await api<{ id: string; settings: { labels: { color: string }[] } }>(
    'post',
    `/boards/${board.id}/columns`,
    { title: 'שלב', type: 'status', settings: { labels: LABELS } },
  );
  for (let i = 1; i <= 12; i++)
    await api('post', `/boards/${board.id}/items`, {
      name: `לקוח ${i} ${tag}`,
      cells: { [status.id]: { index: i === 6 ? 0 : (i * 5) % LABELS.length } },
    });
  return { boardId: board.id, tag, status };
};

const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent ?? '');

test('the 40-colour picker and the centred multi-column status picker', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { boardId, tag, status } = await setup(page);
  // Every label kept its key, the 24 new ones too.
  expect(status.settings.labels.map((l) => l.color)).toEqual(COLORS);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/a/demo/b/${boardId}`);
  const cell = row(page, `לקוח 6 ${tag}`).locator('[data-column-type="status"] [data-cell-edit]');
  await expect(cell).toHaveAttribute('data-color', 'forest');

  // ---- 2. The status picker: columns, centred, keyboard.
  await cell.click();
  const popover = page.getByTestId('popover');
  const picker = popover.getByTestId('status-picker');
  await expect(picker).toBeVisible();
  await expect(popover).toHaveAttribute('data-placement', 'centre');
  await expect(picker).toHaveAttribute('data-columns', '5');
  await expect(picker).toHaveAttribute('data-rows', '7');
  await expect(picker.getByTestId('status-option')).toHaveCount(34);
  // Columns: the second label is below the first, the eighth starts the next column — on its left (RTL).
  const chip = (i: number) => picker.getByTestId('status-option').nth(i);
  const [c0, c1, c7] = [await chip(0).boundingBox(), await chip(1).boundingBox(), await chip(7).boundingBox()];
  expect(Math.abs(c1!.x - c0!.x)).toBeLessThan(1);
  expect(c1!.y).toBeGreaterThan(c0!.y);
  expect(c7!.x + c7!.width).toBeLessThan(c0!.x);
  expect(Math.abs(c7!.y - c0!.y)).toBeLessThan(1);
  // Beside the centre of the viewport, never over the clicked cell.
  const panel = (await popover.boundingBox())!;
  const cellBox = (await cell.boundingBox())!;
  expect(Math.abs(panel.x + panel.width / 2 - 720)).toBeLessThanOrEqual(2);
  expect(overlap(panel, cellBox)).toBe(false);
  // No backdrop: the rest of the page is still what is under the pointer, and the page is not locked.
  const under = await page.evaluate(() => document.elementFromPoint(20, 880)?.closest('[data-testid="popover"]'));
  expect(under).toBeNull();
  expect(await page.evaluate(() => getComputedStyle(document.body).overflow)).not.toBe('hidden');
  // Wide enough here: nothing scrolls across.
  const scroller = picker.getByTestId('status-picker-scroll');
  expect(await scroller.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/status-picker-many.png` });

  // The current label has the focus; ← (RTL: the next column) and ↓ move, Enter picks.
  await expect.poll(() => focusedText(page)).toBe(NAMES[0]);
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedText(page)).toBe(NAMES[1]);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => focusedText(page)).toBe(NAMES[8]);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => focusedText(page)).toBe(NAMES[1]);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => focusedText(page)).toBe(NAMES[16]);
  await page.keyboard.press('Enter');
  await expect(popover).toHaveCount(0);
  await expect(cell).toHaveAttribute('data-color', COLORS[16]!);
  await expect(cell).toHaveText(NAMES[16]!);

  // Esc closes it; so does a click outside.
  await cell.click();
  await expect(picker).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  // Narrower than its five columns: it scrolls across inside, its start (the first column) on the right.
  await page.setViewportSize({ width: 900, height: 800 });
  await cell.click();
  await expect(picker).toBeVisible();
  await expect(popover).toHaveAttribute('data-placement', 'centre');
  const narrow = (await popover.boundingBox())!;
  expect(narrow.x).toBeGreaterThanOrEqual(7);
  expect(narrow.x + narrow.width).toBeLessThanOrEqual(893);
  expect(overlap(narrow, (await cell.boundingBox())!)).toBe(false);
  const across = await scroller.evaluate((el) => ({
    over: el.scrollWidth - el.clientWidth,
    left: el.scrollLeft,
    overflowX: getComputedStyle(el).overflowX,
    // A visible scrollbar (the app's own thin bar; headless Chromium hides scrollbars, so the room kept for it and
    // its stronger thumb are what can be read here).
    room: getComputedStyle(el).paddingBottom,
    thumb: getComputedStyle(el).getPropertyValue('--scroll-thumb').trim(),
    plainThumb: getComputedStyle(document.documentElement).getPropertyValue('--scroll-thumb').trim(),
  }));
  expect(across.over).toBeGreaterThan(20);
  expect(across.left).toBe(0);
  expect(across.overflowX).toBe('auto');
  expect(across.room).toBe('6px');
  expect(across.thumb).not.toBe(across.plainThumb);
  const scrollBox = (await scroller.boundingBox())!;
  const first = (await chip(0).boundingBox())!;
  expect(first.x + first.width).toBeGreaterThan(scrollBox.x + scrollBox.width - 20); // RTL: starts on the right
  await expect(chip(33)).not.toBeInViewport({ ratio: 1 });
  // The keyboard brings the far column into view (End = the last label).
  await page.keyboard.press('End');
  await expect.poll(() => focusedText(page)).toBe(NAMES[33]);
  await expect.poll(() => scroller.evaluate((el) => el.scrollLeft)).toBeLessThan(0);
  const last = (await chip(33).boundingBox())!;
  expect(last.x).toBeGreaterThanOrEqual(scrollBox.x - 1);
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);

  // ---- 1. The colour picker: forty swatches, five rows of eight, by family.
  await page.setViewportSize({ width: 1440, height: 900 });
  await cell.click();
  await popover.getByRole('button', { name: 'עריכת תוויות' }).click();
  const editor = page.getByTestId('label-editor');
  const firstRow = editor.getByTestId('label-row').first();
  await firstRow.getByTestId('label-color').click();
  const palette = firstRow.getByTestId('label-palette');
  await expect(palette).toBeVisible();
  const swatches = palette.getByTestId('label-swatch');
  await expect(swatches).toHaveCount(40);
  await expect(palette.locator('[data-color-group]')).toHaveCount(3);
  const rowsOf = async (l: Locator) =>
    new Set((await l.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))).map(String)).size;
  expect(await rowsOf(swatches)).toBe(5);
  for (const [g, n] of [
    ['vivid', 16],
    ['deep', 16],
    ['soft', 8],
  ] as const)
    await expect(palette.locator(`[data-color-group="${g}"]`).getByTestId('label-swatch')).toHaveCount(n);
  await expect(palette.locator('[data-family="neutral"]')).toHaveCount(4);
  // The selected colour is marked; a deep colour can be picked.
  await expect(palette.locator('[data-color="forest"]')).toHaveAttribute('aria-selected', 'true');
  if (SHOTS) await editor.screenshot({ path: `${SHOTS}/pal40-picker.png` });
  // The swatches wear the label's real look: the chip's tint, not the vivid colour.
  await expect(palette.locator('[data-color="midnight"]')).toHaveAttribute('data-look', 'label');
  await expect(palette.locator('[data-color="midnight"]')).toHaveCSS('background-color', 'rgb(110, 138, 176)');
  await palette.locator('[data-color="midnight"]').click();
  // The colour button and the name field show the midnight tint the table will show (labelSoft, light mode).
  await expect(firstRow.getByTestId('label-color')).toHaveCSS('background-color', 'rgb(110, 138, 176)');
  const firstName = firstRow.getByRole('textbox');
  await expect(firstName).toHaveCSS('background-color', 'rgb(110, 138, 176)');
  await expect(firstName).toHaveCSS('color', 'rgb(4, 17, 35)');
  await expect(firstName).toHaveCSS('font-weight', '400');
  await page.keyboard.press('Escape');
  // A new label takes an unused vivid colour: green, freed just now (the first label is midnight blue now).
  await editor.getByRole('button', { name: /תווית חדשה/ }).click();
  await expect(editor.getByTestId('label-row').last().getByTestId('label-color')).toHaveCSS(
    'background-color',
    'rgb(105, 209, 145)',
  );
  // Then the next unused vivid one (gold — these labels leave no other).
  await editor.getByRole('button', { name: /תווית חדשה/ }).click();
  await expect(editor.getByTestId('label-row').last().getByTestId('label-color')).toHaveCSS(
    'background-color',
    'rgb(233, 185, 102)',
  );
  await editor.getByRole('button', { name: 'ביטול' }).click();
  await page.keyboard.press('Escape');
});
