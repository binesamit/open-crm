// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * "Improve with AI" in the agent editor: the suggestion shows as changes, can be edited, and "Apply"
 * only fills the field — the agent changes on Save. Without an AI connection the button is disabled.
 *
 * Needs the API with `AI_FAKE=scripted`: an `ANSWER <text>` line in the request is what the model answers.
 */
test('improve the instructions: the changes, an edit, apply — saved only on Save', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const tag = Date.now().toString(36);
  const api = (path: string) => `/api/v1${path}`;
  const original = (await (await page.request.get(api('/ai/settings'), { headers })).json()) as { enabled: boolean };
  await page.request.patch(api('/ai/settings'), { headers, data: { enabled: true } });
  const connection = (await (
    await page.request.post(api('/ai/connections'), {
      headers,
      data: { name: `E2E improve ${tag}`, provider: 'anthropic', api_key: 'sk-ant-e2e-scripted-0000' },
    })
  ).json()) as { id: string };
  const models = (await (
    await page.request.get(api(`/ai/connections/${connection.id}/models`), { headers })
  ).json()) as { default_model?: string | null; data?: { id: string }[] };
  const model = models.default_model ?? models.data?.[0]?.id ?? 'claude-opus-5-5';
  const agent = (await (
    await page.request.post(api('/agents'), {
      headers,
      data: {
        name: `סוכן שיפור ${tag}`,
        role: 'עונה ללקוחות',
        instructions: 'לענות ללקוחות.',
        connection_id: connection.id,
        model,
      },
    })
  ).json()) as { id: string };
  const savedInstructions = async () =>
    ((await (await page.request.get(api(`/agents/${agent.id}`), { headers })).json()) as { instructions: string })
      .instructions;

  try {
    await page.goto(`/a/demo/agents/${agent.id}`);
    await expect(page.getByTestId('agent-editor')).toBeVisible();
    await expect(page.getByTestId('agent-instructions')).toHaveValue('לענות ללקוחות.');

    await page.getByTestId('agent-improve').click();
    const panel = page.getByTestId('agent-improve-panel');
    await expect(panel).toBeVisible();
    await panel.getByTestId('agent-improve-request').fill('ANSWER לענות ללקוחות בנימוס ובקצרה.');
    await panel.getByTestId('agent-improve-run').click();

    // The changes against the current instructions: the added words in green, the removed in red.
    const diff = panel.getByTestId('agent-improve-diff');
    await expect(diff).toBeVisible();
    await expect(diff.getByTestId('diff-add').first()).toBeVisible();
    await expect(diff).toContainText('בנימוס');
    await expect(panel.getByTestId('agent-improve-text')).toHaveValue('לענות ללקוחות בנימוס ובקצרה.');

    // Edit the suggestion: the changes follow the edit.
    await panel.getByTestId('agent-improve-text').fill('לענות ללקוחות בנימוס, בקצרה ובעברית.');
    await expect(diff).toContainText('ובעברית');

    await panel.getByTestId('agent-improve-apply').click();
    await expect(panel).toBeHidden();
    await expect(page.getByTestId('agent-instructions')).toHaveValue('לענות ללקוחות בנימוס, בקצרה ובעברית.');
    // Applied to the field only — nothing saved yet.
    expect(await savedInstructions()).toBe('לענות ללקוחות.');

    await page.getByTestId('agent-save').click();
    await expect.poll(savedInstructions).toBe('לענות ללקוחות בנימוס, בקצרה ובעברית.');

    // Cancel leaves the field as it is.
    await page.getByTestId('agent-improve').click();
    await page.getByTestId('agent-improve-cancel').click();
    await expect(page.getByTestId('agent-improve-panel')).toBeHidden();
    await expect(page.getByTestId('agent-instructions')).toHaveValue('לענות ללקוחות בנימוס, בקצרה ובעברית.');
  } finally {
    await page.request.delete(api(`/agents/${agent.id}`), { headers });
    await page.request.delete(api(`/ai/connections/${connection.id}`), { headers });
    await page.request.patch(api('/ai/settings'), { headers, data: { enabled: original.enabled } });
  }
});

test('no AI connection → "improve with AI" is disabled', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  // An account without connections (the list answered empty): nothing to improve with.
  await page.route('**/api/v1/agents/connections', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }),
  );
  await page.goto('/a/demo/agents/new');
  await expect(page.getByTestId('agent-editor')).toBeVisible();
  await expect(page.getByTestId('agent-improve')).toBeDisabled();
});
