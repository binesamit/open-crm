// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  createViewSchema,
  updateViewSchema,
  viewLayoutSchema,
  viewListSchema,
  viewPrefsSchema,
  viewSchema,
  deletedSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './views.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const ifMatchHeader = accountHeader.extend({
  'if-match': z
    .string()
    .optional()
    .openapi({ param: { name: 'if-match', in: 'header' }, description: 'View revision being saved over (15 §7)' }),
});

/** Board views (15-VIEWS §8): shared/private views, default table, locking, personal prefs. */
export const viewRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/views',
      tags: ['views'],
      summary: 'Views of a board I can see (shared + my private), with my prefs and the view to open',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(viewListSchema, 'Views'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.listViews(db, actorOf(c), c.req.valid('param').boardId), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{boardId}/views/layout',
      tags: ['views'],
      summary: 'Save my tab layout on a board: pinned views (first) and my order — personal',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(viewLayoutSchema) },
      responses: { 200: json(viewListSchema, 'Views in my order'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.saveLayout(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/views',
      tags: ['views'],
      summary: 'Create a view (e.g. "save as new view" from the current draft)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(createViewSchema) },
      responses: { 201: json(viewSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.createView(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/views/{id}',
      tags: ['views'],
      summary: 'Save settings / rename / lock / set default / reorder / make shared (If-Match on settings)',
      middleware: scoped,
      request: { headers: ifMatchHeader, params: idParam, ...jsonBody(updateViewSchema) },
      responses: { 200: json(viewSchema, 'View'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(
        await svc.updateView(
          db,
          actorOf(c),
          c.req.valid('param').id,
          c.req.valid('json'),
          svc.parseIfMatch(c.req.valid('header')['if-match']),
        ),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/views/{id}',
      tags: ['views'],
      summary: 'Delete a view (not the default table)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(deletedSchema, 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const event_id = await svc.deleteView(db, actorOf(c), c.req.valid('param').id);
      return c.json({ ok: true as const, event_id }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/views/{id}/duplicate',
      tags: ['views'],
      summary: 'Duplicate a view, on its board or onto another (board_id)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        ...jsonBody(
          z.object({
            name: z.string().trim().min(1).max(120).optional(),
            /** Copy onto another board: columns are matched by key/title and type; the rest is dropped. */
            board_id: z.string().optional(),
          }),
        ),
      },
      responses: { 201: json(viewSchema, 'Created'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const body = c.req.valid('json');
      return c.json(await svc.duplicateView(db, actorOf(c), c.req.valid('param').id, body.name, body.board_id), 201);
    },
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/views/{id}/prefs',
      tags: ['views'],
      summary: 'Save my personal overrides (column widths, collapsed groups, wrap) — merged',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(viewPrefsSchema) },
      responses: { 200: json(viewSchema, 'View'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.savePrefs(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/views/{id}/prefs',
      tags: ['views'],
      summary: 'Drop my personal overrides of a view',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(viewSchema, 'View'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.resetPrefs(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/views/{id}/open',
      tags: ['views'],
      summary: 'Remember this view as the one I opened last on its board',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Done'), ...COMMON_ERRORS },
    }),
    async (c) => {
      await svc.openView(db, actorOf(c), c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
};
