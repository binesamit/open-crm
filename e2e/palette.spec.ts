// SPDX-License-Identifier: AGPL-3.0-only
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * D-PAL — our own vivid palette and label look on a real board: groups take our colours in our
 * order (green and amber first) and show them as a coloured bar beside a name in the group's colour; a status fills
 * its cell edge to edge with white bold text, its colour a palette key, also for labels sent as an old hex; the
 * battery and the picker (solid chips) follow; the default status column says in progress / done / blocked. In
 * light and dark. PALETTE_SHOTS=<dir> saves board screenshots there (before / after, for review).
 */
const SHOTS = process.env.PALETTE_SHOTS;
const row = (page: Page, name: string) => page.locator(`[data-testid="item-row"][data-item-name="${name}"]`);

const setup = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async <T>(method: 'get' | 'post' | 'put', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as T;
  const ws = (await api<{ data: { id: string }[] }>('get', '/workspaces')).data[0]!;
  const tag = Date.now().toString(36);
  const board = await api<{ id: string; groups: { id: string }[] }>('post', '/boards', {
    name: `פרויקט השקה ${tag}`,
    workspace_id: ws.id,
  });
  const groups = [board.groups[0]!.id];
  for (const title of ['בביצוע', 'ממתין ללקוח', 'הושלמו'])
    groups.push((await api<{ id: string }>('post', `/boards/${board.id}/groups`, { title, position: 'bottom' })).id);
  // Labels sent the old way (hex): stored and shown as our keys.
  const status = await api<{ id: string; settings: { labels: { color: string }[] } }>(
    'post',
    `/boards/${board.id}/columns`,
    {
      title: 'סטטוס',
      type: 'status',
      settings: {
        labels: [
          { id: 0, label: 'בתהליך', color: '#fdab3d', index: 0 },
          { id: 1, label: 'הושלם', color: '#00c875', index: 1, is_done: true },
          { id: 2, label: 'חסום', color: '#df2f4a', index: 2 },
          { id: 3, label: 'לבדיקה', color: '#579bfc', index: 3 },
        ],
      },
    },
  );
  const priority = await api<{ id: string }>('post', `/boards/${board.id}/columns`, {
    title: 'עדיפות',
    type: 'status',
    settings: {
      labels: [
        { id: 0, label: 'גבוהה', color: '#bb3354', index: 0 },
        { id: 1, label: 'בינונית', color: '#4eccc6', index: 1 },
        { id: 2, label: 'נמוכה', color: '#9aadbd', index: 2 },
      ],
    },
  });
  const plain = await api<{ id: string; settings: { labels: { label: string; color: string }[] } }>(
    'post',
    `/boards/${board.id}/columns`,
    { title: 'שלב', type: 'status' },
  );
  await api('post', `/boards/${board.id}/columns`, { title: 'תאריך יעד', type: 'date' });
  const names = [
    ['אפיון דף נחיתה', 'עיצוב לוגו', 'כתיבת תוכן'],
    ['פיתוח טופס הרשמה', 'חיבור סליקה'],
    ['אישור הצעת מחיר', 'משוב על סקיצות'],
    ['הקמת דומיין', 'בדיקות QA'],
  ];
  // The status of each item, per group: in progress / blocked, in progress / review, review / blocked, done.
  const states = [
    [0, 2, 0],
    [0, 3],
    [3, 2],
    [1, 1],
  ];
  let n = 0;
  for (const [g, list] of names.entries())
    for (const [i, name] of list.entries()) {
      n++;
      await api('post', `/boards/${board.id}/items`, {
        name,
        group_id: groups[g],
        cells: {
          [status.id]: { index: states[g]![i]! },
          [priority.id]: { index: n % 3 },
          ...(n % 4 ? { [plain.id]: { index: n % 3 } } : {}),
        },
      });
    }
  return { boardId: board.id, status, plain };
};

