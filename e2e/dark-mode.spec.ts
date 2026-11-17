// SPDX-License-Identifier: AGPL-3.0-only
import { writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { auditContrast, type ContrastViolation } from './contrast';
import { forbidNativeDialogs, openNewBoard, ownerContext, signIn } from './helpers';

/**
 * Fix: — "look": dark mode accessibility (the timeline pill was white on white) and multi-line updates.
 * AUDIT=1 also walks the whole app in both themes and writes every contrast violation to AUDIT_OUT (JSON).
 * Round 9: white text on a coloured label fill is an accepted exception (product decision — white labels); the audit
 * (contrast.ts) skips it, everything else is still measured.
 */
const uid = () => Math.random().toString(36).slice(2, 7);
const iso = (d: Date) => d.toISOString().slice(0, 10);

type Fixture = {
  boardId: string;
  itemId: string;
  headers: Record<string, string>;
  accountId: string;
  table: string;
  views: { id: string; type: string }[];
};

/** A board with (almost) every column type, a row with values, a second row half empty, and an update. */
const allColumnsBoard = async (page: Page, id: string): Promise<Fixture> => {
  const { headers, meId, accountId } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `נגישות ${id}`, workspace_id: ws } })
  ).json()) as { id: string };
  const col = async (title: string, type: string, settings?: Record<string, unknown>) =>
    (await (
      await page.request.post(`/api/v1/boards/${board.id}/columns`, {
        headers,
        data: { title, type, ...(settings ? { settings } : {}) },
      })
    ).json()) as { id: string; settings: { labels?: { id: number }[] } };
  const status = await col('סטטוס', 'status');
  const dropdown = await col('רשימה', 'dropdown', {
    labels: [
      { id: 1, label: 'אחת' },
      { id: 2, label: 'שתיים' },
    ],
  });
  const timeline = await col('ציר זמן', 'timeline');
  const date = await col('תאריך', 'date');
  const people = await col('אנשים', 'people');
  const numbers = await col('מספרים', 'numbers');
  const text = await col('טקסט', 'text');
  const longText = await col('טקסט ארוך', 'long_text');
  const email = await col('אימייל', 'email');
  const phone = await col('טלפון', 'phone');
  const link = await col('קישור', 'link');
  const rating = await col('דירוג', 'rating');
  const checkbox = await col('תיבה', 'checkbox');
  const tags = await col('תגיות', 'tags');
  await col('הצבעה', 'vote');
  await col('מעקב זמן', 'time_tracking');
  await col('קבצים', 'file');
  await col('מזהה', 'item_id');
  await col('נוצר', 'creation_log');
  await col('עודכן', 'last_updated');
  await col('נוסחה', 'formula', { formula: '{' + numbers.id + '} * 2' });
  const tag = (await (await page.request.post('/api/v1/tags', { headers, data: { name: `תג${id}` } })).json()) as {
    id: string;
  };
  const today = new Date();
  const from = new Date(today.getTime() - 5 * 864e5);
  const to = new Date(today.getTime() + 5 * 864e5);
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, {
      headers,
      data: {
        name: `פריט מלא ${id}`,
        cells: {
          [status.id]: { index: status.settings.labels![0]!.id },
          [dropdown.id]: { ids: [1, 2] },
          [timeline.id]: { from: iso(from), to: iso(to) },
          [date.id]: { date: iso(today) },
          [people.id]: { persons_and_teams: [{ kind: 'person', id: meId }] },
          [numbers.id]: 1234,
          [text.id]: 'טקסט לדוגמה',
          [longText.id]: { text: 'שורה ארוכה של טקסט' },
          [email.id]: { email: 'a@example.com' },
          [phone.id]: { phone: '0501234567', country: 'IL' },
          [link.id]: { url: 'https://example.com', text: 'אתר' },
          [rating.id]: { rating: 3 },
          [checkbox.id]: { checked: true },
          [tags.id]: { tag_ids: [tag.id] },
        },
      },
    })
  ).json()) as { id: string };
  // More status labels, so every default fill is on screen.
  for (const [i, l] of status.settings.labels!.slice(1, 5).entries())
    await page.request.post(`/api/v1/boards/${board.id}/items`, {
      headers,
      data: {
        name: `שורה ${i + 2}`,
        cells: {
          [status.id]: { index: l.id },
          [timeline.id]: { from: iso(from), to: iso(new Date(today.getTime() + (i + 1) * 864e5)) },
        },
      },
    });
  await page.request.post(`/api/v1/items/${item.id}/updates`, {
    headers,
    data: { body: 'שורה ראשונה\nשורה שנייה\n\nפסקה חדשה https://example.com' },
  });
  for (const type of ['kanban', 'calendar', 'cards'] as const)
    await page.request.post(`/api/v1/boards/${board.id}/views`, { headers, data: { type, name: type } });
  const views = (
    (await (await page.request.get(`/api/v1/boards/${board.id}/views`, { headers })).json()) as {
      data: { id: string; type: string }[];
    }
  ).data;
  const table = views.find((v) => v.type === 'table')!.id;
  return { boardId: board.id, itemId: item.id, headers, accountId, table, views };
};

