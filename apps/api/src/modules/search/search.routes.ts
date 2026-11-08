// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  addSearchRecentSchema,
  inboxCountSchema,
  inboxReadSchema,
  inboxSchema,
  searchRecentSchema,
  searchResultSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  clearRecentSearches,
  inboxUnread,
  markInboxRead,
  myInbox,
  recentSearches,
  rememberSearch,
  searchEverything,
} from './search.service';

/** Search everything (Ctrl+B, 07 §9.1) and the Inbox (07 §9.3). Neither is logged as an event (reads). */
export const searchRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/search',
      tags: ['search'],
      summary: 'Items (name or cell text), boards, updates and people matching `q` (2+ characters), within my access',
      middleware: scoped,
      request: {
        headers: accountHeader,
        query: z.object({
          q: z
            .string()
            .max(200)
            .openapi({ param: { name: 'q', in: 'query' } }),
          archived: z
            .enum(['1', 'true'])
            .optional()
            .openapi({ param: { name: 'archived', in: 'query' }, description: 'Include archived items' }),
        }),
      },
      responses: { 200: json(searchResultSchema, 'Results'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      const query = c.req.valid('query');
      return c.json(await searchEverything(db, actorOf(c), query.q, { archived: !!query.archived }), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/search/recent',
      tags: ['search'],
      summary: 'My recent searches in this account (newest first)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(searchRecentSchema, 'Recent searches'), ...errors(400, 401) },
    }),
    async (c) => c.json({ data: await recentSearches(db, actorOf(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/search/recent',
      tags: ['search'],
      summary: 'Remember a search (it moves to the top)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(addSearchRecentSchema) },
      responses: { 200: json(searchRecentSchema, 'Recent searches'), ...errors(400, 401) },
    }),
    async (c) => c.json({ data: await rememberSearch(db, actorOf(c), c.req.valid('json').q) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/search/recent',
      tags: ['search'],
      summary: 'Forget my recent searches',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(searchRecentSchema, 'Recent searches'), ...errors(400, 401) },
    }),
    async (c) => c.json({ data: await clearRecentSearches(db, actorOf(c)) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/inbox',
      tags: ['search'],
      summary: 'Updates and replies on items I follow, and mentions of me (6 months), newest first',
      middleware: scoped,
      request: {
        headers: accountHeader,
        query: z.object({
          before: z
            .string()
            .optional()
            .openapi({ param: { name: 'before', in: 'query' } }),
          mentions: z
            .enum(['1', 'true'])
            .optional()
            .openapi({ param: { name: 'mentions', in: 'query' }, description: 'Only updates that mention me' }),
          read: z
            .enum(['1', 'true'])
            .optional()
            .openapi({ param: { name: 'read', in: 'query' }, description: 'Include the ones I marked read' }),
        }),
      },
      responses: { 200: json(inboxSchema, 'Inbox'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(
        await myInbox(db, actorOf(c), { before: q.before, mentions: !!q.mentions, read: !!q.read }, deps.storage),
        200,
      );
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/inbox/count',
      tags: ['search'],
      summary: 'Unread Inbox entries (the badge next to the bell; counted up to 100)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(inboxCountSchema, 'Count'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await inboxUnread(db, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/inbox/read',
      tags: ['search'],
      summary: 'Mark Inbox entries read (`ids`, the V) or all of them (`all: true`); their notifications too',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(inboxReadSchema) },
      responses: {
        200: json(z.object({ ok: z.literal(true), unread: z.number().int() }), 'Marked'),
        ...errors(400, 401, 404),
      },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(await markInboxRead(db, actorOf(c), 'ids' in b ? b.ids : null), 200);
    },
  );

  return r;
};
