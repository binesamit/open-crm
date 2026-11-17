// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * r16motion (product owner — "subtle things only, no page transitions"):
 * - profile → appearance → "Animations": by device (default) / full / reduced / off → <html data-motion>, saved for
 *   the user; off removes every transition of the motion classes, reduced keeps fades but plays no exit;
 * - with full, a dialog closes at once (gone from the page) and a ghost copy fades out over its spot, then goes.
 * The suite runs with reducedMotion: 'reduce' (playwright.config.ts) — "by device" = reduced, so no other test meets a
 * ghost; this spec picks its modes explicitly.
 */
const api = (path: string) => `/api/v1${path}`;

/**
 * Records every exit ghost added to <body> (they live ~220ms — too short to poll for). The mouse goes to the corner
 * first: a tooltip / hover card under it would leave (and play) a ghost of its own when the dialog opens.
 */
const watchGhosts = async (page: Page) => {
  await page.mouse.move(1, 1);
  await page.evaluate(() => {
    const w = window as unknown as { __ghosts: string[] };
    w.__ghosts = [];
    new MutationObserver((list) => {
      for (const m of list)
        m.addedNodes.forEach((n) => {
          if (n instanceof HTMLElement && n.hasAttribute('data-motion-ghost')) w.__ghosts.push(n.className);
        });
    }).observe(document.body, { childList: true });
  });
};
const ghosts = (page: Page) => page.evaluate(() => (window as unknown as { __ghosts: string[] }).__ghosts);

/** The keyboard-shortcuts dialog (`?`), closed with Esc. */
const openAndCloseDialog = async (page: Page) => {
  await page.keyboard.press('?');
  const shortcuts = page.getByTestId('shortcuts');
  await expect(shortcuts).toBeVisible();
  // A dialog gone within 40ms of mounting plays no exit (a re-render, StrictMode) — and Playwright can be that quick.
  // Not a fixed wait: the dialog's entrance has finished (its CSS animations / transitions, if any), and it has been
  // on screen for two frames past 60ms of page time.
  await expect
    .poll(() =>
      shortcuts.evaluate((el) => {
        const root = (el.closest('[data-modal-root]') ?? el.closest('.anim-scrim') ?? el) as HTMLElement;
        const w = window as unknown as { __shownAt?: { el: Element; at: number } };
        if (w.__shownAt?.el !== root) w.__shownAt = { el: root, at: performance.now() };
        const entering = root.getAnimations({ subtree: true }).some((a) => a.playState === 'running');
        return !entering && performance.now() - w.__shownAt.at > 60;
      }),
    )
    .toBe(true);
  await page.keyboard.press('Escape');
  // Removed at once — the exit never keeps the real dialog around.
  await expect(page.getByTestId('shortcuts')).toHaveCount(0);
};

test.afterEach(async ({ page }) => {
  const { headers } = await ownerContext(page);
  await page.request.put(api('/me/appearance'), { headers: { origin: headers.origin }, data: { motion: null } });
  await page.evaluate(() => localStorage.removeItem('bines:appearance'));
});

test('the animations setting: by device by default, off and reduced apply live and are saved', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/profile?tab=appearance');
  await expect(page.getByTestId('motion-picker')).toBeVisible();
  // By device (the suite emulates prefers-reduced-motion: reduce).
  await expect(page.getByTestId('motion-system')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');

  await page.getByTestId('motion-off').click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'off');
  await expect
    .poll(async () => ((await (await page.request.get(api('/me/appearance'))).json()) as { motion: string }).motion)
    .toBe('off');
  await watchGhosts(page);
  await page.keyboard.press('?');
  const panel = page.getByTestId('shortcuts').locator('xpath=ancestor::*[contains(@class,"anim-dialog")]');
  await expect(panel).toBeVisible();
  // Off: no transition on the motion classes at all.
  expect(await panel.evaluate((el) => getComputedStyle(el).transitionDuration)).toMatch(/^0s(, 0s)*$/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts')).toHaveCount(0);
  expect(await ghosts(page)).toEqual([]);

  await page.getByTestId('motion-reduced').click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await openAndCloseDialog(page);
  // Reduced: no exits either.
  expect(await ghosts(page)).toEqual([]);

  // A reload keeps it (this device's copy, then the server's).
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
});

test('full: a dialog is removed at once and a ghost fades out over its spot; the tab bar slides', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/profile?tab=appearance');
  await page.getByTestId('motion-full').click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  // Saved before going on: a profile refetch answered before the save would put the old mode back.
  await expect
    .poll(async () => ((await (await page.request.get(api('/me/appearance'))).json()) as { motion: string }).motion)
    .toBe('full');
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'full');
  // The profile's tabs have one sliding underline.
  await expect(page.locator('[data-tab-indicator]').first()).toBeVisible();

  await watchGhosts(page);
  await openAndCloseDialog(page);
  // One ghost of the dialog (backdrop + panel), with the exit classes, inert and without test ids…
  await expect.poll(async () => (await ghosts(page)).filter((c) => c.includes('exit-scrim'))).toHaveLength(1);
  // …and nothing else left the page meanwhile (a stray tooltip would show here).
  expect(await ghosts(page)).toHaveLength(1);
  // …gone after its 150ms exit.
  await expect(page.locator('[data-motion-ghost]')).toHaveCount(0);
  // The page under it is usable right away: the dialog opens again.
  await page.keyboard.press('?');
  await expect(page.getByTestId('shortcuts')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts')).toHaveCount(0);
});