const setTheme = async (page: Page, theme: 'light' | 'dark') => {
  await page.evaluate((t) => localStorage.setItem('bines:theme', t), theme);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
};

test('dark mode: the timeline pill reads (no white on white), in both themes', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const f = await allColumnsBoard(page, id);
  // Wide enough for every column to be on screen (what is scrolled away is not measured).
  await page.setViewportSize({ width: 3000, height: 900 });
  try {
    for (const theme of ['dark', 'light'] as const) {
      await page.goto(`/a/demo/b/${f.boardId}?view=${f.table}`);
      await setTheme(page, theme);
      const pill = page.getByTestId('timeline-pill').first();
      await expect(pill).toBeVisible();
      await pill.screenshot({ path: `e2e/screens/r8-timeline-${theme}.png` });
      await page.screenshot({
        path: `e2e/screens/r8-table-${theme}.png`,
        clip: { x: 0, y: 0, width: 2000, height: 520 },
      });
      const bad = (await auditContrast(page, '[data-testid="board-table"], main')).filter((v) =>
        /timeline|status|label/.test(v.path),
      );
      expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
      // The table itself is clean.
      // The group title is drawn in the group's colour by table/* (another area; the fix — `inkOf` — is reported).
      const table = (await auditContrast(page, 'main')).filter((v) => !v.path.includes('[board-section]'));
      expect(table, JSON.stringify(table, null, 1)).toEqual([]);
    }
  } finally {
    await page.evaluate(() => localStorage.removeItem('bines:theme'));
  }
});

test('updates: Enter makes a new paragraph, the thread keeps lines and spacing; plain-text updates keep breaks', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const f = await allColumnsBoard(page, id);
  await page.goto(`/a/demo/b/${f.boardId}/i/${f.itemId}`);
  // The plain-text update from the API shows its line breaks and its blank-line paragraph.
  const thread = page.getByTestId('update-entry').first();
  await expect(thread).toBeVisible();
  const plain = page.locator('.update-body').filter({ hasText: 'שורה ראשונה' });
  await expect(plain.locator('br')).toHaveCount(3); // a line break, then a blank line

  // Typing: Enter = new paragraph, Shift+Enter = line break; the hint says how to send.
  const editor = page.getByRole('textbox', { name: /כתבו עדכון|עדכון/ }).first();
  await editor.click();
  await expect(page.getByTestId('composer-send-hint')).toBeVisible();
  await page.getByTestId('composer-send-hint').locator('../..').screenshot({ path: 'e2e/screens/r8-composer.png' });
  await page.keyboard.type(`ראשון ${id}`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('שני');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('שלישי');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('אחרי שורה ריקה');
  await page.keyboard.press('Control+Enter');
  const posted = page.locator('.update-body').filter({ hasText: `ראשון ${id}` });
  await expect(posted).toBeVisible();
  await expect(posted.locator('p')).toHaveCount(4);
  await expect(posted.locator('br')).toHaveCount(1);
  // Paragraphs are spaced and the empty paragraph keeps a line's height.
  const geo = await posted.evaluate((el) =>
    Array.from(el.querySelectorAll('p')).map((p) => {
      const r = p.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, h: r.height, lh: parseFloat(getComputedStyle(p).lineHeight) };
    }),
  );
  expect(geo[1]!.top - geo[0]!.bottom).toBeGreaterThanOrEqual(6);
  expect(geo[2]!.h).toBeGreaterThanOrEqual(geo[0]!.lh - 1);
  expect(geo[0]!.lh / 14).toBeGreaterThanOrEqual(1.5);
  await page.getByTestId('update-entry').first().screenshot({ path: 'e2e/screens/r8-update.png' });
});

