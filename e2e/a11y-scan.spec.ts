// SPDX-License-Identifier: AGPL-3.0-only
import { writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ownerContext, signIn } from './helpers';
import { WEB_URL } from './stack';

/**
 * Accessibility (Israeli Standard 5568 ≈ WCAG 2.1 AA), stage 1: an automated scan (axe-core) of the
 * app's main screens — logged out, desktop light and dark, and a phone. Every WCAG 2.0 / 2.1 / 2.2 A + AA rule must
 * pass (2.2 adds the 24px target size), so a later change that breaks accessibility fails here before it ships. And
 * reflow (WCAG 1.4.10, = 200% zoom of a 640px window): at 320 CSS px wide no screen scrolls sideways.
 *
 * `A11Y_REPORT=<file.json>`: report mode — writes every violation to the file and does not fail (to plan fixes).
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const REPORT = process.env.A11Y_REPORT;
type Found = { page: string; id: string; impact: string | null | undefined; help: string; nodes: number; at: string[] };
const found: Found[] = [];

const scan = async (page: Page, name: string) => {
  // Let lazy parts and animations settle.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.waitForTimeout(400);
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const v = r.violations.map((x) => ({
    page: name,
    id: x.id,
    impact: x.impact,
    help: x.help,
    nodes: x.nodes.length,
    at: x.nodes
      .slice(0, 4)
      .map(
        (n) =>
          `${n.target.join(' ')} :: ${n.html.slice(0, 160)} :: ${(n.failureSummary ?? '').replace(/\s+/g, ' ').slice(0, 300)}`,
      ),
  }));
  found.push(...v);
  if (!REPORT) expect(v, JSON.stringify(v, null, 1)).toEqual([]);
};

test.afterAll(() => {
  if (REPORT) writeFileSync(REPORT, JSON.stringify(found, null, 1));
});

const setTheme = async (page: Page, theme: 'light' | 'dark') => {
  await page.evaluate((x) => localStorage.setItem('bines:theme', x), theme);
  await page.reload();
};

/** A board with a status column, three items (one with an update) — the table, its item card and the views. */
const boardFixture = async (page: Page) => {
  const { headers } = await ownerContext(page);
  const api = async (method: 'get' | 'post', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as Record<string, unknown>;
  const ws = ((await api('get', '/workspaces')).data as { id: string }[])[0]!;
  const tag = Math.random().toString(36).slice(2, 7);
  const board = await api('post', '/boards', { name: `נגישות ${tag}`, workspace_id: ws.id });
  await api('post', `/boards/${board.id as string}/columns`, { title: 'סטטוס', type: 'status' });
  await api('post', `/boards/${board.id as string}/columns`, { title: 'תאריך', type: 'date' });
  const item = await api('post', `/boards/${board.id as string}/items`, { name: 'Alpha' });
  for (const name of ['Bravo', 'Charlie']) await api('post', `/boards/${board.id as string}/items`, { name });
  return { boardId: board.id as string, itemId: item.id as string };
};

const APP_PAGES: [string, string][] = [
  ['home', '/a/demo'],
  ['inbox', '/a/demo/inbox'],
  ['my-work', '/a/demo/my-work'],
  ['profile', '/a/demo/profile'],
  ['automations', '/a/demo/automations'],
  ['flows', '/a/demo/flows'],
  ['agents', '/a/demo/agents'],
  ['archive', '/a/demo/archive'],
  ['trash', '/a/demo/trash'],
  ['admin', '/a/demo/admin'],
  ['admin-users', '/a/demo/admin/users'],
  ['support', '/a/demo/support'],
  ['help', '/a/demo/help'],
  // The owner console (the demo owner is the platform owner): every section that was once its long platform page
  // (a side nav of sections).
  ['owner', '/owner'],
  ...(
    [
      'accounts',
      'signup-requests',
      'emergency',
      'deletions',
      'plans',
      'signup',
      'ai-prices',
      'kits',
      'extensions',
      'legal',
      'general',
      'security',
      'email',
      'connections',
      'incidents',
    ] as const
  ).map((s): [string, string] => [`owner-${s}`, `/owner?section=${s}`]),
];

test('logged out: sign-in, sign-up and the legal pages', async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({ baseURL: WEB_URL, locale: 'he-IL' });
  const page = await context.newPage();
  for (const [name, path] of [
    ['login', '/login'],
    ['signup', '/signup'],
    ['legal', '/legal'],
    ['pricing', '/pricing'],
  ] as const) {
    await page.goto(path);
    await scan(page, `out:${name}`);
  }
  await context.close();
});

