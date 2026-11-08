// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, OWNER_EMAIL, type TestContext } from './helpers';

/**
 * Protocol conformance smoke test for `/mcp` with raw JSON-RPC (no SDK client): what a hand-written or older client
 * sends must get spec-shaped answers — the 2025-11-25 handshake, notifications, list/call shapes, JSON-RPC errors,
 * the stateless 2026-07-28 `server/discover`, and no sessions.
 */
let t: TestContext;
let token: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const body = async (res: Response): Promise<Json> => (await res.json()) as Json;

/** Reads a JSON-RPC answer from a JSON body or a one-event SSE stream. */
const rpcBody = async (res: Response): Promise<Json> => {
  const text = await res.text();
  if (res.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .at(-1);
    return JSON.parse(data!) as Json;
  }
  return JSON.parse(text) as Json;
};

const post = (payload: unknown, headers: Record<string, string> = {}) =>
  t.app.request('/mcp', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
const legacy = { 'mcp-protocol-version': '2025-11-25' };

beforeAll(async () => {
  t = await createTestContext();
  const owner = (await t.signInWithMagicLink(OWNER_EMAIL)).cookie!;
  const res = await body(
    await t.api(owner).post('/platform/accounts', {
      name: 'Acme',
      slug: 'acme',
      first_admin_email: 'admin@acme.test',
      template_set: 'empty',
    }),
  );
  const accountId = res.account.id as string;
  const invite = t.inviteTokenFor('admin@acme.test');
  const admin = t.cookieFrom(await t.signUpWithPassword('admin@acme.test', invite))!;
  await t.api(admin).post('/invitations/accept', { token: invite });
  token = (
    await body(
      await t.api(admin, accountId).post('/auth/tokens', { name: 'smoke', scopes: ['boards:read', 'items:write'] }),
    )
  ).token as string;
});
afterAll(() => t.close());

describe('MCP conformance (raw JSON-RPC)', () => {
  it('2025-11-25: initialize → capabilities with tools, server info, the negotiated version; no session id', async () => {
    const res = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
    const msg = await rpcBody(res);
    expect(msg).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(msg.result.protocolVersion).toBe('2025-11-25');
    expect(msg.result.capabilities.tools).toBeDefined();
    expect(msg.result.serverInfo.name).toBe('bines-os');
    expect(typeof msg.result.instructions).toBe('string');
  });

  it('notifications are accepted with 202 and no body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, legacy);
    expect(res.status).toBe(202);
  });

  it('tools/list: every tool has a name, a description and an object input schema', async () => {
    const msg = await rpcBody(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, legacy));
    const tools = msg.result.tools as Json[];
    expect(tools.length).toBeGreaterThan(10);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema?.type).toBe('object');
    }
  });

  it('tools/call answers content + structuredContent; a tool failure is a result with isError, not a protocol error', async () => {
    const ok = await rpcBody(
      await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'whoami', arguments: {} } }, legacy),
    );
    expect(ok.result.content[0].type).toBe('text');
    expect(ok.result.structuredContent.role).toBe('admin');
    const fail = await rpcBody(
      await post(
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'get_board', arguments: { board_id: 'nope' } } },
        legacy,
      ),
    );
    expect(fail.result.isError).toBe(true);
    expect(JSON.parse(fail.result.content[0].text).error.code).toBe('not_found');
  });

  it('JSON-RPC errors: unknown method, unknown tool, invalid arguments, malformed JSON', async () => {
    const unknown = await rpcBody(await post({ jsonrpc: '2.0', id: 5, method: 'nope/nope' }, legacy));
    expect(unknown.error.code).toBe(-32601);
    const noTool = await rpcBody(
      await post({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'nope', arguments: {} } }, legacy),
    );
    expect(noTool.error?.code ?? (noTool.result?.isError ? -32602 : 0)).toBe(-32602);
    const badArgs = await rpcBody(
      await post({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'get_board', arguments: {} } }, legacy),
    );
    expect(badArgs.error?.code === -32602 || badArgs.result?.isError === true).toBe(true);
    const malformed = await post('{not json', legacy);
    expect(malformed.status).toBeGreaterThanOrEqual(400);
  });

  it('stateless: GET (a 2025 SSE session stream) is not offered', async () => {
    const res = await t.app.request('/mcp', {
      method: 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
    });
    expect(res.status).toBe(405);
  });

  it('2026-07-28: server/discover advertises the versions, tools capability and server identity', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': { name: 'smoke', version: '0' },
    };
    const res = await post(
      { jsonrpc: '2.0', id: 8, method: 'server/discover', params: { _meta: meta } },
      { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' },
    );
    expect(res.status).toBe(200);
    const msg = await rpcBody(res);
    expect(JSON.stringify(msg.result)).toContain('2026-07-28');
    expect(JSON.stringify(msg.result)).toContain('bines-os');
    // A modern tools/list carries its version in _meta — no handshake first.
    const list = await rpcBody(
      await post(
        { jsonrpc: '2.0', id: 9, method: 'tools/list', params: { _meta: meta } },
        { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' },
      ),
    );
    expect(list.result.tools.map((x: Json) => x.name)).toContain('whoami');
  });
});
