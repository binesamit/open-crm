// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * AI ו-MCP (the planning notes "AGENTS-MCP" מ1 + מ3): Administration → "AI ו-MCP" shows this account's MCP address with
 * copyable connection snippets for Claude Code / Cursor / VS Code (generated from the address, never hard-coded),
 * who may connect, the sensitive-tool policy, AI connections (write-only key) and the month's AI usage.
 */
test('admin → AI and MCP: address, snippets, settings and an AI connection', async ({ page, baseURL }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/admin/ai');
  await expect(page.getByTestId('admin-ai')).toBeVisible();

  // The address is the web origin's /mcp, and every snippet carries it.
  const url = `${new URL(baseURL!).origin}/mcp`;
  await expect(page.getByTestId('ai-mcp-url')).toHaveText(url);
  await expect(page.getByTestId('ai-mcp-snippet')).toContainText(`claude mcp add --transport http bines-demo ${url}`);
  await page.getByTestId('ai-mcp-client-cursor').click();
  await expect(page.getByTestId('ai-mcp-snippet')).toContainText('"mcpServers"');
  await expect(page.getByTestId('ai-mcp-snippet')).toContainText(url);
  await page.getByTestId('ai-mcp-client-vscode').click();
  await expect(page.getByTestId('ai-mcp-snippet')).toContainText('"type": "http"');
  await page.getByTestId('ai-mcp-client-claude_ai').click();
  // Claude.ai / ChatGPT connect over OAuth (מ5): only the address, plus the steps for each app.
  await expect(page.getByTestId('ai-mcp-snippet')).toHaveText(url);
  await expect(page.getByTestId('ai-mcp-oauth-steps')).toBeVisible();
  await expect(page.getByTestId('ai-mcp-tools')).toContainText('query_items');

  // Who may connect: members + viewers, then back.
  await page.getByTestId('ai-mcp-who').getByText('חברי צוות וצופים').click();
  await expect(page.getByText('נשמר').first()).toBeVisible();
  await page.getByTestId('ai-mcp-who').getByText('חברי צוות', { exact: true }).click();

  // An AI connection: the key is never shown again — only its last 4 characters.
  await page.getByTestId('ai-connection-add').click();
  await page.getByTestId('ai-connection-name').fill('Anthropic — e2e');
  await page.getByTestId('ai-connection-key').fill('sk-ant-e2e-not-a-real-key-WXYZ');
  await page.getByTestId('ai-connection-save').click();
  const row = page.getByTestId('ai-connection-row').filter({ hasText: 'Anthropic — e2e' });
  await expect(row).toContainText('…WXYZ');
  await expect(page.getByText('sk-ant-e2e-not-a-real-key')).toHaveCount(0);
  await row.getByTestId('ai-connection-delete').click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'מחיקה' }).click();
  await expect(row).toHaveCount(0);

  await expect(page.getByTestId('ai-usage')).toBeVisible();
  await page.screenshot({ path: 'e2e/screens/admin-ai.png' });
});