for (const theme of ['light', 'dark'] as const)
  test(`desktop ${theme}: the app's main screens, a board, its item card and views`, async ({ page }) => {
    // Every owner console section is scanned too, hence the longer budget.
    test.setTimeout(480_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await setTheme(page, theme);
    try {
      for (const [name, path] of APP_PAGES) {
        await page.goto(path);
        await scan(page, `${theme}:${name}`);
      }
      const { boardId, itemId } = await boardFixture(page);
      await page.goto(`/a/demo/b/${boardId}`);
      await expect(page.locator('[data-testid="item-row"][data-item-name="Alpha"]')).toBeVisible();
      await scan(page, `${theme}:board`);
      await page.getByTestId('toolbar-filter').click();
      await scan(page, `${theme}:board-filter`);
      await page.keyboard.press('Escape');
      await page.goto(`/a/demo/b/${boardId}/i/${itemId}`);
      await expect(page.getByRole('dialog', { name: 'Alpha' })).toBeVisible();
      await scan(page, `${theme}:item-card`);
    } finally {
      await page.evaluate(() => localStorage.removeItem('bines:theme'));
    }
  });

test('phone: home, a board, its item card and the tools sheet', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto('/a/demo');
  await scan(page, 'phone:home');
  const { boardId, itemId } = await boardFixture(page);
  await page.goto(`/a/demo/b/${boardId}`);
  await expect(page.getByTestId('mobile-item-name').filter({ hasText: 'Alpha' })).toBeVisible();
  await scan(page, 'phone:board');
  await page.goto(`/a/demo/b/${boardId}/i/${itemId}`);
  await expect(page.getByRole('dialog', { name: 'Alpha' })).toBeVisible();
  await scan(page, 'phone:item-card');
});

/**
 * Interactive documents (product owner: "places without readable accessibility"; "the left side does not
 * scroll"): the item card's Documents tab, the editor (light and dark) and the client's public page (desktop and
 * phone) pass the same rules; every editor pane scrolls on its own.
 */
type Section = { kind: string; preset?: string | null; mapping?: Record<string, unknown> } & Record<string, unknown>;
type Doc = Record<string, unknown> & { id?: string; sections?: Section[]; subitems_board_id?: string; data?: unknown };

test('interactive documents: the Documents tab, the editor and the client page', async ({ page, browser }) => {
  test.setTimeout(240_000);
  await signIn(page);
  const { boardId, itemId } = await boardFixture(page);
  const { headers } = await ownerContext(page);
  const api = async (method: 'get' | 'post' | 'patch', path: string, data?: unknown) =>
    (await (await page.request[method](`/api/v1${path}`, { headers, data })).json()) as Doc;
  const sub = await api('post', `/items/${itemId}/subitems`, { name: 'חבילת בסיס' });
  const subBoard = (await api('get', `/boards/${boardId}`)).subitems_board_id as string;
  await api('post', `/boards/${subBoard}/columns`, { id: 'price', title: 'מחיר', type: 'numbers' });
  await api('patch', `/items/${sub.id as string}`, { cells: { price: 5000 } });
  const doc = await api('post', `/items/${itemId}/idocs`, { starter: 'quote_agreement' });
  await api('patch', `/idocs/${doc.id as string}`, {
    sections: (doc.sections as Section[]).map((x) =>
      x.kind === 'lines' && x.preset === 'fixed_lines' ? { ...x, mapping: { ...x.mapping, price: 'price' } } : x,
    ),
  });

  await page.goto(`/a/demo/b/${boardId}/i/${itemId}`);
  await page.locator('[data-testid="card-tab"][data-tab-id="documents"]').click();
  await expect(page.getByTestId('idoc-share-url')).toBeVisible();
  await scan(page, 'idocs:documents-tab');

  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((x) => localStorage.setItem('bines:theme', x), theme);
    await page.reload();
    await page.locator('[data-testid="card-tab"][data-tab-id="documents"]').click();
    await page.getByTestId('idoc-edit').first().click();
    const builder = page.getByTestId('idoc-builder');
    await expect(builder.getByTestId('idoc-preview-page')).toBeVisible();
    await scan(page, `idocs:editor-${theme}`);
    // Each pane scrolls on its own (the settings of the document are long).
    await builder.getByTestId('idoc-pane-doc').click();
    const scrolled = await builder.getByTestId('idoc-pane-settings').evaluate((el) => {
      el.scrollTop = 400;
      return { can: el.scrollHeight > el.clientHeight, top: el.scrollTop };
    });
    expect(scrolled.can).toBe(true);
    expect(scrolled.top).toBeGreaterThan(0);
    await builder.getByTestId('idoc-builder-close').click();
  }
  await page.evaluate(() => localStorage.removeItem('bines:theme'));

  const url = new URL(((await api('get', `/items/${itemId}/idocs`)).data as { url: string }[])[0]!.url).pathname;
  for (const viewport of [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'phone', width: 390, height: 844 },
  ]) {
    const client = await browser.newContext({
      viewport: { width: viewport.width, height: viewport.height },
      locale: 'he-IL',
    });
    const cp = await client.newPage();
    await cp.goto(`${WEB_URL}${url}`);
    await expect(cp.getByTestId('idoc-page')).toBeVisible();
    await scan(cp, `idocs:public-${viewport.name}`);
    await client.close();
  }
});

