// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * AI to any provider and dynamic AI prices. The owner edits the AI price table and the "allow
 * local AI endpoints" switch in the owner console; an admin connects an OpenAI-compatible server (refused at a local
 * address until the owner allows it), adds a model by hand and marks what it can do. No provider is reached: the
 * server answers from the connection's hand-added models (the API tests cover the adapters with a mocked fetch).
 */
const LOCAL = 'http://127.0.0.1:11434/v1';

test('owner console: the AI price table — seeded, add, edit, delete', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/owner?section=ai-prices');
  const panel = page.getByTestId('owner-ai-prices');
  await expect(panel).toBeVisible();
  // Seeded by the migration with the prices that used to be in code.
  const opus = panel.locator('[data-testid="ai-price-row"][data-model="claude-opus-5-5"]');
  await expect(opus).toBeVisible();
  await expect(opus.getByTestId('ai-price-cell-0')).toHaveText('$4');
  await expect(opus.getByTestId('ai-price-cell-1')).toHaveText('$20');

  const model = `e2e-model-${Date.now()}*`;
  await page.getByTestId('ai-price-new').click();
  await page.getByTestId('ai-price-provider').click();
  await page.getByTestId('ai-price-provider-any').click();
  await page.getByTestId('ai-price-model').fill(model);
  await page.getByTestId('ai-price-input').fill('1.5');
  await page.getByTestId('ai-price-output').fill('6');
  await page.getByTestId('ai-price-save').click();
  const row = panel.locator(`[data-testid="ai-price-row"][data-model="${model}"]`);
  await expect(row).toBeVisible();
  await expect(row.getByTestId('ai-price-cell-0')).toHaveText('$1.5');
  // Cache prices left empty = as much as input (shown as —).
  await expect(row.getByTestId('ai-price-cell-2')).toHaveText('—');

  await row.getByTestId('ai-price-edit').click();
  await page.getByTestId('ai-price-output').fill('8');
  await page.getByTestId('ai-price-save').click();
  await expect(row.getByTestId('ai-price-cell-1')).toHaveText('$8');

  await row.getByTestId('ai-price-delete').click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: /מחיקה|מחק|Delete/ })
    .click();
  await expect(row).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screens/owner-ai-prices.png' });
});

test('admin → AI: an OpenAI-compatible connection, the local-address guard, a model by hand, capabilities', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const name = `Ollama e2e ${Date.now()}`;
  try {
    await page.request.patch('/api/v1/platform/settings', { data: { ai: { allow_local_endpoints: false } } });
    await page.goto('/owner?section=connections');
    await expect(page.getByTestId('owner-ai-local-allow')).not.toBeChecked();

    await page.goto('/a/demo/admin/ai');
    await page.getByTestId('ai-connection-add').click();
    await page.getByTestId('ai-connection-name').fill(name);
    // Every provider is offered; the compatible one asks for a server address and models by hand.
    for (const p of ['anthropic', 'openai', 'gemini', 'openai_compatible'])
      await expect(page.getByTestId(`ai-provider-${p}`)).toBeVisible();
    await page.getByTestId('ai-provider-openai_compatible').click();
    await page.getByTestId('ai-connection-base-url').fill(LOCAL);
    await page.getByTestId('ai-connection-manual-models').fill('e2e-tiny, e2e-big');
    // Refused: a local address while the owner has not allowed it (the dialog stays open). Wait for the answer:
    // the owner's switch below must not overtake this request.
    const refused = page.waitForResponse(
      (r) => r.url().endsWith('/api/v1/ai/connections') && r.request().method() === 'POST',
    );
    await page.getByTestId('ai-connection-save').click();
    expect((await refused).status()).toBe(422);
    await expect(page.getByTestId('ai-connection-form')).toBeVisible();
    await expect(page.getByTestId('ai-connection-row').filter({ hasText: name })).toHaveCount(0);

    // The owner allows local AI endpoints; the same connection now saves.
    await page.request.patch('/api/v1/platform/settings', { data: { ai: { allow_local_endpoints: true } } });
    await page.getByTestId('ai-connection-save').click();
    const row = page.getByTestId('ai-connection-row').filter({ hasText: name });
    await expect(row).toBeVisible();
    await expect(row.getByTestId('ai-connection-provider-label')).toHaveAttribute('data-provider', 'openai_compatible');

    // The models: added by hand, with capability badges; "tools" switched off marks the model as limited.
    await row.getByTestId('ai-connection-models').click();
    const tiny = page.locator('[data-testid="ai-model-row"][data-model="e2e-tiny"]');
    await expect(tiny).toBeVisible();
    await expect(tiny.getByTestId('ai-model-manual')).toBeVisible();
    await expect(tiny.getByTestId('ai-model-cap-tools')).toHaveAttribute('data-on', 'true');
    await expect(tiny.getByTestId('ai-model-cap-vision')).toHaveAttribute('data-on', 'false');
    await tiny.getByTestId('ai-model-caps-edit').click();
    await tiny.getByTestId('ai-model-cap-switch-tools').click();
    await expect(tiny.getByTestId('ai-model-cap-tools')).toHaveAttribute('data-on', 'false');
    // A model added afterwards, by hand.
    await page.getByTestId('ai-model-add-id').fill('e2e-third');
    await page.getByTestId('ai-model-add-save').click();
    await expect(page.locator('[data-testid="ai-model-row"][data-model="e2e-third"]')).toBeVisible();
    await page.screenshot({ path: 'e2e/screens/admin-ai-providers.png' });
    await page.keyboard.press('Escape');

    await row.getByTestId('ai-connection-delete').click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /מחיקה|Delete/ })
      .click();
    await expect(row).toHaveCount(0);
  } finally {
    await page.request.patch('/api/v1/platform/settings', { data: { ai: { allow_local_endpoints: false } } });
  }
});
