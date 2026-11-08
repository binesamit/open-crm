// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * AI images. The owner prices image models per image (and by size / quality) in the AI price
 * table; an admin marks a model as making images and chooses the account's image connection + model + defaults.
 * No provider is reached (the API tests cover the adapters with a mocked fetch; AI_FAKE=scripted plays tiny PNGs).
 */
test('owner console: per-image prices, by size / quality', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner?section=ai-prices');
  const panel = page.getByTestId('owner-ai-prices');
  // Seeded by the migration: DALL·E 3 per image with size / quality prices.
  const dalle = panel.locator('[data-testid="ai-price-row"][data-model="dall-e-3"]');
  await expect(dalle.getByTestId('ai-price-cell-image')).toHaveText('$0.04 +5');

  const model = `e2e-image-${Date.now()}`;
  await page.getByTestId('ai-price-new').click();
  await page.getByTestId('ai-price-model').fill(model);
  await page.getByTestId('ai-price-input').fill('0');
  await page.getByTestId('ai-price-output').fill('0');
  await page.getByTestId('ai-price-per_image').fill('0.05');
  await page.getByTestId('ai-price-variant-add').click();
  await page.getByTestId('ai-price-variant-key').fill('1024x1024/high');
  await page.getByTestId('ai-price-variant-price').fill('0.17');
  await page.getByTestId('ai-price-save').click();
  const row = panel.locator(`[data-testid="ai-price-row"][data-model="${model}"]`);
  await expect(row.getByTestId('ai-price-cell-image')).toHaveText('$0.05 +1');
  await row.getByTestId('ai-price-delete').click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /מחיקה|מחק|Delete/ })
    .click();
  await expect(row).toHaveCount(0);
});

test('admin → AI: the AI images panel and the "makes images" capability', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/admin/ai');
  const panel = page.getByTestId('ai-images-settings');
  await expect(panel).toBeVisible();
  await expect(page.getByTestId('ai-images-size')).toBeVisible();
  await expect(page.getByTestId('ai-images-quality')).toBeVisible();
  // Saved at once (no save button), like the assistant's settings.
  await page.getByTestId('ai-images-max').getByRole('radio', { name: '2', exact: true }).click();
  await page.reload();
  await expect(page.getByTestId('ai-images-max').getByRole('radio', { name: '2', exact: true })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.getByTestId('ai-images-max').getByRole('radio', { name: '1', exact: true }).click();
  await page.screenshot({ path: 'e2e/screens/ai-images-settings.png' });
});