/** The page's width beyond the window: 0 = no sideways scroll (a wide data table scrolls inside its own box). */
const overflowX = (page: Page) =>
  page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));

test('item templates: save, apply, the list and the editor', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page);
  const { boardId, itemId } = await boardFixture(page);
  const { headers } = await ownerContext(page);
  await page.request.post(`/api/v1/items/${itemId}/subitems`, { headers, data: { name: 'שלב ראשון' } });
  const tpl = (await (
    await page.request.post(`/api/v1/items/${itemId}/save-as-template`, { headers, data: { name: 'תבנית נגישות' } })
  ).json()) as { id: string };
  for (const theme of ['light', 'dark'] as const) {
    await page.goto(`/a/demo/b/${boardId}`);
    await setTheme(page, theme);
    const row = page.locator('[data-testid="item-row"][data-item-name="Alpha"]');
    await row.hover();
    await row
      .getByRole('button', { name: /^פעולות ל/ })
      .first()
      .click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'שמירה כתבנית' }).click();
    await expect(page.getByTestId('item-template-save-dialog')).toBeVisible();
    await scan(page, `item-templates:save-${theme}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('board-new-item-more').click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'תבנית נגישות' }).click();
    await expect(page.getByTestId('item-template-preview')).toBeVisible();
    await scan(page, `item-templates:apply-${theme}`);
    await page.keyboard.press('Escape');
    await page.getByTestId('board-new-item-more').click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'ניהול התבניות…' }).click();
    await expect(page.getByTestId('item-template-manage')).toBeVisible();
    await scan(page, `item-templates:manage-${theme}`);
    await page.getByTestId('item-template-edit').first().click();
    await expect(page.getByTestId('item-template-editor')).toBeVisible();
    await page.getByTestId('item-template-node').nth(1).click();
    await scan(page, `item-templates:editor-${theme}`);
  }
  expect(tpl.id).toBeTruthy();
});

test('reflow: at 320 CSS px wide (200% zoom) no screen scrolls sideways', async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 320, height: 640 });
  for (const path of ['/login', '/signup']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    expect(await overflowX(page), path).toBe(0);
  }
  await signIn(page);
  const { boardId, itemId } = await boardFixture(page);
  for (const path of [
    '/a/demo',
    '/a/demo/inbox',
    '/a/demo/my-work',
    '/a/demo/profile',
    '/a/demo/admin',
    '/a/demo/help',
    `/a/demo/b/${boardId}`,
    `/a/demo/b/${boardId}/i/${itemId}`,
  ]) {
    await page.goto(path);
    await page.waitForLoadState('networkidle').catch(() => undefined);
    await page.waitForTimeout(300);
    expect(await overflowX(page), path).toBe(0);
  }
});

/**
 * Text spacing (WCAG 1.4.12): with the user's spacing — line height 1.5, letters 0.12em, words 0.16em
 * paragraphs 2em after — no screen scrolls sideways, and no text is cut off vertically by a box that hides its
 * overflow (a button, a tab, a label, a heading, a cell, a chip). Ellipsis truncation on one line is by design (the
 * full text is in its tooltip) and not counted.
 */
const TEXT_SPACING = `*:not(svg *) { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
p { margin-bottom: 2em !important; }`;

const clippedText = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(
        'button, [role="tab"], [role="button"], label, h1, h2, h3, h4, th, [role="columnheader"], [role="gridcell"], .label-tag',
      ),
    )) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || !el.textContent?.trim()) continue;
      const s = getComputedStyle(el);
      const hides = ['hidden', 'clip'].includes(s.overflowY) || ['hidden', 'clip'].includes(s.overflow);
      if (hides && el.scrollHeight > el.clientHeight + 2)
        out.push(
          `${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 40)}" ${el.clientHeight}<${el.scrollHeight}`,
        );
    }
    return out.slice(0, 20);
  });

for (const [label, width, height] of [
  ['desktop', 1280, 900],
  ['phone', 390, 844],
] as const)
  test(`text spacing (1.4.12), ${label}: nothing scrolls sideways or is cut off`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width, height });
    await page.goto('/login');
    await page.addStyleTag({ content: TEXT_SPACING });
    expect(await overflowX(page), 'login').toBe(0);
    expect(await clippedText(page), 'login').toEqual([]);
    await signIn(page);
    const { boardId, itemId } = await boardFixture(page);
    for (const path of [
      '/a/demo',
      '/a/demo/profile',
      '/a/demo/admin',
      `/a/demo/b/${boardId}`,
      `/a/demo/b/${boardId}/i/${itemId}`,
    ]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle').catch(() => undefined);
      await page.addStyleTag({ content: TEXT_SPACING });
      await page.waitForTimeout(300);
      expect(await overflowX(page), path).toBe(0);
      expect(await clippedText(page), path).toEqual([]);
    }
  });