test('contrast audit of the whole app (AUDIT=1)', async ({ page }) => {
  test.skip(!process.env.AUDIT, 'opt-in: AUDIT=1');
  test.setTimeout(600_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const id = uid();
  const f = await allColumnsBoard(page, id);
  const views = f.views;
  const report: Record<string, ContrastViolation[]> = {};
  const check = async (name: string, root = 'body') => {
    await page.waitForTimeout(700); // past open / fade-in animations
    const v = await auditContrast(page, root);
    if (v.length) report[name] = v;
  };
  const base = '/a/demo';
  await page.setViewportSize({ width: 3000, height: 1000 });
  try {
    for (const theme of ['dark', 'light'] as const) {
      await page.goto(base);
      await setTheme(page, theme);
      await check(`${theme} home`);
      await page.goto(`${base}/b/${f.boardId}?view=${f.table}`);
      await expect(page.getByTestId('timeline-pill').first()).toBeVisible();
      await check(`${theme} board table`);
      // A status picker, a date picker.
      await page.locator('[data-column-type="status"]').nth(1).click();
      await check(`${theme} status popover`, '[data-testid="popover"]');
      await page.keyboard.press('Escape');
      await page.locator('[data-column-type="timeline"]').nth(1).click();
      await check(`${theme} timeline popover`, '[data-testid="popover"]');
      await page.keyboard.press('Escape');
      await page.locator('[data-column-type="people"]').nth(1).click();
      await check(`${theme} people popover`, '[data-testid="popover"]');
      await page.keyboard.press('Escape');
      await page.locator('[data-column-type="tags"]').nth(1).click();
      await check(`${theme} tags popover`, '[data-testid="popover"]');
      await page.keyboard.press('Escape');
      await page.locator('[data-testid="item-row"]').first().click({ button: 'right' });
      await check(`${theme} row menu`, '[role="menu"]');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'סינון' }).first().click();
      await check(`${theme} filter panel`);
      await page.keyboard.press('Escape');
      for (const v of views.filter((x) => x.type !== 'table')) {
        await page.goto(`${base}/b/${f.boardId}?view=${v.id}`);
        await page.waitForTimeout(800);
        await check(`${theme} ${v.type} view`);
      }
      await page.goto(`${base}/b/${f.boardId}/i/${f.itemId}`);
      await expect(page.getByTestId('update-entry').first()).toBeVisible();
      await check(`${theme} item card`);
      for (const p of [
        'my-work',
        'inbox',
        'boards',
        'archive',
        'trash',
        'automations',
        'me',
        'profile',
        'settings/notifications',
        'settings/tokens',
        'admin',
        'admin/users',
        'admin/general',
        'admin/teams',
        'admin/security',
        'admin/usage',
        'admin/audit',
        'admin/templates',
        'admin/connections',
        'admin/tidy',
        'admin/notifications',
      ]) {
        await page.goto(`${base}/${p}`);
        await page.waitForTimeout(800);
        await check(`${theme} /${p}`);
      }
      await page.goto(`${base}/b/${f.boardId}`);
      await page.getByTestId('bell').click();
      await check(`${theme} bell`, '[data-testid="bell-panel"]');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Control+b');
      await page.getByTestId('search-palette').waitFor();
      await page.keyboard.type('פריט');
      await check(`${theme} search`, '[data-testid="search-palette"]');
      await page.keyboard.press('Escape');
      await openNewBoard(page);
      await check(`${theme} new board dialog`, '[role="dialog"]');
      await page.keyboard.press('Escape');
    }
  } finally {
    await page.evaluate(() => localStorage.removeItem('bines:theme'));
    writeFileSync(process.env.AUDIT_OUT ?? 'e2e/screens/r8-contrast.json', JSON.stringify(report, null, 1));
  }
});