const setTheme = async (page: Page, theme: 'light' | 'dark') => {
  await page.evaluate((t) => localStorage.setItem('bines:theme', t), theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
};

test('our palette on a board: group bar, full-fill statuses, keys, default labels — light and dark', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { boardId, status, plain } = await setup(page);
  await page.setViewportSize({ width: 1440, height: 860 });
  try {
    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`/a/demo/b/${boardId}`);
      await setTheme(page, theme);
      await expect(row(page, 'עיצוב לוגו')).toBeVisible();
      await page.waitForTimeout(400);
      if (SHOTS) await page.screenshot({ path: `${SHOTS}/board-${theme}.png` });
      if (process.env.PALETTE_SHOTS_ONLY) continue; // the code before D-PAL: screenshots only

      // Stored as keys (sent as hex); the default column speaks our words in our colours.
      expect(status.settings.labels.map((l) => l.color)).toEqual(['yellow', 'forest', 'crimson', 'blue']);
      expect(plain.settings.labels.map((l) => [l.label, l.color])).toEqual([
        ['בתהליך', 'yellow'],
        ['הושלם', 'forest'],
        ['חסום', 'crimson'],
      ]);
      // Groups: our order (green, amber, …), a coloured bar, the name in the group's colour (not the text colour).
      const bars = page.getByTestId('group-bar');
      await expect(bars.first()).toHaveCSS('width', '6px');
      const ink = theme === 'light' ? 'rgb(19, 34, 31)' : 'rgb(227, 239, 236)';
      await expect(page.getByTestId('group-color').first()).not.toHaveCSS('color', ink);
      const barColors = await bars.evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
      // Vivid: the same fill in both themes.
      expect(barColors.slice(0, 2)).toEqual(['rgb(5, 179, 71)', 'rgb(245, 128, 0)']);
      // A status fills its cell edge to edge with a strong tint and deep-shade text (blocked = red; "ג2").
      const cell = row(page, 'עיצוב לוגו').locator('[data-column-type="status"]').first();
      const fillEl = cell.locator('[data-cell-edit]');
      await expect(fillEl).toHaveCSS('background-color', theme === 'light' ? 'rgb(255, 118, 134)' : 'rgb(149, 35, 48)');
      await expect(fillEl).toHaveCSS('color', theme === 'light' ? 'rgb(71, 7, 15)' : 'rgb(255, 228, 231)');
      await expect(fillEl).toHaveCSS('font-weight', '400');
      const [cellBox, fillBox] = [await cell.boundingBox(), await fillEl.boundingBox()];
      expect(fillBox!.width).toBeGreaterThanOrEqual(cellBox!.width - 2);
      expect(fillBox!.height).toBeGreaterThanOrEqual(cellBox!.height - 2);
      // The battery follows the palette.
      await expect(page.getByTestId('battery-segment').first()).toBeVisible();
    }
    if (process.env.PALETTE_SHOTS_ONLY) return;
    // The picker: matching chips; picking one stores its key.
    await page.goto(`/a/demo/b/${boardId}`);
    await setTheme(page, 'light');
    const cell = row(page, 'עיצוב לוגו').locator('[data-column-type="status"]').first();
    await cell.locator('[data-cell-edit]').click();
    const picker = page.getByTestId('popover');
    const chip = picker.locator('.label-tag[data-color="crimson"]');
    await expect(chip).toHaveText('חסום');
    // The same chip: the strong tint, deep-shade text.
    await expect(chip).toHaveCSS('background-color', 'rgb(255, 118, 134)');
    await expect(chip).toHaveCSS('color', 'rgb(71, 7, 15)');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/picker-light.png` });
    await picker.getByRole('button', { name: 'חסום' }).click();
    await expect(cell.locator('[data-cell-edit]')).toHaveAttribute('data-color', 'crimson');
  } finally {
    await page.evaluate(() => localStorage.removeItem('bines:theme'));
  }
});
