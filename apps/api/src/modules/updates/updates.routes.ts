// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  activityEntrySchema,
  boardActivityQuerySchema,
  createUpdateSchema,
  editUpdateSchema,
  itemSchema,
  markUpdateViewsResultSchema,
  markUpdateViewsSchema,
  reactionParamSchema,
  updateViewsSchema,
  updateEntrySchema,
  updateSchema,
  updateTaskParamSchema,
  updateTaskSchema,
  deletedSchema,
  itemFormatQuerySchema,
} from '@bines/shared';
import { flatIf } from '../integrations/integrations.service';
import { secretWriterOf } from '../secrets/secrets.routes';
import { currentUser, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { getItem } from '../items/items.service';
import { RateLimiter, rateLimit } from '../../lib/rate-limit';
import * as svc from './updates.service';
import { deviceOf } from './device';
import { listViewers, markViewed } from './views.service';

/**
 * "Seen" reports per person: the web batches every few seconds, so 60 a minute leaves room for several tabs and
 * devices while a runaway client cannot turn it into a write storm.
 */
const viewReports = new RateLimiter(60, 60_000);

const common = errors(400, 401, 403, 404, 422, 423);
const tags = ['updates'];

/** Item card: the item, its Updates thread and its activity (06 §2.9, §2.13, §2.19). */
export const updateRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const middleware = [requireAccount(deps)];
  const params = { headers: accountHeader, params: idParam };
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}',
      tags,
      summary: 'One item with its cells',
      middleware,
      request: { ...params, query: itemFormatQuerySchema },
      responses: { 200: json(itemSchema, 'Item'), ...common },
    }),
    async (c) =>
      c.json(
        await flatIf(db, c.req.valid('query').format, await getItem(db, actorOf(c), c.req.valid('param').id)),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}/updates',
      tags,
      summary: 'Updates thread (newest first; replies oldest first)',
      middleware,
      request: params,
      responses: { 200: json(z.object({ data: z.array(updateSchema) }), 'Updates'), ...common },
    }),
    async (c) => c.json({ data: await svc.listUpdates(db, actorOf(c), c.req.valid('param').id, deps.storage) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/updates',
      tags,
      summary: 'Post an update (mentions as [@Name](user:id))',
      middleware,
      request: { ...params, ...jsonBody(createUpdateSchema) },
      responses: { 200: json(updateEntrySchema, 'Update'), ...common },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(
        await svc.createUpdate(db, actorOf(c), c.req.valid('param').id, b, b.file_ids, secretWriterOf(deps, c)),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/updates/{id}/replies',
      tags,
      summary: 'Reply to an update',
      middleware,
      request: { ...params, ...jsonBody(createUpdateSchema) },
      responses: { 200: json(updateEntrySchema, 'Reply'), ...common },
    }),
    async (c) => {
      const b = c.req.valid('json');
      return c.json(
        await svc.replyToUpdate(db, actorOf(c), c.req.valid('param').id, b, b.file_ids, secretWriterOf(deps, c)),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/updates/{id}',
      tags,
      summary: 'Edit my update or reply: its text and its files (file_ids to attach, remove_file_ids to take off)',
      middleware,
      request: { ...params, ...jsonBody(editUpdateSchema) },
      responses: { 200: json(updateEntrySchema, 'Update'), ...common },
    }),
    async (c) => {
      const { file_ids, remove_file_ids, ...text } = c.req.valid('json');
      return c.json(
        await svc.editOwnUpdate(
          deps,
          actorOf(c),
          c.req.valid('param').id,
          text,
          {
            add: file_ids,
            remove: remove_file_ids,
          },
          secretWriterOf(deps, c),
        ),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/updates/{id}/tasks/{index}',
      tags,
      summary: 'Tick or clear one check box of an update or reply (index from 0, in order) — whoever may comment',
      middleware,
      request: { headers: accountHeader, params: updateTaskParamSchema, ...jsonBody(updateTaskSchema) },
      responses: { 200: json(updateEntrySchema, 'Update'), ...common },
    }),
    async (c) => {
      const { id, index } = c.req.valid('param');
      return c.json(await svc.setUpdateTask(db, actorOf(c), id, index, c.req.valid('json').checked), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/updates/{id}',
      tags,
      summary: 'Delete an update (author, board owner or admin)',
      middleware,
      request: params,
      responses: { 200: json(deletedSchema, 'Deleted'), ...common },
    }),
    async (c) => {
      const event_id = await svc.deleteUpdate(db, actorOf(c), c.req.valid('param').id, secretWriterOf(deps, c));
      return c.json({ ok: true as const, event_id }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/updates/{id}/files/{fileId}',
      tags,
      summary: 'Remove a file attached to an update (author, board owner or admin)',
      middleware,
      request: {
        headers: accountHeader,
        params: idParam.extend({ fileId: z.string().openapi({ param: { name: 'fileId', in: 'path' } }) }),
      },
      responses: { 200: json(okSchema, 'Removed'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      await svc.removeUpdateFile(deps, actorOf(c), p.id, p.fileId);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/updates/{id}/like',
      tags,
      summary: 'Like',
      middleware,
      request: params,
      responses: { 200: json(okSchema, 'Liked'), ...common },
    }),
    async (c) => {
      await svc.setLike(db, actorOf(c), c.req.valid('param').id, true);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/updates/{id}/like',
      tags,
      summary: 'Unlike',
      middleware,
      request: params,
      responses: { 200: json(okSchema, 'Unliked'), ...common },
    }),
    async (c) => {
      await svc.setLike(db, actorOf(c), c.req.valid('param').id, false);
      return c.json({ ok: true as const }, 200);
    },
  );
  for (const method of ['put', 'delete'] as const) {
    r.openapi(
      createRoute({
        method,
        path: '/updates/{id}/reactions/{reaction}',
        tags,
        summary: method === 'put' ? 'Add my reaction' : 'Remove my reaction',
        middleware,
        request: { headers: accountHeader, params: reactionParamSchema },
        responses: { 200: json(okSchema, 'Done'), ...common },
      }),
      async (c) => {
        const { id, reaction } = c.req.valid('param');
        await svc.setReaction(db, actorOf(c), id, reaction, method === 'put');
        return c.json({ ok: true as const }, 200);
      },
    );
  }
  r.openapi(
    createRoute({
      method: 'post',
      path: '/updates/views',
      tags,
      summary: 'Report updates and replies I saw on screen (device from the request headers)',
      middleware: [...middleware, rateLimit(viewReports, (c) => `views:${currentUser(c).id}`)],
      request: { headers: accountHeader, ...jsonBody(markUpdateViewsSchema) },
      responses: { 200: json(markUpdateViewsResultSchema, 'Recorded'), ...errors(400, 401, 404, 422, 429) },
    }),
    async (c) => {
      const device = deviceOf(c.req.header('user-agent'), c.req.header('sec-ch-ua-mobile'));
      const recorded = await markViewed(db, actorOf(c), c.req.valid('json').update_ids, device);
      return c.json({ ok: true as const, recorded }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/updates/{id}/views',
      tags,
      summary: 'Who saw an update or reply, on which devices (not for guests)',
      middleware,
      request: params,
      responses: { 200: json(updateViewsSchema, 'Viewers'), ...common },
    }),
    async (c) => c.json({ data: await listViewers(db, actorOf(c), c.req.valid('param').id, deps.storage) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}/activity',
      tags,
      summary: 'Item activity (not for guests)',
      middleware,
      request: params,
      responses: { 200: json(z.object({ data: z.array(activityEntrySchema) }), 'Activity'), ...common },
    }),
    async (c) => c.json({ data: await svc.itemActivity(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{id}/activity',
      tags,
      summary:
        "A board's activity log with its subitems' (Ctrl+Shift+L); a batch is one row; filterable (not for guests)",
      middleware,
      request: { ...params, query: boardActivityQuerySchema },
      responses: {
        200: json(z.object({ data: z.array(activityEntrySchema), next_before: z.string().nullable() }), 'Activity'),
        ...common,
      },
    }),
    async (c) => c.json(await svc.boardActivity(db, actorOf(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{id}/update-counts',
      tags,
      summary: 'Top-level updates per item of the board (the count on rows), only items the viewer may see',
      middleware,
      request: params,
      responses: { 200: json(z.object({ counts: z.record(z.string(), z.number().int()) }), 'Counts'), ...common },
    }),
    async (c) => c.json({ counts: await svc.boardUpdateCounts(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  return r;
};
