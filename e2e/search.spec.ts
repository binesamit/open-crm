// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/** M4 step 6 (07 §9.1, §9.3): Ctrl+B search everything; the Inbox with an inline reply. */
test('Ctrl+B finds an item and a board; arrows + Enter open; recent searches; the magnifier', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = `zq${Date.now().toString(36)}`;
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (
    (await (
      await page.request.post('/api/v1/boards', { headers, data: { name: `בורד ${tag}`, workspace_id: ws } })
    ).json()) as { id: string }
  ).id;
  await page.request.post(`/api/v1/boards/${board}/items`, { headers, data: { name: `פריט ${tag}` } });

  await page.locator('body').click();
  await page.keyboard.press('Control+b');
  const palette = page.getByTestId('search-palette');
  await expect(palette).toBeVisible();
  // The pointer rests where the body was clicked — its middle moves as the page grows (local data piles up);
  // keep it off the result rows, or hovering one selects it.
  await page.mouse.move(1, 1);
  await page.getByTestId('search-input').fill(tag);
  const results = palette.getByTestId('search-result');
  await expect(results.filter({ hasText: `פריט ${tag}` })).toHaveAttribute('data-kind', 'item');
  await expect(results.filter({ hasText: `בורד ${tag}` }).first()).toBeVisible();
  // Items come first: the first row is selected; ↓ moves, ↑ comes back, Enter opens.
  await expect(results.first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(results.nth(1)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`/b/${board}/i/`));
  await page.keyboard.press('Escape');

  // Reopened empty, it offers the recent search.
  await page.getByTestId('search-open').click();
  await expect(palette).toBeVisible();
  await expect(palette).toContainText('חיפושים אחרונים');
  await palette.getByTestId('search-result').filter({ hasText: tag }).first().click();
  await expect(page.getByTestId('search-input')).toHaveValue(tag);
  await page.getByTestId('search-input').fill('zz-nothing-matches-zz');
  await expect(palette.getByTestId('search-empty')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('the Inbox shows a mention and replies to it in place', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers, meId } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const tag = Date.now().toString(36);
  const board = (
    (await (
      await page.request.post('/api/v1/boards', { headers, data: { name: `תיבה ${tag}`, workspace_id: ws } })
    ).json()) as { id: string }
  ).id;
  const item = (
    (await (
      await page.request.post(`/api/v1/boards/${board}/items`, { headers, data: { name: `שאלה ${tag}` } })
    ).json()) as { id: string }
  ).id;

  const mate = await newTeammate(page, browser);
  const posted = await mate.request.post(`/api/v1/items/${item}/updates`, {
    headers,
    data: { body: `[@Owner](user:${meId}) מה דעתך על ${tag}?` },
  });
  expect(posted.status()).toBe(200);

  // The Inbox in the sidebar, with its unread count.
  await expect(page.getByTestId('inbox-count')).toBeVisible({ timeout: 3000 });
  await page.getByTestId('nav-inbox').click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('תיבת עדכונים');
  const entry = page.getByTestId('inbox-entry').filter({ hasText: `מה דעתך על ${tag}` });
  await expect(entry).toHaveAttribute('data-mention', 'true');
  await expect(entry).toContainText(`שאלה ${tag}`);
  await expect(entry).toContainText('חברת צוות');
  await page.getByTestId('inbox-mentions').click();
  await expect(entry).toBeVisible();

  await entry.getByTestId('inbox-reply').fill('נראה לי טוב');
  await entry.getByTestId('inbox-reply-send').click();
  await expect(entry.getByTestId('inbox-reply-sent')).toBeVisible();
  const thread = (await (await page.request.get(`/api/v1/items/${item}/updates`, { headers })).json()) as {
    data: { replies: { body_text: string }[] }[];
  };
  expect(thread.data[0]!.replies.map((r) => r.body_text)).toEqual(['נראה לי טוב']);

  // V: it leaves the list (and is there again under "show read"); "mark all read" empties the Inbox.
  await page.getByTestId('inbox-all').click();
  await entry.getByTestId('inbox-done').click();
  await expect(entry).toHaveCount(0);
  await page.getByTestId('inbox-show-read').check();
  await expect(entry).toHaveAttribute('data-read', 'true');
  await expect(entry.getByTestId('inbox-done')).toHaveCount(0);
  await page.getByTestId('inbox-show-read').uncheck();
  await mate.request.post(`/api/v1/items/${item}/updates`, { headers, data: { body: `עוד משהו ${tag}` } });
  await expect(page.getByTestId('inbox-entry').filter({ hasText: `עוד משהו ${tag}` })).toBeVisible();
  await page.getByTestId('inbox-read-all').click();
  await expect(page.getByTestId('inbox-empty')).toBeVisible();
  await expect(page.getByTestId('inbox-count')).toBeHidden();
  await mate.context().close();
});
