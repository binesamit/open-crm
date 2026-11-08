// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * a click on an address in an email column opens our menu — Gmail, Outlook on the web, the device's
 * mail app, copy. A choice in Profile → Appearance (or the account's default) goes straight there; right-click keeps
 * the menu.
 */
const api = (path: string) => `/api/v1${path}`;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

test.afterEach(async ({ page }) => {
  const { headers } = await ownerContext(page);
  await page.request.put(api('/me/appearance'), { headers: { origin: headers.origin }, data: { email_open: null } });
  await page.request.patch(api('/accounts/me'), { headers, data: { settings: { defaults: { email_open: 'ask' } } } });
  await page.evaluate(() => localStorage.removeItem('bines:appearance'));
});

test('email column: the menu on click, a saved choice goes straight there, right-click keeps the menu', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  // External pages are not opened in the test: the calls are recorded.
  await page.addInitScript(() => {
    const w = window as unknown as { opened: string[] };
    w.opened = [];
    window.open = ((url: string) => {
      w.opened.push(String(url));
      return null;
    }) as typeof window.open;
  });
  await signIn(page);
  const { headers } = await ownerContext(page);
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as Json).data[0].id as string;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `מייל ${Date.now()}`, workspace_id: ws } })
  ).json()) as Json;
  const col = (await (
    await page.request.post(api(`/boards/${board.id}/columns`), { headers, data: { title: 'מייל', type: 'email' } })
  ).json()) as Json;
  const item = (await (
    await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: 'לקוח' } })
  ).json()) as Json;
  await page.request.put(api(`/items/${item.id}/cells/${col.id}`), {
    headers,
    data: { value: { email: 'dana@example.com' } },
  });
  const opened = () => page.evaluate(() => (window as unknown as { opened: string[] }).opened);

  await page.goto(`/a/demo/b/${board.id}`);
  const link = page.getByTestId('email-link').first();
  await expect(link).toHaveText('dana@example.com');
  await link.click();
  const menu = page.getByTestId('email-menu');
  await expect(menu).toBeVisible();
  await page.getByTestId('email-menu-gmail').click();
  await expect.poll(opened).toEqual(['https://mail.google.com/mail/?view=cm&fs=1&to=dana%40example.com']);
  // The cell's editor did not open behind the menu.
  await expect(page.getByRole('textbox', { name: 'כתובת אימייל' })).toHaveCount(0);

  // My choice: Outlook — a click goes straight there.
  await page.goto('/a/demo/profile?tab=appearance');
  await page.getByTestId('email-open-outlook').click();
  await expect(page.getByTestId('email-open-outlook')).toHaveAttribute('aria-checked', 'true');
  // Saved for me on the server (what the board adopts when it loads).
  await expect
    .poll(async () => ((await (await page.request.get(api('/me/appearance'), { headers })).json()) as Json).email_open)
    .toBe('outlook');
  await page.goto(`/a/demo/b/${board.id}`);
  await page.getByTestId('email-link').first().click();
  await expect(page.getByTestId('email-menu')).toHaveCount(0);
  await expect.poll(opened).toEqual(['https://outlook.office.com/mail/deeplink/compose?to=dana%40example.com']);
  // Right-click still offers everything.
  await page.getByTestId('email-link').first().click({ button: 'right' });
  await expect(page.getByTestId('email-menu-copy')).toBeVisible();
});
