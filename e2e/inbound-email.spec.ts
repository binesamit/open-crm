// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Incoming email: the owner sets the platform's inbound domain (owner console API); it is on in every
 * account by default, here turned off first so an admin turns it on in Administration → Connections (who may send:
 * some domains), the item card's ⋯ menu has "email to this item"
 * with an address to copy and replace (our own confirm dialog, never a browser one), and the board menu has the
 * board's address. Delivery itself (the signed webhook → an update / a new item) is covered by the API tests.
 */
const DOMAIN = 'in.e2e.test';

test('incoming email: platform domain, account card, item and board addresses', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  try {
    expect(
      (
        await page.request.patch('/api/v1/platform/settings', { headers, data: { email: { inbound_domain: DOMAIN } } })
      ).ok(),
    ).toBe(true);
    expect(
      (
        await page.request.patch('/api/v1/accounts/me', {
          headers,
          data: { settings: { inbound_email: { enabled: false } } },
        })
      ).ok(),
    ).toBe(true);
    const ws = (
      (await (await page.request.get('/api/v1/workspaces', { headers })).json()) as { data: { id: string }[] }
    ).data[0]!.id;
    const board = (await (
      await page.request.post('/api/v1/boards', {
        headers,
        data: { name: `מייל נכנס ${Date.now()}`, workspace_id: ws },
      })
    ).json()) as { id: string };
    const item = (await (
      await page.request.post(`/api/v1/boards/${board.id}/items`, { headers, data: { name: 'הצעת מחיר ללקוח' } })
    ).json()) as { id: string };

    // Off in the account: the item card's ⋯ menu has no "email to this item".
    await page.goto(`/a/demo/b/${board.id}/i/${item.id}?tab=updates`);
    const card = page.getByRole('dialog', { name: 'הצעת מחיר ללקוח' });
    await expect(card.getByTestId('rich-editor').first()).toBeVisible();
    await card.getByTestId('card-more').click();
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByTestId('item-inbound-address')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Administration → Connections: on, only some domains.
    await page.goto('/a/demo/admin/connections');
    const settings = page.getByTestId('inbound-email-settings');
    await settings.getByTestId('inbound-email-enabled').click();
    await settings.getByRole('radio', { name: 'דומיינים מסוימים' }).click();
    await expect(settings.getByTestId('inbound-email-save')).toBeDisabled();
    await settings.getByTestId('inbound-email-domains').fill('client.co.il');
    await settings.getByTestId('inbound-email-save').click();
    await expect(settings.getByTestId('inbound-email-save')).toBeDisabled();

    // The item's address: made on demand, copied, replaced after our own confirm dialog.
    await page.goto(`/a/demo/b/${board.id}/i/${item.id}?tab=updates`);
    await expect(card.getByTestId('rich-editor').first()).toBeVisible();
    await card.getByTestId('card-more').click();
    await page.getByTestId('item-inbound-address').click();
    const itemDialog = page.getByRole('dialog', { name: 'כתובת מייל לפריט' });
    await itemDialog.getByTestId('inbound-address-make').click();
    const value = itemDialog.getByTestId('inbound-address-value');
    await expect(value).toHaveText(new RegExp(`^item-[a-z0-9]{24}@${DOMAIN.replace(/\./g, '\\.')}$`));
    const first = await value.textContent();
    await itemDialog.getByTestId('inbound-address-copy').click();
    await itemDialog.getByTestId('inbound-address-rotate').click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'החלפה' }).click();
    await expect(value).not.toHaveText(first!);

    // The board menu: the board's address.
    await page.goto(`/a/demo/b/${board.id}`);
    await page.getByTestId('board-more').first().click();
    await page.getByTestId('board-inbound-address').click();
    const dialog = page.getByRole('dialog', { name: 'כתובת מייל ללוח' });
    await dialog.getByTestId('inbound-address-make').click();
    await expect(dialog.getByTestId('inbound-address-value')).toHaveText(/^board-[a-z0-9]{24}@/);
  } finally {
    // Back to the defaults (off on the platform, on in the account), for the other specs.
    await page.request.patch('/api/v1/platform/settings', { headers, data: { email: { inbound_domain: null } } });
    await page.request.patch('/api/v1/accounts/me', {
      headers,
      data: { settings: { inbound_email: { enabled: true, senders: 'anyone', domains: [] } } },
    });
  }
});
