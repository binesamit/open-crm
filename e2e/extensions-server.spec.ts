// SPDX-License-Identifier: AGPL-3.0-only
import { createHmac } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { forbidNativeDialogs, ownerContext, signIn } from './helpers';

/**
 * Extensions ת6–ת8 + outbound MCP (מ10), end to end on the local stack (development: localhost origins allowed):
 * 1. an extension with its own server — installed by URL through the consent screen; its server gets a signed
 *    `installed` with credentials, trades them for a token (OAuth client_credentials) and reads the board; disable /
 *    update check / version history / uninstall reach it as signed lifecycle calls;
 * 2. the platform owner publishes an extension to the catalog with the §8 review; the account installs it from the
 *    catalog; the owner takes it out again;
 * 3. an admin registers an external MCP server, enables a tool, tries it; the agent editor offers it.
 * The fake extension server and the fake MCP server run inside this test process.
 */
const EXT_PORT = 3996;
const EXT_ORIGIN = `http://127.0.0.1:${EXT_PORT}`;
const MCP_PORT = 3995;
const MCP_URL = `http://127.0.0.1:${MCP_PORT}/mcp`;

let served: Record<string, unknown> = {};
const lifecycle: { headers: IncomingHttpHeaders; raw: string; body: Record<string, any> }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
let extServer: Server | null = null;
let mcpServer: Server | null = null;

const extManifest = (id: string, version = '1.0.0', over: Record<string, unknown> = {}) => ({
  manifest_version: 1,
  id,
  name: `סנכרון ${id}`,
  version,
  publisher: { name: 'E2E Labs' },
  permissions: ['boards:read'],
  origins: [EXT_ORIGIN],
  server: { lifecycle_url: `${EXT_ORIGIN}/lifecycle` },
  ...over,
});

