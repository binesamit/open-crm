// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * r16seen (product owner: "it works only after a refresh — it must be live, also for the
 * viewer"): the owner keeps the item open; a teammate opens it in another browser. Without any reload the owner sees
 * the teammate's avatar appear under the eye, and the teammate sees themselves there too.
 */
test('"seen by" appears live for the owner and for the viewer', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `Seen live ${Date.now()}`, workspace_id: ws } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'פריט חי' } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/items/${item.id}/updates`, { headers, data: { body: 'עדכון חי' } });
  const cardUrl = `/a/demo/b/${board.id}/i/${item.id}?tab=updates`;

  // The owner has the card open and the board's channel live; nobody saw the update yet.
  await page.goto(cardUrl);
  await expect(page.getByTestId('update-entry').first()).toBeVisible();
  await expect(page.getByTestId('board-live')).toHaveAttribute('data-live', 'on');
  await expect(page.getByTestId('seen-by')).toHaveCount(0);

  // The teammate opens it in their own browser and keeps it on screen past the 1s threshold.
  const mate = await newTeammate(page, browser, 'דנה חיה');
  const reported = mate.waitForResponse(
    (r) => r.url().includes('/api/v1/updates/views') && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await mate.goto(cardUrl);
  await expect(mate.getByText('עדכון חי')).toBeVisible();
  await expect(mate.getByTestId('board-live')).toHaveAttribute('data-live', 'on');
  expect(((await (await reported).json()) as { recorded: number }).recorded).toBe(1);

  // The owner — no reload — sees the teammate's avatar appear.
  const seen = page.getByTestId('seen-by').first();
  await expect(seen).toBeVisible({ timeout: 10_000 });
  await expect(seen).toHaveAttribute('data-count', '1');
  await seen.click();
  await expect(page.getByTestId('seen-by-list')).toContainText('דנה חיה');
  await page.keyboard.press('Escape');

  // The viewer sees themselves in the list, live as well.
  const mine = mate.getByTestId('seen-by').first();
  await expect(mine).toBeVisible({ timeout: 10_000 });
  await expect(mine).toHaveAttribute('data-count', '1');
  await mine.click();
  await expect(mate.getByTestId('seen-by-list')).toContainText('דנה חיה');
});
