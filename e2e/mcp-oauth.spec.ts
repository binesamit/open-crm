// SPDX-License-Identifier: AGPL-3.0-only
import { createHash, randomBytes } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { forbidNativeDialogs, signIn } from './helpers';

/**
 * OAuth for MCP (the planning notes "AGENTS-MCP" מ5): an AI app (here: a fake one with a loopback callback) sends the
 * browser to /oauth/authorize → our consent screen (/connect, RTL) → the person picks the account, the rights
 * and the boards with real clicks → back to the app with a code → the app exchanges it (PKCE) → the token works on
 * /mcp → the person disconnects it from the profile → the token stops working. Plus "cancel" → access_denied.
 */
const CALLBACK = 'http://127.0.0.1:47123/callback';

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** The fake app's callback: the browser lands there; we read the query. */
const catchCallback = async (page: Page) => {
  await page.route(`${CALLBACK}**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<p>back in the app</p>' }),
  );
};

const registerApp = async (page: Page) => {
  const res = await page.request.post('/oauth/register', {
    data: { client_name: 'E2E AI App', redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' },
  });
  expect(res.status()).toBe(201);
  return ((await res.json()) as { client_id: string }).client_id;
};

const authorizeUrl = (clientId: string, challenge: string, origin: string) =>
  `/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: CALLBACK,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'e2e-state',
    resource: `${origin}/mcp`,
    scope: 'boards:read items:write',
  }).toString()}`;

const mcpStatus = async (page: Page, token: string) =>
  (
    await page.request.post('/mcp', {
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      data: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    })
  ).status();

test('consent screen: pick account, rights and a board → code → token works → disconnect from the profile', async ({
  page,
  baseURL,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await catchCallback(page);
  const origin = new URL(baseURL!).origin;
  const clientId = await registerApp(page);
  const { verifier, challenge } = pkce();

  await page.goto(authorizeUrl(clientId, challenge, origin));
  await page.waitForURL(/\/connect\?request=/);
  await expect(page.getByTestId('connect-client')).toContainText('E2E AI App');
  await expect(page.getByTestId('connect-redirect-host')).toHaveText('127.0.0.1:47123');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');

  // One account (D12), edit + automations, only one board.
  await page.getByTestId('connect-account-demo').click();
  await expect(page.getByTestId('connect-scope-read')).toHaveAttribute('data-checked', 'true');
  await expect(page.getByTestId('connect-scope-write')).toHaveAttribute('data-checked', 'true');
  await page.getByTestId('connect-scope-automations').getByRole('checkbox').click();
  await expect(page.getByTestId('connect-scope-automations')).toHaveAttribute('data-checked', 'true');
  await page.getByTestId('connect-boards-some').click();
  // Nothing chosen yet → cannot allow.
  await expect(page.getByTestId('connect-allow')).toBeDisabled();
  const firstBoard = page.getByTestId('connect-board').first();
  const boardName = (await firstBoard.getAttribute('data-name'))!;
  await firstBoard.getByRole('checkbox').click();
  await page.screenshot({ path: 'e2e/screens/mcp-oauth-consent.png', fullPage: true });
  await page.getByTestId('connect-allow').click();

  // Back in the app with code + state + iss.
  await page.waitForURL(new RegExp(`^${CALLBACK.replace(/[.:/]/g, '\\$&')}`));
  const back = new URL(page.url());
  expect(back.searchParams.get('state')).toBe('e2e-state');
  expect(back.searchParams.get('iss')).toBe(origin);
  const code = back.searchParams.get('code')!;

  // The app exchanges the code (PKCE) and calls /mcp.
  const tokenRes = await page.request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: CALLBACK,
      resource: `${origin}/mcp`,
    },
  });
  expect(tokenRes.status()).toBe(200);
  const tokens = (await tokenRes.json()) as { access_token: string; scope: string };
  expect(tokens.scope).toContain('automations:write');
  expect(await mcpStatus(page, tokens.access_token)).toBe(200);

  // The profile lists it — with the one board — and disconnects it.
  await page.goto('/a/demo/profile?tab=tokens');
  // Earlier local runs that stopped half way may have left "E2E AI App" rows with the same board: every one of them
  // is this test's app, so each is disconnected (this run's among them).
  const mine = page.getByTestId('mcp-connection-row').filter({ hasText: 'E2E AI App' }).filter({ hasText: boardName });
  await expect(mine.first()).toBeVisible();
  await expect(mine.first().getByTestId('mcp-connection-boards')).toContainText(boardName);
  for (let left = await mine.count(); left > 0; left--) {
    await mine.first().getByTestId('mcp-connection-disconnect').click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: /ניתוק|Disconnect|mcp\.connections\.disconnect/ })
      .click();
    await expect(mine).toHaveCount(left - 1);
  }
  expect(await mcpStatus(page, tokens.access_token)).toBe(401);
});

test('consent screen: cancel sends access_denied back to the app; a bad client shows an error page', async ({
  page,
  baseURL,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await catchCallback(page);
  const origin = new URL(baseURL!).origin;
  const clientId = await registerApp(page);

  await page.goto(authorizeUrl(clientId, pkce().challenge, origin));
  await page.waitForURL(/\/connect\?request=/);
  await page.getByTestId('connect-deny').click();
  await page.waitForURL(new RegExp(`^${CALLBACK.replace(/[.:/]/g, '\\$&')}`));
  const back = new URL(page.url());
  expect(back.searchParams.get('error')).toBe('access_denied');
  expect(back.searchParams.get('state')).toBe('e2e-state');

  // An unknown app is never redirected to: our own error page.
  await page.goto(authorizeUrl('bos_cli_unknown', pkce().challenge, origin));
  await page.waitForURL(/\/connect\?error=invalid_client/);
  await expect(page.getByTestId('connect-error')).toBeVisible();
});

test('admin → AI and MCP: Claude.ai / ChatGPT tab shows the OAuth steps and the connected apps', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  await page.goto('/a/demo/admin/ai');
  await page.getByTestId('ai-mcp-client-claude_ai').click();
  await expect(page.getByTestId('ai-mcp-oauth-steps')).toBeVisible();
  await expect(page.getByTestId('ai-mcp-snippet')).toHaveText(/\/mcp$/);
  await expect(page.getByTestId('mcp-connections')).toBeVisible();
});
