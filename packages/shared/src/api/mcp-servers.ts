// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import { httpUrl } from './zod';

/**
 * Outbound MCP (the planning notes "AGENTS-MCP" מ10): an account's admins register external MCP servers (n8n, Make, Bines
 * Tools …) — a URL and its credentials (a bearer token or an OAuth client, sealed at rest). Their tools are listed
 * (`tools/list`), and each tool is **off until an admin enables it**; enabled tools can be given to agents one by one
 * (opt-in per agent and per tool) and are called by the `mcp:<tool>` automation block. Every call goes through the
 * SSRF-safe outbound helper, with a timeout and an hourly cap, is audited, and its answer reaches a model only as
 * untrusted content. A tool waits for a person's approval by default (an admin may lift that per tool).
 */
export const MCP_SERVER_AUTH_KINDS = ['none', 'bearer', 'oauth_client'] as const;
export type McpServerAuthKind = (typeof MCP_SERVER_AUTH_KINDS)[number];

/** A server's short key (unique per account): part of its tools' names for agents (`mcp_<key>__<tool>`). */
export const mcpServerKeySchema = z.string().regex(/^[a-z][a-z0-9]{1,15}$/, 'mcp_server_key_invalid');

export const MCP_TOOL_PREFIX = 'mcp_';
/** The name an agent (and the model) knows a remote tool by: `mcp_<server key>__<tool>` — ≤ 64, `[A-Za-z0-9_-]`. */
export const mcpToolAlias = (serverKey: string, toolName: string) => {
  const head = `${MCP_TOOL_PREFIX}${serverKey}__`;
  const safe = toolName.replace(/[^A-Za-z0-9_-]/g, '_') || 'tool';
  return `${head}${safe}`.slice(0, 64);
};
export const isMcpToolAlias = (name: string) => /^mcp_[a-z][a-z0-9]{1,15}__[A-Za-z0-9_-]+$/.test(name);
/** The server key inside an alias. */
export const mcpAliasServer = (alias: string) => /^mcp_([a-z][a-z0-9]{1,15})__/.exec(alias)?.[1] ?? null;

/**
 * The automation block `mcp:<tool>` (an "mcp" action, 04 §4) — or `mcp:<tool>@<server key>` when two
 * registered servers have a tool by that name.
 */
export const parseMcpBlock = (block: string): { tool: string; server: string | null } | null => {
  if (!block.startsWith('mcp:')) return null;
  const rest = block.slice(4);
  const at = rest.lastIndexOf('@');
  const tool = (at > 0 ? rest.slice(0, at) : rest).trim();
  const server = at > 0 ? rest.slice(at + 1).trim() : null;
  if (!tool || tool.length > 128) return null;
  return { tool, server: server || null };
};
export const isMcpBlock = (block: string) => parseMcpBlock(block) !== null;

export const mcpServerAuthSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('bearer'), token: z.string().trim().min(1).max(4000) }),
  z.object({
    kind: z.literal('oauth_client'),
    token_url: httpUrl,
    client_id: z.string().trim().min(1).max(500),
    client_secret: z.string().trim().min(1).max(4000),
    scope: z.string().trim().max(1000).optional(),
  }),
]);
export type McpServerAuth = z.infer<typeof mcpServerAuthSchema>;

export const MCP_TIMEOUT_MAX_MS = 30_000;

export const createMcpServerSchema = z.object({
  key: mcpServerKeySchema,
  name: z.string().trim().min(1).max(120),
  url: httpUrl,
  auth: mcpServerAuthSchema.default({ kind: 'none' }),
  timeout_ms: z.number().int().min(1000).max(MCP_TIMEOUT_MAX_MS).default(MCP_TIMEOUT_MAX_MS),
  /** Calls per hour (agents and automations together) — a runaway loop stops here. */
  max_calls_per_hour: z.number().int().min(1).max(10_000).default(120),
});

export const updateMcpServerSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  url: httpUrl.optional(),
  /** Omitted = keep the saved credentials. */
  auth: mcpServerAuthSchema.optional(),
  timeout_ms: z.number().int().min(1000).max(MCP_TIMEOUT_MAX_MS).optional(),
  max_calls_per_hour: z.number().int().min(1).max(10_000).optional(),
  enabled: z.boolean().optional(),
});

/** Per tool: may it be used at all (off by default), and does an agent's call wait for a person (on by default)? */
export const mcpToolPolicySchema = z.object({ enabled: z.boolean(), approval: z.boolean() });
export const setMcpToolPolicySchema = z.object({
  tools: z.record(z.string().max(128), mcpToolPolicySchema),
});

export const mcpServerToolSchema = z.object({
  name: z.string(),
  alias: z.string(),
  /** From the remote server: shown to people, given to models only as an untrusted description. */
  description: z.string(),
  enabled: z.boolean(),
  approval: z.boolean(),
});
export type McpServerTool = z.infer<typeof mcpServerToolSchema>;

export const mcpServerSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    name: z.string(),
    url: z.string(),
    auth_kind: z.enum(MCP_SERVER_AUTH_KINDS),
    /** `…abcd` of the saved token / client secret — never the secret. */
    auth_hint: z.string().nullable(),
    oauth: z.object({ token_url: z.string(), client_id: z.string(), scope: z.string().nullable() }).nullable(),
    enabled: z.boolean(),
    status: z.enum(['unknown', 'ok', 'error']),
    last_error: z.string().nullable(),
    refreshed_at: z.string().nullable(),
    timeout_ms: z.number(),
    max_calls_per_hour: z.number(),
    tools: z.array(mcpServerToolSchema),
    created_at: z.string(),
  })
  .meta({ id: 'McpServer' });
export type McpServer = z.infer<typeof mcpServerSchema>;

/** An enabled remote tool, as the agent editor offers it. */
export const mcpAgentToolSchema = z.object({
  alias: z.string(),
  name: z.string(),
  server_key: z.string(),
  server_name: z.string(),
  description: z.string(),
  approval: z.boolean(),
});
export type McpAgentTool = z.infer<typeof mcpAgentToolSchema>;

/** POST /mcp-servers/:id/test — try one enabled tool by hand (admins), the answer as text. */
export const testMcpToolSchema = z.object({
  tool: z.string().max(128),
  input: z.record(z.string(), z.unknown()).default({}),
});
