// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * "Seen by" on updates (fix): the owner posts an update and a reply; a teammate opens the item and
 * sees them on screen; the owner then finds the teammate's avatar under the eye, and hovering lists the name and
 * the device. The owner's own view never counts.
 */
test('the owner sees who viewed an update and from which device', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `Seen ${Date.now()}`, workspace_id: ws } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'פריט נצפה' } })
  ).json()) as { id: string };
  const update = (await (
    await page.request.post(`/api/v1/items/${item.id}/updates`, { headers, data: { body: 'עדכון לצפייה' } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/updates/${update.id}/replies`, { headers, data: { body: 'תגובה לצפייה' } });
  const cardUrl = `/a/demo/b/${board.id}/i/${item.id}?tab=updates`;

  // The owner looks first: their own update shows no viewers.
  await page.goto(cardUrl);
  await expect(page.getByTestId('update-entry').first()).toBeVisible();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('seen-by')).toHaveCount(0);

  // A teammate opens the item: both entries are on screen for over a second → one batched report.
  const mate = await newTeammate(page, browser, 'רונית צופה');
  const reported = mate.waitForResponse(
    (r) => r.url().includes('/api/v1/updates/views') && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await mate.goto(cardUrl);
  await expect(mate.getByText('עדכון לצפייה')).toBeVisible();
  const res = await reported;
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { recorded: number }).recorded).toBeGreaterThanOrEqual(1);

  // Back at the owner: the eye with the teammate's avatar; hovering lists the name and the device.
  await page.reload();
  const seen = page.getByTestId('seen-by').first();
  await expect(seen).toBeVisible();
  await expect(seen).toHaveAttribute('data-count', '1');
  await seen.hover();
  const list = page.getByTestId('seen-by-list');
  await expect(list).toBeVisible();
  await expect(list.getByTestId('seen-by-viewer')).toHaveCount(1);
  await expect(list).toContainText('רונית צופה');
  await expect(list.getByTestId('seen-by-device')).toHaveAttribute('data-device', 'desktop');
  await expect(list.getByTestId('seen-by-device')).toContainText('Chrome');

  // Tapping works too (phones have no hover): it toggles the same list.
  await page.mouse.move(0, 0);
  await expect(list).toBeHidden();
  await seen.click();
  await expect(page.getByTestId('seen-by-list')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('seen-by-list')).toBeHidden();
});
