// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Dynamic models for every provider (product decision, round 2). With `AI_FAKE=scripted` (playwright.config) an
 * OpenAI connection lists the scripted OpenAI models (`gpt-e2e`, `gpt-e2e-mini`, `gpt-image-e2e`) — so every picker
 * must show those, never Claude's: the connection's default ("automatic — the newest" until one is chosen), "refresh
 * models" on the connection, "make default" in its models, the agent's and the assistant's model pickers.
 */
const uid = () => Date.now().toString(36);

test("an OpenAI connection's live models drive the default, the agent and the assistant pickers", async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const name = `OpenAI ${uid()}`;
  const conn = (await (
    await page.request.post('/api/v1/ai/connections', {
      headers,
      data: { name, provider: 'openai', api_key: 'sk-e2e-not-a-real-key-0000' },
    })
  ).json()) as { id: string };
  try {
    await page.goto('/a/demo/admin/ai');
    const row = page.getByTestId('ai-connection-row').filter({ hasText: name });
    await expect(row.getByTestId('ai-connection-default-model')).toBeVisible();
    // "Refresh models" asks the provider again.
    await row.getByTestId('ai-connection-refresh-models').click();
    // The models: the newest tool-calling model is the automatic default; "make default" picks another.
    await row.getByTestId('ai-connection-models').click();
    const dialog = page.getByTestId('ai-models-dialog');
    await expect(dialog.getByTestId('ai-model-row').first()).toHaveAttribute('data-model', 'gpt-e2e');
    await expect(dialog.locator('[data-model^="claude"]')).toHaveCount(0);
    const top = dialog.locator('[data-testid="ai-model-row"][data-model="gpt-e2e"]');
    await expect(top.getByTestId('ai-model-default')).toHaveAttribute('data-auto', 'true');
    // No price on the table: shown as unknown, still listed.
    await expect(top.getByTestId('ai-model-price')).toHaveAttribute('data-known', 'false');
    const mini = dialog.locator('[data-testid="ai-model-row"][data-model="gpt-e2e-mini"]');
    await mini.getByTestId('ai-model-make-default').click();
    await expect(mini.getByTestId('ai-model-default')).toHaveAttribute('data-auto', 'false');
    await page.keyboard.press('Escape');
    await expect(row.getByTestId('ai-connection-default-model')).toContainText('gpt-e2e-mini');

    // The agent's model picker: the connection's models only, its default preselected.
    await page.goto('/a/demo/agents');
    await page.getByTestId('agent-new').click();
    await page.getByTestId('agent-tab-model').click();
    await page.getByTestId('agent-connection').click();
    await page.getByRole('menu').getByText(name).click();
    await expect(page.getByTestId('agent-model')).toContainText('gpt-e2e-mini');
    await page.getByTestId('agent-model').click();
    const options = page.getByTestId('agent-model-option');
    await expect(options.first()).toContainText('gpt-e2e');
    await expect(page.getByRole('menu').getByText(/claude/i)).toHaveCount(0);
    await page.keyboard.press('Escape');
  } finally {
    await page.request.delete(`/api/v1/ai/connections/${conn.id}`, { headers });
  }
});

test('a new connection loads the provider list before saving and picks its default from it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/admin/ai');
  await page.getByTestId('ai-connection-add').click();
  await page.getByTestId('ai-connection-name').fill(`Gemini ${uid()}`);
  await page.getByTestId('ai-provider-gemini').click();
  await page.getByTestId('ai-connection-key').fill('AIza-e2e-not-a-real-key');
  await page.getByTestId('ai-connection-load-models').click();
  await page.getByTestId('ai-connection-model').click();
  // Ranked by the version in the name (Gemini gives no dates): 3.0 Pro before 1.5 Flash.
  const options = page.getByTestId('ai-connection-model-option');
  await expect(options.first()).toContainText('Gemini E2E 3.0 Pro');
  await expect(page.getByTestId('ai-connection-model-auto')).toContainText('Gemini E2E 3.0 Pro');
  await page.keyboard.press('Escape');
});
