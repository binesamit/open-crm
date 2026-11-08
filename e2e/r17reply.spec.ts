// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Prod bug "adding a reply to an update — broke": the reporter pasted a few Hebrew lines, console errors and a ~10 KB
 * GlitchTip event JSON into a reply and it did not send (a bare 400 the composer never showed). The fixture is
 * exactly what was pasted. Pasting it into a reply sends it; a refused send shows an error toast and keeps the text.
 */
const PASTED = readFileSync(new URL('./fixtures/r17-failed-update.txt', import.meta.url), 'utf8');

const setup = async (page: Page) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post('/api/v1/boards', { headers, data: { name: `R17 ${Date.now()}`, workspace_id: ws } })
  ).json()) as { id: string };
  const item = (await (
    await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'פריט לוג' } })
  ).json()) as { id: string };
  await page.request.post(`/api/v1/items/${item.id}/updates`, {
    headers,
    data: { body: 'החיבור לmake מראה חיבור צולח אבל בזרימות הוא נכשל' },
  });
  await page.goto(`/a/demo/b/${board.id}/i/${item.id}?tab=updates`);
  const card = page.getByTestId('update-entry').first();
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'תגובה' }).first().click();
  const box = page.getByLabel('כתבו תגובה…');
  await expect(box).toBeVisible();
  await box.click();
  // A real clipboard paste (text/plain), as Ctrl+V of the copied log.
  await box.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PASTED);
  await expect(box).toContainText('dadf94dcefb144ecaf3f41c24ee03292');
  return { box };
};

test('a pasted log (Hebrew, console errors, GlitchTip JSON) is sent as a reply', async ({ page }) => {
  const { box } = await setup(page);
  const sent = page.waitForResponse(
    (r) => /\/updates\/[^/]+\/replies$/.test(r.url()) && r.request().method() === 'POST',
  );
  await page.getByTestId('composer-send').last().click();
  expect((await sent).status()).toBe(200);
  await expect(box).toBeHidden();
  const thread = page.getByTestId('update-entry');
  await expect(thread.filter({ hasText: 'זה מהגליץ' }).last()).toBeVisible();
  await expect(thread.filter({ hasText: '"event_id": "dadf94dcefb144ecaf3f41c24ee03292"' }).last()).toBeVisible();
});

test('a refused reply shows an error toast and keeps the text', async ({ page }) => {
  const { box } = await setup(page);
  await page.route(/\/api\/v1\/updates\/[^/]+\/replies$/, (route) =>
    route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'validation_failed', message: 'Request validation failed', request_id: 'req_e2e' },
      }),
    }),
  );
  await page.getByTestId('composer-send').last().click();
  await expect(page.locator('[data-testid="toast"][role="alert"]')).toBeVisible();
  // Nothing lost: the text is still in the reply box (and its draft), ready to send again.
  await expect(box).toBeVisible();
  await expect(box).toContainText('dadf94dcefb144ecaf3f41c24ee03292');
  await page.unroute(/\/api\/v1\/updates\/[^/]+\/replies$/);
  await page.getByTestId('composer-send').last().click();
  await expect(box).toBeHidden();
});