const sign = (secret: string, ts: string, raw: string) =>
  `sha256=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
const lastEvent = (event: string) => [...lifecycle].reverse().find((c) => c.body.event === event);

test.beforeAll(async () => {
  extServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/manifest.json') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify(served));
      }
      if (req.url === '/lifecycle') {
        const raw = Buffer.concat(chunks).toString('utf8');
        lifecycle.push({ headers: req.headers, raw, body: JSON.parse(raw) });
        return res.end('{}');
      }
      res.statusCode = 404;
      res.end();
    });
  });
  mcpServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (req.headers.authorization !== 'Bearer e2e-mcp-token') {
        res.statusCode = 401;
        return res.end();
      }
      if (msg.method === 'notifications/initialized') {
        res.statusCode = 202;
        return res.end();
      }
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'e2e', version: '1' } }
          : msg.method === 'tools/list'
            ? {
                tools: [
                  { name: 'echo', description: 'Echoes', inputSchema: { type: 'object' } },
                  { name: 'other', description: 'Something else', inputSchema: { type: 'object' } },
                ],
              }
            : { content: [{ type: 'text', text: `echo ${JSON.stringify(msg.params?.arguments ?? {})}` }] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => extServer!.listen(EXT_PORT, '127.0.0.1', r));
  await new Promise<void>((r) => mcpServer!.listen(MCP_PORT, '127.0.0.1', r));
});
test.afterAll(async () => {
  await new Promise<void>((r) => (extServer ? extServer.close(() => r()) : r()));
  await new Promise<void>((r) => (mcpServer ? mcpServer.close(() => r()) : r()));
});

const api = (path: string) => `/api/v1${path}`;

test('an extension with its own server: signed lifecycle, client credentials, versions', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const key = `srv-${Date.now().toString(36)}`;
  served = extManifest(key);
  const ws = ((await (await page.request.get(api('/workspaces'), { headers })).json()) as { data: { id: string }[] })
    .data[0]!.id;
  const board = (await (
    await page.request.post(api('/boards'), { headers, data: { name: `Srv e2e ${key}`, workspace_id: ws } })
  ).json()) as { id: string };
  await page.request.post(api(`/boards/${board.id}/items`), { headers, data: { name: `Lead ${key}` } });
  let installationId: string | null = null;
  try {
    // Install by URL: the consent screen, then the server is connected.
    await page.goto('/a/demo/admin/extensions');
    // Round 13: installing by URL lives under the store's "למפתחים" tab.
    await page.getByTestId('ext-tab-dev').click();
    await page.getByTestId('ext-url-input').fill(`${EXT_ORIGIN}/manifest.json`);
    await page.getByTestId('ext-check').click();
    await expect(page.getByTestId('ext-consent')).toBeVisible();
    await page.getByTestId('ext-consent-accept').click();
    const row = page.getByTestId(`ext-installed-${key}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId(`ext-server-${key}`)).toBeVisible();
    await expect(row.getByTestId(`ext-dev-${key}`)).toBeVisible(); // localhost = development mode

    const installed = lastEvent('installed')!;
    const creds = installed.body.credentials as Record<string, string>;
    expect(installed.headers['x-bines-signature']).toBe(
      sign(creds.signing_secret!, String(installed.headers['x-bines-timestamp']), installed.raw),
    );
    installationId = installed.body.installation.id as string;

    // The server: client credentials → a token → the board's items, as the extension's service user.
    const tok = (await (
      await page.request.post('/oauth/token', {
        form: { grant_type: 'client_credentials' },
        headers: {
          authorization: `Basic ${Buffer.from(`${creds.client_id}:${creds.client_secret}`).toString('base64')}`,
        },
      })
    ).json()) as { access_token: string };
    expect(tok.access_token).toMatch(/^bos_xat_/);
    const items = await page.request.get(api(`/boards/${board.id}/items`), {
      headers: { authorization: `Bearer ${tok.access_token}` },
    });
    expect(items.status()).toBe(200);
    expect(JSON.stringify(await items.json())).toContain(`Lead ${key}`);

    // Disable from the screen → a signed `disabled`; the token stops.
    await row.getByTestId(`ext-status-${key}`).click();
    await expect.poll(() => lastEvent('disabled')?.body.installation.key).toBe(key);
    expect(
      (
        await page.request.get(api(`/boards/${board.id}/items`), {
          headers: { authorization: `Bearer ${tok.access_token}` },
        })
      ).status(),
    ).toBe(401);
    await row.getByTestId(`ext-status-${key}`).click();
    await expect.poll(() => lastEvent('enabled')?.body.installation.key).toBe(key);

    // A patch version applies by itself on "check for updates"; the history shows both versions.
    served = extManifest(key, '1.0.1');
    await row.getByTestId(`ext-check-update-${key}`).click();
    await expect(row).toContainText('v1.0.1');
    await expect.poll(() => lastEvent('updated')?.body.installation.version).toBe('1.0.1');
    await row.getByTestId(`ext-versions-${key}`).click();
    await expect(page.getByTestId('ext-version-1.0.1')).toBeVisible();
    await expect(page.getByTestId('ext-version-1.0.0')).toBeVisible();
    await page.keyboard.press('Escape');

    // Lock the version: a newer one only waits.
    await row.getByTestId(`ext-locked-${key}`).click();
    await expect(row.getByTestId(`ext-locked-${key}`)).toBeChecked();
    served = extManifest(key, '1.0.2');
    await row.getByTestId(`ext-check-update-${key}`).click();
    await expect(row.getByTestId(`ext-pending-${key}`)).toBeVisible();
    await expect(row).toContainText('v1.0.1');

    // Uninstall → a signed `uninstalled`; the token is dead.
    await page.request.delete(api(`/extensions/installations/${installationId}`), { headers });
    installationId = null;
    await expect.poll(() => lastEvent('uninstalled')?.body.installation.key).toBe(key);
  } finally {
    if (installationId) await page.request.delete(api(`/extensions/installations/${installationId}`), { headers });
    await page.request.delete(api(`/boards/${board.id}`), { headers });
  }
});

