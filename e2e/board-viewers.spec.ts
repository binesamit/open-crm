// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, newTeammate, ownerContext, signIn } from './helpers';

/**
 * r18boardviews: "who viewed the board, and how long ago". A teammate opens a board; the owner then
 * finds "צפו בבורד" in the header with the teammate among the faces, and the list shows the name and "now".
 * On a phone the same list sits in the ⋯ menu.
 */
test('the owner sees a teammate who opened the board', async ({ page, browser }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `Viewed ${Date.now()}`, workspace_id: ws } })
  ).json()) as { id: string };
  const boardUrl = `/a/demo/b/${board.id}`;

  // The owner opens it first: they are recorded too (shown as "you").
  const own = page.waitForResponse(
    (r) => r.url().includes(`/api/v1/boards/${board.id}/viewers`) && r.request().method() === 'POST',
  );
  await page.goto(boardUrl);
  expect((await own).status()).toBe(200);

  // A teammate opens the board → one report.
  const mate = await newTeammate(page, browser, 'דני צופה');
  const reported = mate.waitForResponse(
    (r) => r.url().includes(`/api/v1/boards/${board.id}/viewers`) && r.request().method() === 'POST',
    { timeout: 15_000 },
  );
  await mate.goto(boardUrl);
  const res = await reported;
  expect(res.status()).toBe(200);
  expect(((await res.json()) as { recorded: boolean }).recorded).toBe(true);

  // Back at the owner: two viewers; the teammate is the newest, "now".
  await page.reload();
  const button = page.getByTestId('board-viewers');
  await expect(button).toBeVisible();
  await expect(button).toHaveAttribute('data-count', '2');
  await button.click();
  const list = page.getByTestId('board-viewers-list');
  await expect(list).toBeVisible();
  const rows = list.getByTestId('board-viewer');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('דני צופה');
  await expect(rows.first().getByTestId('board-viewer-ago')).toHaveText('עכשיו');
  await page.keyboard.press('Escape');
  await expect(list).toBeHidden();

  // Phone: the ⋯ menu opens the same list in a dialog.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByTestId('board-more').click();
  await page.getByTestId('board-viewers-open').click();
  const dialog = page.getByTestId('board-viewers-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('board-viewer')).toHaveCount(2);
  await expect(dialog).toContainText('דני צופה');
});
