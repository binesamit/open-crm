// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  apiTokenSchema,
  createdTokenSchema,
  createServiceTokenSchema,
  createTokenSchema,
  integrationsGuideSchema,
  updateTokenLimitsSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { integrationsGuide } from '../platform/platform-settings';
import * as svc from './tokens.service';

const common = errors(400, 401, 403, 404, 422);

/** API tokens (06 §1.2): managed with a session only — a token cannot mint or list tokens (lib/scopes). */
export const tokenRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const actor = (c: Context<AppEnv>) => ({
    ctx: c.get('account'),
    user: currentUser(c),
    requestId: c.get('requestId'),
    sessionId: c.get('sessionId') ?? null,
  });
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/auth/tokens',
      tags: ['auth'],
      summary: 'My API tokens in this account (`all=true`: every member’s, admins)',
      middleware: scoped,
      request: { headers: accountHeader, query: z.object({ all: z.enum(['true', 'false']).optional() }) },
      responses: { 200: json(z.object({ data: z.array(apiTokenSchema) }), 'Tokens'), ...common },
    }),
    async (c) => c.json(await svc.listTokens(db, actor(c), c.req.valid('query').all === 'true'), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/auth/integrations',
      tags: ['auth'],
      summary: 'How to connect n8n and Make: the instance URL, the n8n package and the Make app invitation link',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(integrationsGuideSchema, 'Integrations'), ...common },
    }),
    async (c) => c.json(await integrationsGuide(deps, currentUser(c).locale === 'en' ? 'en' : 'he'), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/auth/tokens',
      tags: ['auth'],
      summary: 'Create a personal API token — the token is returned once, only here',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createTokenSchema) },
      responses: { 201: json(createdTokenSchema, 'Created'), ...common },
    }),
    async (c) => c.json(await svc.createToken(db, actor(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/auth/service-tokens',
      tags: ['auth'],
      summary: 'Admins: a service identity ("Service: <name>", in the account language) with a token — returned once',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(createServiceTokenSchema) },
      responses: { 201: json(createdTokenSchema, 'Created'), ...common },
    }),
    async (c) => c.json(await svc.createServiceToken(db, actor(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/auth/tokens/{id}',
      tags: ['auth'],
      summary: 'Set the token budgets per minute / day (null = the account default; above it: admins only)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateTokenLimitsSchema) },
      responses: { 200: json(apiTokenSchema, 'Token'), ...common },
    }),
    async (c) => c.json(await svc.updateTokenLimits(db, actor(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/auth/tokens/{id}',
      tags: ['auth'],
      summary: 'Revoke a token (mine; admins: any in the account)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Revoked'), ...common },
    }),
    async (c) => c.json(await svc.revokeToken(db, actor(c), c.req.valid('param').id), 200),
  );
  return r;
};
