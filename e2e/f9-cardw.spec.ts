// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * F9 cardw: the item card's width. A handle on its inner edge (facing the board)
 * drags it between the account's min / max; the width is the user's (server, every device) and is kept for every
 * item and subitem; arrows on the focused handle resize it; a double click or ⋯ → reset goes back to the account's
 * default width (Administration → General → defaults). On a phone the card is full screen, with no handle.
 */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
const width = async (page: Page) => Math.round((await page.getByTestId('item-card').boundingBox())!.width);

test('drag, keys, double click, reset, admin default — items and subitems; none on a phone', async ({ page }) => {
  forbidNativeDialogs(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await signIn(page);
  const { headers } = await ownerContext(page);
  // A known start: no width of my own, the account's defaults.
  await page.request.put('/api/v1/me/appearance', { headers, data: { card_width: null } });
  const before = (
    (await (await page.request.get('/api/v1/accounts/me', { headers })).json()) as {
      settings: { defaults: { card_width_pct: number; card_min_px: number; card_max_pct: number } };
    }
  ).settings.defaults;
  await page.request.patch('/api/v1/accounts/me', {
    headers,
    data: { settings: { defaults: { card_width_pct: 40, card_min_px: 380, card_max_pct: 90 } } },
  });
  try {
    const ws = (
      (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] }
    ).data[0]!;
    const tag = uid();
    const board = (await (
      await page.request.post('/api/v1/boards', { headers, data: { name: `רוחב כרטיס ${tag}`, workspace_id: ws.id } })
    ).json()) as { id: string };
    const item = (await (
      await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: `פריט ${tag}` } })
    ).json()) as { id: string };
    const sub = (await (
      await page.request.post(`/api/v1/items/${item.id}/subitems`, { headers, data: { name: `תת ${tag}` } })
    ).json()) as { id: string };

    // The default: 40% of 1600 = 640px.
    await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
    const card = page.getByTestId('item-card');
    await expect(card).toBeVisible();
    await expect.poll(() => width(page)).toBe(640);
    const handle = card.getByTestId('card-resize');
    await expect(handle).toHaveAttribute('role', 'separator');
    await expect(handle).toHaveAttribute('aria-valuenow', '640');
    await expect(handle).toHaveAttribute('aria-valuemin', '380');
    await expect(handle).toHaveAttribute('aria-valuemax', '1440');

    // Drag the inner edge (RTL: the card is on the right, its inner edge on the left) 200px into the board.
    const box = (await handle.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    const saved = page.waitForResponse((r) => r.url().endsWith('/me/appearance') && r.request().method() === 'PUT');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x - 100, y, { steps: 5 });
    await page.mouse.move(x - 200, y, { steps: 5 });
    await page.mouse.up();
    expect((await saved).status()).toBe(200);
    await expect.poll(() => width(page)).toBe(840);
    await expect(card).toBeVisible(); // the drag did not close the card

    // Past the max: stops at 90% (1440px); the board keeps showing.
    await page.mouse.move(x - 200, y);
    await page.mouse.down();
    await page.mouse.move(0, y, { steps: 8 });
    await page.mouse.up();
    await expect.poll(() => width(page)).toBe(1440);

    // Keys: focus the handle — ArrowRight (RTL: towards the card) narrows, Home = the min.
    await handle.focus();
    await page.keyboard.press('Home');
    await expect.poll(() => width(page)).toBe(380);
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => width(page)).toBe(396);
    await expect(handle).toHaveAttribute('aria-valuenow', '396');
    // Saved (after the keys stop), for every device.
    await expect
      .poll(
        async () =>
          ((await (await page.request.get('/api/v1/me/appearance', { headers })).json()) as { card_width: number })
            .card_width,
      )
      .toBe(396);

    // The same width for a subitem's card (same component), and after a reload.
    await page.goto(`/a/demo/b/${board.id}/i/${sub.id}`);
    await expect(page.getByTestId('item-card')).toBeVisible();
    await expect.poll(() => width(page)).toBe(396);

    // A smaller window re-clamps a wide width: drag wide, then shrink the window.
    await page.keyboard.press('Escape');
    await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
    await page.getByTestId('card-resize').focus();
    await page.keyboard.press('End');
    await expect.poll(() => width(page)).toBe(1440);
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect.poll(() => width(page)).toBe(880); // 1000 − 120
    await page.setViewportSize({ width: 1600, height: 900 });

    // Double click = the default again.
    await page.getByTestId('card-resize').dblclick();
    await expect.poll(() => width(page)).toBe(640);

    // ⋯ → reset width (disabled while the default is in use).
    await page.getByTestId('card-resize').focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => width(page)).toBe(656);
    await page.waitForTimeout(600);
    // Another step, its save still waiting for the keys to stop: the reset cancels it (it never lands afterwards).
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => width(page)).toBe(672);
    await page.getByTestId('card-more').click();
    await page.getByTestId('card-width-reset').click();
    await expect.poll(() => width(page)).toBe(640);
    await page.waitForTimeout(600);
    await expect.poll(() => width(page)).toBe(640);
    expect(
      ((await (await page.request.get('/api/v1/me/appearance', { headers })).json()) as { card_width: number | null })
        .card_width,
    ).toBeNull();
    await page.getByTestId('card-more').click();
    await expect(page.getByTestId('card-width-reset')).toBeDisabled();
    await page.keyboard.press('Escape');

    // The account default (admin): "wide" = 55% → 880px.
    await page.goto('/a/demo/admin/general');
    await page.getByTestId('admin-card-width-wide').click();
    await expect(page.getByTestId('admin-card-width-pct')).toHaveValue('55');
    await page.getByTestId('admin-card-min-px').fill('500');
    await page.getByTestId('admin-card-min-px').press('Enter');
    await page.goto(`/a/demo/b/${board.id}/i/${item.id}`);
    await expect.poll(() => width(page)).toBe(880);
    await expect(page.getByTestId('card-resize')).toHaveAttribute('aria-valuemin', '500');

    // A phone: full screen, no handle.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('item-card')).toBeVisible();
    await expect(page.getByTestId('card-resize')).toHaveCount(0);
    await expect.poll(() => width(page)).toBe(390);
  } finally {
    await page.request.put('/api/v1/me/appearance', { headers, data: { card_width: null } });
    await page.request.patch('/api/v1/accounts/me', { headers, data: { settings: { defaults: before } } });
  }
});
