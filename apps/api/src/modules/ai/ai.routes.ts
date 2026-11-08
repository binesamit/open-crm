// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  aiConnectionSchema,
  aiConnectionTestSchema,
  aiModelListQuerySchema,
  aiModelListSchema,
  aiSettingsSchema,
  aiUsageQuerySchema,
  aiUsageSchema,
  createAiConnectionSchema,
  mcpInfoSchema,
  previewAiModelsSchema,
  updateAiConnectionSchema,
  updateAiSettingsSchema,
} from '@bines/shared';
import { requestMeta, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  aiUsageReport,
  createConnection,
  deleteConnection,
  getAiSettings,
  listConnectionModels,
  listConnections,
  mcpInfo,
  previewModels,
  testConnection,
  updateAiSettings,
  updateConnection,
} from './ai.service';

/**
 * AI and MCP administration (the planning notes "AGENTS-MCP" מ1 + מ3, D26): settings, AI connections (write-only keys),
 * usage — admins only (the services check) — and the MCP connection page's data for anyone.
 */
export const aiRoutes = (deps: AppDeps) => {
  const middleware = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/settings',
      tags: ['ai'],
      summary: 'AI and MCP settings of the account (admin)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(aiSettingsSchema, 'AI settings'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getAiSettings(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/ai/settings',
      tags: ['ai'],
      summary: 'Change AI and MCP settings (admin) — audited as ai.settings_changed',
      middleware,
      request: { headers: accountHeader, ...jsonBody(updateAiSettingsSchema) },
      responses: { 200: json(aiSettingsSchema, 'AI settings'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await updateAiSettings(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/connections',
      tags: ['ai'],
      summary: 'AI connections (admin): provider, key hint, default model — never the key',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(aiConnectionSchema) }), 'AI connections'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await listConnections(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/connections',
      tags: ['ai'],
      summary: 'Save an AI connection (admin): the key is encrypted and never returned',
      middleware,
      request: { headers: accountHeader, ...jsonBody(createAiConnectionSchema) },
      responses: { 201: json(aiConnectionSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await createConnection(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/ai/connections/{id}',
      tags: ['ai'],
      summary: 'Rename an AI connection, change its default model or replace its key (admin)',
      middleware,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateAiConnectionSchema) },
      responses: { 200: json(aiConnectionSchema, 'Updated'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(
        await updateConnection(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/ai/connections/{id}',
      tags: ['ai'],
      summary: 'Delete an AI connection (admin)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await deleteConnection(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/connections/{id}/test',
      tags: ['ai'],
      summary: 'Check that an AI connection key works (admin; a free call)',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(aiConnectionTestSchema, 'Result'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await testConnection(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/connections/{id}/models',
      tags: ['ai'],
      summary:
        "The connection's models, live from the provider (cached an hour; ?refresh=true asks again — admins), newest and most capable first, with prices and the default model",
      middleware,
      request: { headers: accountHeader, params: idParam, query: aiModelListQuerySchema },
      responses: { 200: json(aiModelListSchema, 'Models'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(
        await listConnectionModels(deps, actorOf(c), c.req.valid('param').id, c.req.valid('query').refresh === 'true'),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/ai/connections/models',
      tags: ['ai'],
      summary: "A provider's live models for a key, before the connection is saved (admin; nothing is kept)",
      middleware,
      request: { headers: accountHeader, ...jsonBody(previewAiModelsSchema) },
      responses: { 200: json(aiModelListSchema, 'Models'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await previewModels(deps, actorOf(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/usage',
      tags: ['ai'],
      summary: "A month's AI spend per connection, source and model (admin)",
      middleware,
      request: { headers: accountHeader, query: aiUsageQuerySchema },
      responses: { 200: json(aiUsageSchema, 'AI usage'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await aiUsageReport(deps, actorOf(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/mcp',
      tags: ['ai'],
      summary: "The account's MCP server address, whether I may connect, and the tools I would get",
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(mcpInfoSchema, 'MCP'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await mcpInfo(deps, actorOf(c)), 200),
  );
  return r;
};
