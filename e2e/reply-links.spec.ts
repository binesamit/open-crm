// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * Prod (s37reply): opening an update or a reply from anywhere (bell, inbox, search, a copied link
 * email / push) shows only that update's thread — the update and all its replies. A reply link opens its parent
 * thread scrolled to the reply, which is marked (the anchor). "All updates" goes back to every update; the link
 * survives a reload and works on a phone.
 */
type Seeded = { board: string; item: string; first: string; second: string; reply: string; tag: string };

const seed = async (page: Page): Promise<Seeded> => {
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (
    (await (
      await page.request.post('/api/v1/boards', { headers, data: { name: `S37 ${tag}`, workspace_id: ws } })
    ).json()) as { id: string }
  ).id;
  const item = (
    (await (
      await page.request.post(`/api/v1/boards/${board}/items`, { headers, data: { name: `שרשור ${tag}` } })
    ).json()) as { id: string }
  ).id;
  const post = async (body: string) =>
    (
      (await (await page.request.post(`/api/v1/items/${item}/updates`, { headers, data: { body } })).json()) as {
        id: string;
      }
    ).id;
  const first = await post(`עדכון ראשון ${tag}`);
  const second = await post(`עדכון שני ${tag}`);
  // Enough replies that the linked one starts below the fold of the card.
  let reply = '';
  for (let i = 1; i <= 12; i++) {
    const r = (await (
      await page.request.post(`/api/v1/updates/${first}/replies`, { headers, data: { body: `תגובה ${i} ${tag}` } })
    ).json()) as { id: string };
    if (i === 10) reply = r.id;
  }
  return { board, item, first, second, reply, tag };
};

const itemUrl = (s: Seeded, update?: string) =>
  `/a/demo/b/${s.board}/i/${s.item}?tab=updates${update ? `&update=${update}` : ''}`;

test.beforeEach(async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
});

test('a reply link opens only its thread, scrolled to the marked reply; "all updates" goes back', async ({ page }) => {
  const s = await seed(page);
  await page.goto(itemUrl(s, s.reply));
  const focus = page.getByTestId('update-focus');
  await expect(focus).toBeVisible();
  // Only the first update's thread: its update and replies, not the second update.
  await expect(focus).toContainText(`עדכון ראשון ${s.tag}`);
  await expect(page.getByTestId('item-card')).not.toContainText(`עדכון שני ${s.tag}`);
  const anchored = page.locator(`[data-update-id="${s.reply}"]`);
  await expect(anchored).toHaveAttribute('data-anchored', 'true');
  await expect(anchored).toBeInViewport();
  await expect(page.locator('[data-anchored="true"]')).toHaveCount(1);

  // A reload keeps the thread (the link is in the URL).
  await page.reload();
  await expect(page.getByTestId('update-focus')).toBeVisible();
  await expect(page.locator(`[data-update-id="${s.reply}"]`)).toHaveAttribute('data-anchored', 'true');

  // "All updates": every update again, and the link leaves the URL.
  await page.getByTestId('update-focus-all').click();
  await expect(page.getByTestId('update-focus')).toHaveCount(0);
  await expect(page.getByTestId('item-card')).toContainText(`עדכון שני ${s.tag}`);
  await expect(page).not.toHaveURL(/[?&]update=/);
});

test('a top update link shows that update with all its replies and no anchor', async ({ page }) => {
  const s = await seed(page);
  await page.goto(itemUrl(s, s.second));
  const focus = page.getByTestId('update-focus');
  await expect(focus).toContainText(`עדכון שני ${s.tag}`);
  await expect(page.getByTestId('item-card')).not.toContainText(`עדכון ראשון ${s.tag}`);
  await expect(page.locator('[data-anchored="true"]')).toHaveCount(0);

  await page.goto(itemUrl(s, s.first));
  await expect(page.getByTestId('update-focus').getByTestId('update-entry')).toHaveCount(13);
});

test('a link to a deleted update says so and offers all updates', async ({ page }) => {
  const s = await seed(page);
  await page.goto(itemUrl(s, '01JZZZZZZZZZZZZZZZZZZZZZZZ'));
  await expect(page.getByTestId('update-focus-missing')).toBeVisible();
  await page.getByTestId('update-focus-all').click();
  await expect(page.getByTestId('item-card')).toContainText(`עדכון ראשון ${s.tag}`);
});

test('an update has "copy link" in its menu', async ({ page }) => {
  const s = await seed(page);
  await page.goto(itemUrl(s));
  await page.getByTestId('update-entry').first().getByRole('button', { name: 'פעולות לעדכון' }).click();
  await expect(page.getByRole('menuitem', { name: 'העתקת קישור' })).toBeVisible();
});

test('search: an update hit opens its thread', async ({ page }) => {
  const s = await seed(page);
  await page.goto(`/a/demo/b/${s.board}`);
  await page.locator('body').click();
  await page.keyboard.press('Control+b');
  const palette = page.getByTestId('search-palette');
  await expect(palette).toBeVisible();
  await page.mouse.move(1, 1);
  await page.getByTestId('search-input').fill(`עדכון שני ${s.tag}`);
  await palette.getByTestId('search-result').and(page.locator('[data-kind="update"]')).first().click();
  await expect(page).toHaveURL(new RegExp(`update=${s.second}`));
  await expect(page.getByTestId('update-focus')).toContainText(`עדכון שני ${s.tag}`);
});

