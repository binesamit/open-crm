// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * "זרימות": Administration → זרימות. An admin connects a platform through the dialog (the key is
 * write-only: only its last 4 characters come back), the connection is tested on save (an address that does not
 * answer shows an error on the card), the settings are saved, and the connection is removed. No real platform is
 * reached here — the API tests (apps/api/test/flows.test.ts) cover the adapters with fake platforms.
 */
test('flows: connect, see the test result, change settings, remove', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/admin/flows');
  await expect(page.getByTestId('admin-nav-flows')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('flows-page')).toBeVisible();

  const name = `n8n e2e ${Date.now().toString(36)}`;
  const key = 'e2e-key-0000-wxyz';
  await page.getByTestId('flow-connection-add').click();
  const dialog = page.getByTestId('flow-connection-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('flow-connection-save')).toBeDisabled();
  await page.getByTestId('flow-connection-name').fill(name);
  await page.getByTestId('flow-platform-n8n').click();
  await page.getByTestId('flow-connection-url').fill('https://n8n.e2e.invalid');
  await page.getByTestId('flow-connection-secret').fill(key);
  // Settings: open to members, alerts by bell + email.
  await page.getByTestId('flow-visibility-members').click();
  await page.getByTestId('flow-channel-bell_email').click();
  await page.getByTestId('flow-connection-save').click();
  await expect(dialog).toHaveCount(0);

  const card = page.locator(`[data-testid="flow-connection"][data-name="${name}"]`);
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-platform', 'n8n');
  // The key never comes back — only its hint.
  await expect(card).toContainText('…wxyz');
  await expect(page.locator('body')).not.toContainText(key);
  // Nothing answers at that address: the card says so.
  await expect(card.getByRole('alert')).toBeVisible();

  // Edit: the settings are kept; the interval changes.
  await card.getByTestId('flow-connection-edit').click();
  await expect(page.getByTestId('flow-visibility-members')).toHaveAttribute('aria-checked', 'true');
  await page.getByTestId('flow-setting-interval').fill('30');
  await page.getByTestId('flow-connection-save').click();
  await expect(page.getByTestId('flow-connection-dialog')).toHaveCount(0);

  // The member route shows the same screen.
  await page.goto('/a/demo/flows');
  await expect(page.locator(`[data-testid="flow-connection"][data-name="${name}"]`)).toBeVisible();

  // Remove (our confirm dialog, never the browser's).
  await page.goto('/a/demo/admin/flows');
  await page
    .locator(`[data-testid="flow-connection"][data-name="${name}"]`)
    .getByTestId('flow-connection-delete')
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /מחיקה|מחק/ })
    .click();
  await expect(page.locator(`[data-testid="flow-connection"][data-name="${name}"]`)).toHaveCount(0);
});

test('owner console: which platforms accounts may connect', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner?section=connections');
  const card = page.getByTestId('owner-flow-platforms');
  await expect(card).toBeVisible();
  const zapier = page.getByTestId('owner-flow-platform-zapier');
  await expect(zapier).toBeChecked();
  try {
    await zapier.click();
    await expect(zapier).not.toBeChecked();
    await page.goto('/a/demo/admin/flows');
    await page.getByTestId('flow-connection-add').click();
    await expect(page.getByTestId('flow-platform-zapier')).toHaveCount(0);
    await expect(page.getByTestId('flow-platform-n8n')).toBeVisible();
  } finally {
    // Back to the known state.
    await page.request.patch('/api/v1/platform/settings', {
      data: { flows: { platforms: ['n8n', 'make', 'zapier'] } },
    });
  }
});
