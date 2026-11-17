// SPDX-License-Identifier: AGPL-3.0-only
import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, openNewBoard, signIn } from './helpers';

/**
 * M6 stage 7 — a board webhook added in the automations screen: the URL (a stand-in for Make's custom webhook)
 * answers the challenge, and creating an item sends it a signed delivery through the real queue.
 */
let server: Server;
let url: string;
const received: { headers: Record<string, string | string[] | undefined>; body: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any

test.beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      res.writeHead(200, { 'content-type': 'application/json' });
      if (body.challenge) return res.end(JSON.stringify({ challenge: body.challenge }));
      received.push({ headers: req.headers, body });
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/make`;
});
test.afterAll(() => new Promise((r) => server.close(r)));

test('add a board webhook, get a signed delivery when an item is created', async ({ page }) => {
  test.setTimeout(90_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const run = Date.now().toString(36);
  await openNewBoard(page);
  await page.getByLabel('שם הבורד').fill(`הוק ${run}`);
  await page.getByRole('button', { name: 'יצירת בורד' }).click();

  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-webhooks').click();
  await page.getByTestId('webhook-add').click();
  await page.getByTestId('webhook-url').fill(url);
  await page.getByTestId('webhook-save').click(); // default event: item created
  const row = page.locator('[data-testid="webhook-row"]', { hasText: 'נוצר פריט' });
  await expect(row).toBeVisible();
  await row.getByText('הצגה').click();
  const secret = (await row.getByTestId('webhook-secret').textContent())!.trim();
  expect(secret).toMatch(/^[0-9a-f]{48}$/);
  await page.getByRole('button', { name: 'סגירת החלון' }).last().click();

  const add = page.getByPlaceholder(/\+ הוספת/).first();
  await add.fill(`פריט ${run}`);
  await add.press('Enter');
  await expect
    .poll(() => received.find((r) => r.body.event?.itemName === `פריט ${run}`), { timeout: 30_000 })
    .toBeTruthy();
  const hit = received.find((r) => r.body.event?.itemName === `פריט ${run}`)!;
  expect(hit.body.event).toMatchObject({ type: 'item_created' });
  expect(String(hit.headers['x-bines-signature'])).toMatch(/^sha256=[0-9a-f]{64}$/);

  // The log shows it delivered.
  await page.getByTestId('board-automations').click();
  await page.getByTestId('auto-tab-webhooks').click();
  await row.getByTestId('webhook-log').click();
  await expect(row.locator('[data-testid="webhook-delivery"][data-status="delivered"]').first()).toBeVisible();
  await row.getByTestId('webhook-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row).toHaveCount(0);
});