test('inbox: a mention in a reply opens the parent thread at that reply', async ({ page, browser }) => {
  const s = await seed(page);
  const { headers, meId } = await ownerContext(page);
  const mate = await newTeammate(page, browser);
  const r = (await (
    await mate.request.post(`/api/v1/updates/${s.second}/replies`, {
      headers,
      data: { body: `[@Owner](user:${meId}) שאלה בתגובה ${s.tag}` },
    })
  ).json()) as { id: string };
  await page.goto('/a/demo/inbox');
  const entry = page.getByTestId('inbox-entry').filter({ hasText: `שאלה בתגובה ${s.tag}` });
  await entry.getByTestId('inbox-open').click();
  await expect(page).toHaveURL(new RegExp(`update=${r.id}`));
  await expect(page.getByTestId('update-focus')).toContainText(`עדכון שני ${s.tag}`);
  await expect(page.locator(`[data-update-id="${r.id}"]`)).toHaveAttribute('data-anchored', 'true');
  await mate.context().close();
});

test('phone: the link opens the thread full screen at the reply', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await seed(page);
  await page.goto(itemUrl(s, s.reply));
  await expect(page.getByTestId('update-focus')).toBeVisible();
  const anchored = page.locator(`[data-update-id="${s.reply}"]`);
  await expect(anchored).toBeInViewport();
  await page.getByTestId('update-focus-all').click();
  await expect(page.getByTestId('item-card')).toContainText(`עדכון שני ${s.tag}`);
});

// s37reply2 (product owner: "I click the update's time and nothing happens"): an update's or a
// reply's time opens that thread alone; a strip says one update is shown, with the way back.
test('clicking an update time opens that thread alone; a reply time anchors the reply', async ({ page }) => {
  const s = await seed(page);
  await page.goto(itemUrl(s));
  const card = page.getByTestId('item-card');
  await expect(card).toContainText(`עדכון שני ${s.tag}`);

  // The second update's time (updates come newest first; find it by its entry).
  const second = page.locator(`[data-update-id="${s.second}"]`);
  const time = second.getByTestId('update-time');
  await expect(time).toHaveCSS('cursor', 'pointer');
  await time.click();
  await expect(page).toHaveURL(new RegExp(`update=${s.second}`));
  const focus = page.getByTestId('update-focus');
  await expect(focus).toContainText(`עדכון שני ${s.tag}`);
  await expect(card).not.toContainText(`עדכון ראשון ${s.tag}`);
  const banner = page.getByTestId('update-focus-banner');
  await expect(banner).toContainText('מוצג עדכון אחד');
  await expect(banner.getByTestId('update-focus-count')).toHaveText('2');

  // Back to all, then a reply's time (keyboard): its parent thread, the reply marked and in view.
  await page.getByTestId('update-focus-all').click();
  await expect(page.getByTestId('update-focus')).toHaveCount(0);
  const replyTime = page.locator(`[data-update-id="${s.reply}"]`).getByTestId('update-time');
  await replyTime.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`update=${s.reply}`));
  await expect(page.getByTestId('update-focus')).toContainText(`עדכון ראשון ${s.tag}`);
  await expect(card).not.toContainText(`עדכון שני ${s.tag}`);
  const anchored = page.locator(`[data-update-id="${s.reply}"]`);
  await expect(anchored).toHaveAttribute('data-anchored', 'true');
  await expect(anchored).toBeInViewport();

  // The browser's back returns to all updates (the click was a new history entry).
  await page.goBack();
  await expect(page.getByTestId('update-focus')).toHaveCount(0);
  await expect(card).toContainText(`עדכון שני ${s.tag}`);
});

test('the time keeps its exact-time tip (the system tooltip, never the native one)', async ({ page }) => {
  const s = await seed(page);
  await page.goto(itemUrl(s));
  const time = page.locator(`[data-update-id="${s.first}"]`).getByTestId('update-time');
  await expect(time).not.toHaveAttribute('title', /.+/);
  await expect(time).toHaveAttribute('data-tip', /\d/);
  // The card may still be sliding in under the pointer (it moves away = the tip hides): hover again until it shows.
  await expect(async () => {
    await page.mouse.move(0, 0);
    await time.hover();
    await expect(page.locator('#system-tooltip')).toBeVisible({ timeout: 1500 });
  }).toPass();
});

test('inbox: the time opens the update alone', async ({ page, browser }) => {
  const s = await seed(page);
  const { headers, meId } = await ownerContext(page);
  const mate = await newTeammate(page, browser);
  const r = (await (
    await mate.request.post(`/api/v1/updates/${s.second}/replies`, {
      headers,
      data: { body: `[@Owner](user:${meId}) זמן בתיבה ${s.tag}` },
    })
  ).json()) as { id: string };
  await page.goto('/a/demo/inbox');
  const entry = page.getByTestId('inbox-entry').filter({ hasText: `זמן בתיבה ${s.tag}` });
  await entry.getByTestId('inbox-time').click();
  await expect(page).toHaveURL(new RegExp(`update=${r.id}`));
  await expect(page.getByTestId('update-focus-banner')).toBeVisible();
  await mate.context().close();
});

test('phone: tapping a time opens the thread with the strip', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const s = await seed(page);
  await page.goto(itemUrl(s));
  await page.locator(`[data-update-id="${s.second}"]`).getByTestId('update-time').click();
  await expect(page.getByTestId('update-focus-banner')).toBeInViewport();
  await expect(page.getByTestId('update-focus-all')).toBeInViewport();
  await expect(page.getByTestId('item-card')).not.toContainText(`עדכון ראשון ${s.tag}`);
});
