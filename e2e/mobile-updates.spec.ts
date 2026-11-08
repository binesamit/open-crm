// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Locator, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod (product owner: "on a phone the update's buttons move sideways off the screen"): the update composer's row
 * (attach / gallery / secret / send) wrapped in nothing, so on a phone the send button stuck out past the composer and
 * the whole page scrolled sideways. At 390 and 320 CSS px, right-to-left and left-to-right: the page never scrolls
 * sideways, and every button of the composer, of a reply's composer and of an update stays inside the screen, at
 * least 24×24.
 */
const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `נייד ${Date.now()}`, workspace_id: ws } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'עדכונים בטלפון' } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/items/${item.id}/updates`, {
    headers,
    data: { body: 'עדכון ארוך לבדיקה של מסך צר, עם מילים רבות שעוברות לשורה הבאה בלי לדחוף כלום הצידה' },
  });
  return `/a/demo/b/${board.id}/i/${item.id}?tab=updates`;
};

/** The page's width beyond the window (0 = no sideways scroll). */
const overflowX = (page: Page) =>
  page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));

/** Every visible button inside `scope` lies within the window and is at least 24×24 (WCAG 2.5.8). */
const buttonsFit = async (page: Page, scope: Locator, what: string) => {
  const width = page.viewportSize()!.width;
  const boxes = await scope.locator('button:visible').evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return {
        label: el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
        l: r.left,
        r: r.right,
        w: r.width,
        h: r.height,
      };
    }),
  );
  expect(boxes.length, what).toBeGreaterThan(0);
  const bad = boxes
    .filter((b) => b.l < -0.5 || b.r > width + 0.5 || Math.min(b.w, b.h) < 23.5)
    .map((b) => `"${b.label}" ${Math.round(b.l)}..${Math.round(b.r)} ${Math.round(b.w)}x${Math.round(b.h)}`);
  expect(bad, `${what}: off screen or under 24px (window ${width})`).toEqual([]);
};

for (const width of [390, 320])
  for (const dir of ['rtl', 'ltr'] as const)
    test(`${width}px ${dir}: the update composer, a reply and an update fit the screen`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height: 800 });
      const path = await setup(page);
      await page.goto(path);
      if (dir === 'ltr') await page.evaluate(() => document.documentElement.setAttribute('dir', 'ltr'));
      const entry = page.getByTestId('update-entry').first();
      await expect(entry).toBeVisible();

      // The composer, opened (its row of buttons shows).
      await page
        .getByRole('textbox', { name: /כתבו עדכון/ })
        .first()
        .click();
      const row = page.getByTestId('composer-actions').first();
      await expect(row).toBeVisible();
      await expect(page.getByTestId('composer-send').first()).toBeVisible();
      await buttonsFit(page, row, 'composer');
      expect(await overflowX(page), 'composer').toBe(0);

      // An update's own buttons.
      await buttonsFit(page, entry, 'update');

      // A reply's composer.
      await entry.getByRole('button', { name: 'תגובה' }).first().click();
      await expect(page.getByLabel('כתבו תגובה…')).toBeVisible();
      await buttonsFit(page, page.getByTestId('composer-actions').last(), 'reply composer');
      expect(await overflowX(page), 'reply').toBe(0);
    });