test('the owner publishes to the catalog with the review; the account installs from it', async ({ page }) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const key = `cat-${Date.now().toString(36)}`;
  const manifest = extManifest(key, '1.0.0');
  let installationId: string | null = null;
  try {
    await page.goto('/owner?section=extensions');
    await page.getByTestId('owner-catalog-publish').click();
    await page.getByTestId('catalog-mode-json').click();
    await page.getByTestId('catalog-dialog').locator('textarea').fill(JSON.stringify(manifest));
    await page.getByTestId('catalog-check').click();
    await expect(page.getByTestId('catalog-review')).toBeVisible();
    // A code extension needs every check of the review.
    await expect(page.getByTestId('catalog-publish')).toBeDisabled();
    for (const k of [
      'https_only',
      'least_scopes',
      'no_token_storage',
      'verifies_signatures',
      'no_eval',
      'privacy_policy',
      'platform_limits',
    ])
      await page.getByTestId(`catalog-check-${k}`).click();
    await page.getByTestId('catalog-notes').fill('E2E review');
    await page.getByTestId('catalog-publish').click();
    await expect(page.getByTestId(`owner-ext-entry-${key}`)).toBeVisible();
    await expect(page.getByTestId(`owner-ext-entry-${key}`)).toContainText('7/7');

    // The account installs it from the catalog, through the consent screen.
    await page.goto('/a/demo/admin/extensions');
    const entry = page.getByTestId(`ext-catalog-${key}`);
    await expect(entry).toBeVisible();
    await entry.getByRole('button').click();
    await page.getByTestId('ext-consent-accept').click();
    await expect(page.getByTestId(`ext-installed-${key}`)).toBeVisible();
    const list = (await (await page.request.get(api('/extensions'), { headers })).json()) as {
      installed: { id: string; key: string; source: string }[];
    };
    const inst = list.installed.find((i) => i.key === key)!;
    installationId = inst.id;
    expect(inst.source).toBe('catalog');
    await expect.poll(() => lastEvent('installed')?.body.installation.key).toBe(key);
  } finally {
    if (installationId) await page.request.delete(api(`/extensions/installations/${installationId}`), { headers });
    await page.request.delete(`/api/v1/platform/extensions/catalog/${key}`, { headers: { origin: headers.origin } });
  }
});

test('an admin registers an external MCP server, enables a tool and tries it; agents are offered it', async ({
  page,
}) => {
  forbidNativeDialogs(page);
  await signIn(page);
  const { headers } = await ownerContext(page);
  const key = `e2e${Date.now().toString(36).slice(-6)}`;
  let serverId: string | null = null;
  try {
    await page.goto('/a/demo/admin/ai');
    await page.getByTestId('mcp-server-add').click();
    const dialog = page.getByTestId('mcp-server-dialog');
    await dialog.getByTestId('mcp-server-name').fill('E2E tools');
    await dialog.getByTestId('mcp-server-key').fill(key);
    await dialog.getByTestId('mcp-server-url').fill(MCP_URL);
    await dialog.getByTestId('mcp-auth-bearer').click();
    await dialog.getByTestId('mcp-server-token').fill('e2e-mcp-token');
    await page.getByTestId('mcp-server-save').click();
    const row = page.getByTestId(`mcp-server-${key}`);
    await expect(row).toBeVisible();
    // Tools listed, all off; the token is not shown anywhere.
    await expect(row.getByTestId(`mcp-tool-${key}-echo`)).toBeVisible();
    await expect(row.getByTestId(`mcp-tool-enable-${key}-echo`)).not.toBeChecked();
    await expect(page.locator('body')).not.toContainText('e2e-mcp-token');
    const servers = (await (await page.request.get(api('/mcp-servers'), { headers })).json()) as {
      data: { id: string; key: string }[];
    };
    serverId = servers.data.find((s) => s.key === key)!.id;

    // Enable echo (approval stays on) and try it by hand.
    await row.getByTestId(`mcp-tool-enable-${key}-echo`).click();
    await expect(row.getByTestId(`mcp-tool-enable-${key}-echo`)).toBeChecked();
    await expect(row.getByTestId(`mcp-tool-approval-${key}-echo`)).toBeChecked();
    await row.getByTestId(`mcp-tool-${key}-echo`).getByRole('button').click();
    await page.getByTestId('mcp-try').locator('textarea').fill('{"text":"hi"}');
    await page.getByTestId('mcp-try-run').click();
    await expect(page.getByTestId('mcp-try-output')).toContainText('echo {"text":"hi"}');
    await page.keyboard.press('Escape');

    // The agent editor offers the enabled tool (and not the one left off).
    await page.goto('/a/demo/agents/new');
    await page.getByTestId('agent-tab-tools').click();
    const tools = page.getByTestId('agent-mcp-tools');
    await expect(tools).toBeVisible();
    await expect(tools.locator(`[data-tool="mcp_${key}__echo"]`)).toBeVisible();
    await expect(tools.locator(`[data-tool="mcp_${key}__other"]`)).toHaveCount(0);
  } finally {
    if (serverId) await page.request.delete(api(`/mcp-servers/${serverId}`), { headers });
  }
});
