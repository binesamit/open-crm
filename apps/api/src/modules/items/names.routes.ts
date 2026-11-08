// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { nameDuplicatesSchema, nameSourceOutSchema, nameSourceSchema } from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { getNameSource, nameDuplicates, putNameSource } from './name-source.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const common = errors(400, 401, 403, 404, 409, 422);

/** Item name source: free / one column / a template; computed names are stored in `items.name`. */
export const nameRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/name-source',
      tags: ['columns'],
      summary: "The board's item name source and its last recompute",
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(nameSourceOutSchema, 'Name source'), ...common },
    }),
    async (c) => c.json(await getNameSource(db, actorOf(c), c.req.valid('param').boardId)),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{boardId}/name-source',
      tags: ['columns'],
      summary: "Sets the board's item name source (free / column / template); computed names are recomputed",
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(nameSourceSchema) },
      responses: { 200: json(nameSourceOutSchema, 'Name source'), ...common },
    }),
    async (c) => c.json(await putNameSource(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json'))),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/name-duplicates',
      tags: ['columns'],
      summary: 'Item names shared by more than one item of the board (a warning, never a block)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(nameDuplicatesSchema, 'Duplicate names'), ...common },
    }),
    async (c) => c.json(await nameDuplicates(db, actorOf(c), c.req.valid('param').boardId)),
  );

  return r;
};
