// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * Platform costs: the owner console's Costs section. The owner sets the currency with a rate of their
 * own, connects a fixed monthly fee (no provider reached — the API tests cover the provider adapters with answered
 * calls), sees it on the overview, prices a metric from the provider's suggested price, and opens the per-account view.
 */
test('owner console: costs — settings, a source, the overview, a price, by account', async ({ page }) => {
  test.setTimeout(120_000);
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner?section=costs');
  const section = page.getByTestId('owner-costs');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('costs-overview')).toBeVisible();

  // Settings: shekels, with a dollar rate of the owner's own (no rates service is called).
  await page.getByTestId('costs-tab-settings').click();
  await page.getByTestId('cost-settings-currency').fill('ILS');
  await page.getByTestId('cost-settings-fx').click();
  await page.getByTestId('cost-settings-fx-manual').click();
  await page.getByTestId('cost-settings-rate-currency').fill('USD');
  await page.getByTestId('cost-settings-rate-value').fill('3.5');
  await page.getByTestId('cost-settings-rate-add').click();
  await page.getByTestId('cost-settings-save').click();
  await expect(page.getByTestId('cost-settings-rates')).toContainText('USD');

  // Sources: the platform's own measurements are there; connect a fixed monthly fee.
  await page.getByTestId('costs-tab-sources').click();
  await expect(page.locator('[data-testid="cost-source"][data-adapter="internal"]')).toBeVisible();
  const name = `E2E fee ${Date.now()}`;
  await page.getByTestId('cost-source-new').click();
  const dialog = page.getByTestId('cost-source-dialog');
  await page.getByTestId('cost-source-adapter').click();
  await page.getByTestId('cost-source-adapter-recurring').click();
  await dialog.getByTestId('cost-source-name').fill(name);
  await dialog.getByTestId('cost-field-amount').fill('310');
  await dialog.getByTestId('cost-field-currency').fill('ILS');
  await page.getByTestId('cost-source-save').click();
  const card = page.locator('[data-testid="cost-source"][data-adapter="recurring"]', { hasText: name });
  await expect(card).toBeVisible();
  // It reads its past days at once (in the background) and says so.
  await expect(card.getByText('תקין')).toBeVisible({ timeout: 30_000 });

  // Overview: the fee is in the chart's legend and the period's total.
  await page.getByTestId('costs-tab-overview').click();
  await expect(page.getByTestId('costs-legend')).toContainText(name);
  await expect(page.getByTestId('costs-kpi-total')).not.toContainText('₪0.00');
  await page.screenshot({ path: 'e2e/screens/owner-costs-overview.png', fullPage: true });

  // Prices: a metric priced from the provider's suggested price.
  await page.getByTestId('costs-tab-prices').click();
  await page.getByTestId('cost-price-new').click();
  await page.getByTestId('cost-price-metric').click();
  await page.getByTestId('cost-price-metric-railway.cpu').click();
  await expect(page.getByTestId('cost-price-suggested')).toBeVisible();
  await page.getByTestId('cost-price-use-suggested').click();
  await expect(page.getByTestId('cost-price-value')).toHaveValue('0.000463');
  await expect(page.getByTestId('cost-price-currency')).toHaveValue('USD');
  await page.getByTestId('cost-price-save').click();
  const row = page.locator('[data-testid="cost-price-row"][data-metric="railway.cpu"]').first();
  await expect(row).toBeVisible();
  await row.getByTestId('cost-price-delete').click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /מחיקה|מחק|Delete/ })
    .click();
  await expect(page.locator('[data-testid="cost-price-row"][data-metric="railway.cpu"]')).toHaveCount(0);

  // By account: every account with its own and shared costs.
  await page.getByTestId('costs-tab-accounts').click();
  await expect(page.getByTestId('cost-account-row').first()).toBeVisible();
  await page.screenshot({ path: 'e2e/screens/owner-costs-accounts.png', fullPage: true });

  // Clean up the fee.
  await page.getByTestId('costs-tab-sources').click();
  await card.getByTestId('cost-source-delete').click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /הסרה|Remove/ })
    .click();
  await expect(card).toHaveCount(0);
});
