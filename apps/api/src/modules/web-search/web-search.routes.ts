// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import { accountWebSearchSchema, platformWebSearchSchema, updateAccountWebSearchSchema } from '@bines/shared';
import {
  actorOf,
  currentUser,
  requestMeta,
  requireAccount,
  requirePlatformOwner,
  requireUser,
} from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './web-search.service';

const tags = ['ai'];

/** Web search for agents: the owner's master switch and the account's search service. */
export const webSearchRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();
  const owner = [requireUser(), requirePlatformOwner()];
  const account = [requireAccount(deps)];

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/web-search',
      tags,
      summary: 'Whether agents may search the web on this platform (owner)',
      middleware: owner,
      responses: { 200: json(platformWebSearchSchema, 'Switch'), ...errors(401, 404) },
    }),
    async (c) => c.json(await svc.getPlatformWebSearch(deps), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/web-search',
      tags,
      summary: 'Turn web search for agents on / off for every account (owner; audited)',
      middleware: owner,
      request: jsonBody(platformWebSearchSchema),
      responses: { 200: json(platformWebSearchSchema, 'Switch'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await svc.updatePlatformWebSearch(deps, currentUser(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ai/web-search',
      tags,
      summary: "The account's web search service for its agents (admins; the key is never returned)",
      middleware: account,
      request: { headers: accountHeader },
      responses: { 200: json(accountWebSearchSchema, 'Settings'), ...errors(401, 403) },
    }),
    async (c) => c.json(await svc.getAccountWebSearch(deps, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/ai/web-search',
      tags,
      summary: 'Set the search service, its key (write-only) and the limits per run and per day (admins; audited)',
      middleware: account,
      request: { headers: accountHeader, ...jsonBody(updateAccountWebSearchSchema) },
      responses: { 200: json(accountWebSearchSchema, 'Settings'), ...errors(400, 401, 403) },
    }),
    async (c) => c.json(await svc.updateAccountWebSearch(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 200),
  );
  return r;
};
