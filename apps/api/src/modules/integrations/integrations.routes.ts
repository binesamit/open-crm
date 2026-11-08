// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  boardListEntrySchema,
  boardListQuerySchema,
  boardSchemaSchema,
  columnChoicesQuerySchema,
  columnChoicesSchema,
  findItemsSchema,
  itemSchema,
  scopeAllows,
  boardFieldsQuerySchema,
  integrationFieldSchema,
  itemFormatQuerySchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './integrations.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const common = errors(400, 401, 403, 404, 422);

/** Integration helpers for n8n / Make apps: a flat board list, a board's schema, find by column value. */
export const integrationRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards',
      tags: ['boards'],
      summary: 'The boards I can open, flat across workspaces (pickers); `q` filters by name',
      middleware: scoped,
      request: { headers: accountHeader, query: boardListQuerySchema },
      responses: { 200: json(z.object({ data: z.array(boardListEntrySchema) }), 'Boards'), ...common },
    }),
    async (c) => c.json(await svc.listBoardsFlat(db, actorOf(c), c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/schema',
      tags: ['boards'],
      summary: "A board's groups and columns with type, options and value schema (dynamic fields)",
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(boardSchemaSchema, 'Board schema'), ...common },
    }),
    async (c) => c.json(await svc.boardSchema(db, actorOf(c), c.req.valid('param').boardId), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/items/find',
      tags: ['items'],
      summary: 'Find items by a column value (phone by digits, email case-insensitive)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: boardParam,
        query: itemFormatQuerySchema,
        ...jsonBody(findItemsSchema),
      },
      responses: { 200: json(z.object({ data: z.array(itemSchema) }), 'Matches'), ...common },
    }),
    async (c) => {
      const found = await svc.findItems(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json'));
      return c.json({ data: await svc.flatListIf(db, c.req.valid('query').format, found.data) }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/fields',
      tags: ['boards'],
      summary:
        "The column-values form: one input field per writable column, in its type (integrations' dynamic fields)",
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, query: boardFieldsQuerySchema },
      responses: { 200: json(z.object({ data: z.array(integrationFieldSchema) }), 'Fields'), ...common },
    }),
    async (c) =>
      c.json(await svc.boardFields(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('query').subitems), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/columns/{columnId}/choices',
      tags: ['boards'],
      summary:
        'The values a column can hold, for value pickers: labels, people, tags, linked items (by name) or existing values',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: z.object({
          boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }),
          columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }),
        }),
        query: columnChoicesQuerySchema,
      },
      responses: { 200: json(columnChoicesSchema, 'Choices'), ...common },
    }),
    async (c) => {
      const { boardId, columnId } = c.req.valid('param');
      const token = c.get('token');
      // People's emails only for a session or a token that may read users.
      const withEmails = !token || scopeAllows(token.scopes, 'users:read');
      return c.json(
        await svc.columnChoices(deps, actorOf(c), boardId, columnId, { ...c.req.valid('query'), withEmails }),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}/subitems',
      tags: ['items'],
      summary: 'The subitems right under an item, in their order (with their cells)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) }),
        query: itemFormatQuerySchema,
      },
      responses: { 200: json(z.object({ data: z.array(itemSchema) }), 'Subitems'), ...common },
    }),
    async (c) => {
      const subs = await svc.listSubitems(db, actorOf(c), c.req.valid('param').id);
      return c.json({ data: await svc.flatListIf(db, c.req.valid('query').format, subs.data) }, 200);
    },
  );
  return r;
};
