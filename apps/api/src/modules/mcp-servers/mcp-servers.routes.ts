// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  createMcpServerSchema,
  mcpAgentToolSchema,
  mcpServerSchema,
  setMcpToolPolicySchema,
  testMcpToolSchema,
  updateMcpServerSchema,
} from '@bines/shared';
import { requestMeta, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './mcp-servers.service';

const tags = ['mcp-servers'];
const common = errors(400, 401, 403, 404, 409, 422);

/**
 * Outbound MCP servers (the planning notes "AGENTS-MCP" מ10) — Administration → AI ו-MCP. Admins only, a person's session
 * only (lib/scopes): no token, no extension and no agent can register a server or enable a tool. The agent editor
 * reads the enabled tools from `/mcp-servers/tools`.
 */
export const mcpServerRoutes = (deps: AppDeps) => {
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/mcp-servers',
      tags,
      summary: 'Admins: the external MCP servers of the account, with their tools and policy',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(mcpServerSchema) }), 'Servers'), ...common },
    }),
    async (c) => c.json(await svc.listMcpServers(deps, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/mcp-servers/tools',
      tags,
      summary: 'Enabled remote tools (the agent editor offers them one by one)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(mcpAgentToolSchema) }), 'Tools'), ...common },
    }),
    async (c) => c.json(await svc.listAgentMcpTools(deps, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/mcp-servers',
      tags,
      summary: 'Admins: register a server (URL + credentials; public addresses only) and list its tools',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createMcpServerSchema) },
      responses: { 201: json(mcpServerSchema, 'Registered'), ...common },
    }),
    async (c) => c.json(await svc.createMcpServer(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 201),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/mcp-servers/{id}',
      tags,
      summary: 'Admins: rename, move, new credentials (tools must be enabled again), limits, on / off',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateMcpServerSchema) },
      responses: { 200: json(mcpServerSchema, 'Updated'), ...common },
    }),
    async (c) =>
      c.json(
        await svc.updateMcpServer(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/mcp-servers/{id}',
      tags,
      summary: 'Admins: remove a server (its tools leave every agent at once)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Removed'), ...common },
    }),
    async (c) => c.json(await svc.deleteMcpServer(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/mcp-servers/{id}/refresh',
      tags,
      summary: 'Admins: list the tools again (a new tool starts off)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(mcpServerSchema, 'Refreshed'), ...common },
    }),
    async (c) => c.json(await svc.refreshMcpServer(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/mcp-servers/{id}/tools',
      tags,
      summary: 'Admins: enable tools and choose which wait for approval',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(setMcpToolPolicySchema) },
      responses: { 200: json(mcpServerSchema, 'Saved'), ...common },
    }),
    async (c) =>
      c.json(
        await svc.setToolPolicy(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/mcp-servers/{id}/test',
      tags,
      summary: 'Admins: call an enabled tool by hand (audited, counted in the hourly cap)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(testMcpToolSchema) },
      responses: {
        200: json(z.object({ text: z.string(), is_error: z.boolean(), truncated: z.boolean() }), 'Answer'),
        ...errors(400, 401, 403, 404, 409, 422, 429),
      },
    }),
    async (c) => c.json(await svc.testMcpTool(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  return r;
};
