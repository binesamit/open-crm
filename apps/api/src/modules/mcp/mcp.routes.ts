// SPDX-License-Identifier: AGPL-3.0-only
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { AppDeps, AppEnv } from '../../types';
import { authenticateMcp, McpAuthError, type McpPrincipal } from './mcp.auth';
import { buildMcpServer } from './mcp.server';
import { MCP_CHALLENGE_SCOPES } from '../oauth/oauth.routes';
import { resourceMetadataUrl } from '../oauth/oauth.service';

/** Largest MCP request body (a tool call's arguments). */
const MAX_MCP_BODY = 1024 * 1024;

/**
 * `/mcp` (the planning notes "AGENTS-MCP" §4, מ3): the account's MCP server over Streamable HTTP, stateless, through the
 * official TypeScript SDK (`@modelcontextprotocol/server` v2, Apache-2.0): the 2026-07-28 revision plus 2025-era
 * clients (initialize → tools/list → tools/call, each request on its own). Bearer token only — no cookies, so
 * no CSRF; the token is never passed on anywhere (no token passthrough). Mounted on the web origin next to the SPA
 * (the address is `WEB_ORIGIN/mcp`, never hard-coded).
 */
export const mountMcp = (app: OpenAPIHono<AppEnv>, deps: AppDeps) => {
  const handler = createMcpHandler(({ authInfo }) => buildMcpServer(deps, authInfo!.extra!.principal as McpPrincipal), {
    maxRequestBodySize: MAX_MCP_BODY,
    onerror: (err) => deps.logger.warn({ err: err.message }, 'mcp request rejected'),
  });

  app.all('/mcp', async (c) => {
    let principal: McpPrincipal;
    try {
      principal = await authenticateMcp(deps, c);
    } catch (err) {
      if (!(err instanceof McpAuthError)) throw err;
      // RFC 9728 §5.1 / MCP authorization: the challenge names the protected resource metadata (where clients
      // discover the authorization server) and the scopes a connection needs.
      const challenge = `Bearer realm="bines-os", resource_metadata="${await resourceMetadataUrl(deps)}", scope="${MCP_CHALLENGE_SCOPES.join(' ')}"`;
      if (err.status === 401)
        c.header(
          'WWW-Authenticate',
          err.presented ? `${challenge}, error="invalid_token", error_description="${err.message}"` : challenge,
        );
      if (err.status === 403) c.header('WWW-Authenticate', `${challenge}, error="insufficient_scope"`);
      return c.json(
        {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details ? { details: err.details } : {}),
            request_id: c.get('requestId'),
          },
        },
        err.status,
      );
    }
    const res = await handler.fetch(c.req.raw, {
      authInfo: {
        token: 'redacted', // the SDK never needs the token itself; it stays here (no passthrough)
        clientId: principal.client,
        scopes: principal.scopes,
        extra: { principal },
      },
    });
    // Keep the rate headers chargeToken set on the Hono context.
    const headers = new Headers(res.headers);
    for (const [k, v] of c.res.headers) if (k.toLowerCase().startsWith('ratelimit')) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  });
};
