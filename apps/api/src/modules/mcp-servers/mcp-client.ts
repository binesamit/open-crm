// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import { z } from 'zod';
import { outboundExchange } from '../../lib/outbound';

/**
 * A minimal MCP client (Streamable HTTP transport, JSON-RPC 2.0) for outbound MCP (the planning notes "AGENTS-MCP" מ10):
 * `initialize` → `notifications/initialized` → one request (`tools/list` / `tools/call`), on a fresh session each
 * time — stateless on our side, nothing to keep alive. Every HTTP call goes through the SSRF-safe outbound helper
 * (public addresses only, no redirects, a byte cap, a timeout). Answers may be JSON or an SSE stream; either way
 * only the matching JSON-RPC response is read.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type McpTransport = {
  url: string;
  /** `Authorization` value (bearer token / OAuth access token), never logged. */
  authorization: string | null;
  timeoutMs: number;
  allowPrivate: boolean;
};

const rpcError = z.object({ code: z.number(), message: z.string() }).loose();
const rpcResponse = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string(), z.null()]),
  result: z.unknown().optional(),
  error: rpcError.optional(),
});

/** The JSON-RPC answer with this id from a JSON body or an SSE stream (`data:` lines). */
export const pickResponse = (contentType: string, body: string, id: number) => {
  const candidates: unknown[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        candidates.push(JSON.parse(data));
      } catch {
        // not JSON: skip
      }
    }
  } else {
    try {
      const parsed = JSON.parse(body) as unknown;
      candidates.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      throw new AppError('external_error', 'mcp_bad_response');
    }
  }
  for (const c of candidates) {
    const r = rpcResponse.safeParse(c);
    if (r.success && r.data.id === id) return r.data;
  }
  throw new AppError('external_error', 'mcp_bad_response');
};

const failure = (err: unknown): never => {
  if (err instanceof AppError) throw err;
  const e = err as Error;
  throw new AppError('external_error', e.name === 'TimeoutError' ? 'mcp_timeout' : 'mcp_unreachable');
};

/** One MCP session: initialize, then `method` with `params`. Returns the JSON-RPC `result`. */
export const mcpRequest = async (
  t: McpTransport,
  method: string,
  params: Record<string, unknown>,
  opts: { maxBytes: number },
): Promise<unknown> => {
  const started = Date.now();
  const left = () => Math.max(1000, t.timeoutMs - (Date.now() - started));
  const base: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': 'BinesOS-MCP/1',
    ...(t.authorization ? { authorization: t.authorization } : {}),
  };
  const post = (headers: Record<string, string>, payload: unknown, maxBytes: number) =>
    outboundExchange(t.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      timeoutMs: left(),
      allowPrivate: t.allowPrivate,
      maxBytes,
    }).catch(failure);

  const init = await post(
    base,
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'Bines OS', version: '1.0.0' },
      },
    },
    64 * 1024,
  );
  if (init.status === 401 || init.status === 403) throw new AppError('external_error', 'mcp_unauthorized');
  if (!init.ok) throw new AppError('external_error', `mcp_http_${init.status}`);
  const initRes = pickResponse(String(init.headers['content-type'] ?? ''), init.body, 1);
  if (initRes.error) throw new AppError('external_error', 'mcp_initialize_failed');
  const session = init.headers['mcp-session-id'];
  const negotiated = (initRes.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
  const headers = {
    ...base,
    'mcp-protocol-version': typeof negotiated === 'string' ? negotiated.slice(0, 20) : MCP_PROTOCOL_VERSION,
    ...(typeof session === 'string' && session.length < 200 ? { 'mcp-session-id': session } : {}),
  };
  // The notification has no answer worth reading (202).
  await post(headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, 4096);
  const res = await post(headers, { jsonrpc: '2.0', id: 2, method, params }, opts.maxBytes);
  if (res.truncated) throw new AppError('payload_too_large', 'mcp_answer_too_large');
  if (res.status === 401 || res.status === 403) throw new AppError('external_error', 'mcp_unauthorized');
  if (!res.ok) throw new AppError('external_error', `mcp_http_${res.status}`);
  const out = pickResponse(String(res.headers['content-type'] ?? ''), res.body, 2);
  // EXT-RT9: the remote text is the server's, not ours — kept apart from the error code (a model sees it only
  // wrapped as untrusted content, mcp-servers.service `runAgentMcpTool`).
  if (out.error) throw new AppError('external_error', 'mcp_error', { remote_message: out.error.message.slice(0, 200) });
  return out.result;
};

export const remoteToolSchema = z.object({
  // EXT-RT9: the MCP spec's tool-name characters only — a name is shown to models and people, never a sentence.
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9_.\-/]+$/),
  description: z.string().max(10_000).optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type RemoteTool = z.infer<typeof remoteToolSchema>;

/** `tools/list` (first page; at most 200 tools). */
export const listRemoteTools = async (t: McpTransport): Promise<RemoteTool[]> => {
  const result = (await mcpRequest(t, 'tools/list', {}, { maxBytes: 1024 * 1024 })) as { tools?: unknown };
  const tools = Array.isArray(result?.tools) ? result.tools : [];
  return tools.slice(0, 200).flatMap((x) => {
    const r = remoteToolSchema.safeParse(x);
    return r.success ? [r.data] : [];
  });
};

export type RemoteCallResult = { text: string; isError: boolean };

/** Content blocks → text: text as is; anything else as a short marker (we never fetch what it points at). */
const contentText = (content: unknown): string => {
  if (!Array.isArray(content)) return '';
  return content
    .map((b: { type?: unknown; text?: unknown; uri?: unknown; resource?: { uri?: unknown; text?: unknown } }) => {
      if (b?.type === 'text' && typeof b.text === 'string') return b.text;
      if (b?.type === 'resource' && typeof b.resource?.text === 'string') return b.resource.text;
      if (b?.type === 'resource_link' && typeof b.uri === 'string') return `[resource ${b.uri}]`;
      return `[${typeof b?.type === 'string' ? b.type : 'content'}]`;
    })
    .join('\n');
};

/** `tools/call`: the answer as text (structured content as JSON when there is no text), and whether it failed. */
export const callRemoteTool = async (
  t: McpTransport,
  name: string,
  args: Record<string, unknown>,
  maxBytes: number,
): Promise<RemoteCallResult> => {
  const result = (await mcpRequest(t, 'tools/call', { name, arguments: args }, { maxBytes })) as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: unknown;
  };
  let text = contentText(result?.content);
  if (!text && result?.structuredContent !== undefined) text = JSON.stringify(result.structuredContent);
  return { text, isError: result?.isError === true };
};
