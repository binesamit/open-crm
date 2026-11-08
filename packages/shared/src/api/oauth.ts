// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import type { TokenScope } from './tokens';

/**
 * OAuth 2.1 for MCP (the planning notes "AGENTS-MCP" §4, מ5): remote AI apps (Claude.ai, ChatGPT…) connect to `/mcp` with
 * our own authorization server. The OAuth scopes are the API token scopes (06 §1.3) the MCP tools declare; the
 * consent screen shows them as three groups. A connection is one user in one account (D12).
 */
export const OAUTH_ACCESS_PREFIX = 'bos_oat_';
export const OAUTH_REFRESH_PREFIX = 'bos_ort_';
export const isOauthAccessToken = (s: string) => s.startsWith(OAUTH_ACCESS_PREFIX);

/** Access tokens live an hour; refresh tokens rotate on every use and expire after 30 days unused. */
export const OAUTH_ACCESS_TTL_S = 60 * 60;
export const OAUTH_REFRESH_TTL_S = 30 * 24 * 60 * 60;

export const MCP_SCOPE_GROUPS = {
  /** Always granted: what reading tools need. */
  read: ['boards:read', 'updates:read', 'users:read', 'search', 'automations:read'],
  /** Create and change items, updates, groups, columns and boards. */
  write: ['items:write', 'updates:write', 'boards:write'],
  /** Create and switch automations. */
  automations: ['automations:write'],
} as const satisfies Record<string, readonly TokenScope[]>;
export type McpScopeGroup = keyof typeof MCP_SCOPE_GROUPS;
export const MCP_SCOPE_GROUP_KEYS = Object.keys(MCP_SCOPE_GROUPS) as McpScopeGroup[];

/** Every scope a remote AI app may ask for (the authorization server's `scopes_supported`). */
export const MCP_OAUTH_SCOPES: TokenScope[] = MCP_SCOPE_GROUP_KEYS.flatMap((g) => [...MCP_SCOPE_GROUPS[g]]);

/** The scopes of the chosen groups (read always included). */
export const scopesOfGroups = (groups: readonly McpScopeGroup[]): TokenScope[] => [
  ...new Set<TokenScope>(['read', ...groups].flatMap((g) => [...MCP_SCOPE_GROUPS[g as McpScopeGroup]])),
];

/** Which groups a set of requested scopes asks for (to preselect the consent screen). Nothing asked = read + write. */
export const groupsOfScopes = (scopes: readonly string[]): McpScopeGroup[] => {
  const known = scopes.filter((s) => (MCP_OAUTH_SCOPES as string[]).includes(s));
  if (!known.length) return ['read', 'write'];
  return MCP_SCOPE_GROUP_KEYS.filter((g) => g === 'read' || MCP_SCOPE_GROUPS[g].some((s) => known.includes(s)));
};

/** The consent screen's data (GET /oauth-requests/{id}). */
export const oauthRequestSchema = z
  .object({
    id: z.string(),
    client: z.object({
      name: z.string(),
      /** Where the app lives (its metadata document's host, or its redirect host). */
      host: z.string(),
      uri: z.string().nullable(),
      /** cimd = identified by its own metadata document; dcr = registered itself (unverified name). */
      kind: z.enum(['cimd', 'dcr']),
      /** False for a self-registered (dcr) client: its name is its own claim — the consent screen says so (S-58). */
      verified: z.boolean(),
    }),
    /** Where the browser goes after the decision (host only — shown so the person knows). */
    redirect_host: z.string(),
    requested_groups: z.array(z.enum(['read', 'write', 'automations'])),
    accounts: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        role: z.string(),
        /** May this person connect an AI app to this account (role, perm.mcp, MCP on)? */
        allowed: z.boolean(),
        /** Why not: guests / mcp_disabled / mcp_role_not_allowed / account_suspended. */
        reason: z.string().nullable(),
        /** Viewers connect read-only. */
        read_only: z.boolean(),
      }),
    ),
    expires_at: z.string(),
  })
  .meta({ id: 'OauthRequest' });
export type OauthRequest = z.infer<typeof oauthRequestSchema>;

export const approveOauthSchema = z.object({
  account_id: z.string().min(1).max(26),
  groups: z.array(z.enum(['read', 'write', 'automations'])).max(3),
  /** Limit the app to these boards; omitted = every board the person can see. */
  board_ids: z.array(z.string().min(1).max(26)).min(1).max(100).optional(),
});
export type ApproveOauth = z.infer<typeof approveOauthSchema>;

/** Where the consent screen sends the browser next (the app's redirect URI with the code or the error). */
export const oauthDecisionSchema = z.object({ redirect_to: z.string() }).meta({ id: 'OauthDecision' });

/** A connected AI app (profile → API tokens, Administration → חיבורים / AI ו-MCP). */
export const mcpConnectionSchema = z
  .object({
    id: z.string(),
    client_name: z.string(),
    client_host: z.string(),
    user_id: z.string(),
    user_name: z.string().nullable(),
    scopes: z.array(z.string()),
    board_ids: z.array(z.string()).nullable(),
    last_used_at: z.string().nullable(),
    created_at: z.string(),
  })
  .meta({ id: 'McpConnection' });
export type McpConnection = z.infer<typeof mcpConnectionSchema>;
