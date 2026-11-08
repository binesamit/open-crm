// SPDX-License-Identifier: AGPL-3.0-only
import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * M2 DoD: a 10k-item board loads, scrolls at ~60fps and filters at once. Opt-in (seeds a big board in the local
 * database): `PERF=1 pnpm e2e m2-perf`.
 */
test.skip(!process.env.PERF, 'set PERF=1 to run the 10k-item performance check');
test.setTimeout(180_000);

test('10k items: load, scroll and filter', async ({ page }) => {
  const boardId = execSync('pnpm --filter @bines/api exec tsx scripts/seed-big-board.ts 10000', {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .pop()!;
  await signIn(page);

  const t0 = Date.now();
  await page.goto(`/a/demo/b/${boardId}`);
  const rows = page.getByTestId('item-row');
  await expect(rows.first()).toBeVisible({ timeout: 60_000 });
  const loadMs = Date.now() - t0;
  // Only the window is in the DOM, not 10k rows.
  expect(await rows.count()).toBeLessThan(200);

  // Scroll 120px per frame for 4 seconds and count the frames the browser managed.
  const scroll = await page.evaluate(async () => {
    const el = document.querySelector('[data-testid="board-table"]')!.parentElement!;
    const frames: number[] = [];
    await new Promise<void>((done) => {
      const start = performance.now();
      const tick = (now: number) => {
        frames.push(now);
        el.scrollTop += 120;
        if (now - start < 4000) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    const gaps = frames.slice(1).map((f, i) => f - frames[i]!);
    gaps.sort((a, b) => a - b);
    return {
      fps: (frames.length - 1) / ((frames.at(-1)! - frames[0]!) / 1000),
      p95: gaps[Math.floor(gaps.length * 0.95)]!,
      scrolled: el.scrollTop,
    };
  });

  // Filtering 10k rows in the browser: type, wait for the narrowed list.
  const t1 = Date.now();
  await page.getByTestId('toolbar-search').fill('פריט 9999');
  await expect(rows).toHaveCount(1);
  const filterMs = Date.now() - t1;

  console.warn(
    `10k board: load ${loadMs} ms · scroll ${scroll.fps.toFixed(1)} fps (p95 frame ${scroll.p95.toFixed(1)} ms, ${scroll.scrolled}px) · search ${filterMs} ms`,
  );
  expect(scroll.scrolled).toBeGreaterThan(20_000);
  expect(scroll.fps).toBeGreaterThan(50);
  expect(filterMs).toBeLessThan(1500); // includes the 200 ms typing debounce
});
