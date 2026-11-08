// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { restoredSchema, trashListSchema, undoRequestSchema, undoResultSchema } from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { redoEvent, undoBatch, undoEvent } from '../activity/undo.service';
import * as svc from './trash.service';

/** Trash (07 §5.2, 06 §2.20) and undo (07 §5.3). */
export const trashRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/trash',
      tags: ['trash'],
      summary: 'What is in trash: everything for admins, my own deletions for everyone else',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(trashListSchema, 'Trash'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await svc.listTrash(db, actorOf(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/trash/{id}/restore',
      tags: ['trash'],
      summary: 'Put an object back where it was (409 parent_in_trash when its board/item/folder is in trash)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(restoredSchema, 'Restored'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await svc.restoreFromTrash(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/trash/{id}',
      tags: ['trash'],
      summary: 'Delete permanently (removed by the next purge run)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...COMMON_ERRORS },
    }),
    async (c) => {
      await svc.deleteFromTrash(db, actorOf(c), c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/trash',
      tags: ['trash'],
      summary: 'Empty the trash (admins)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ ok: z.literal(true), count: z.number().int() }), 'Emptied'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ ok: true as const, count: await svc.emptyTrash(db, actorOf(c)) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/activity/{id}/undo',
      tags: ['activity'],
      summary: 'Undo an action (its whole batch when it has one); 409 changed_since unless force',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(undoRequestSchema) },
      responses: { 200: json(undoResultSchema, 'Undone'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await undoEvent(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').force), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/activity/{id}/redo',
      tags: ['activity'],
      summary: 'Redo an undone action (undoes what undid it); 409 changed_since unless force',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(undoRequestSchema) },
      responses: { 200: json(undoResultSchema, 'Redone'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await redoEvent(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').force), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/activity/batches/{id}/undo',
      tags: ['activity'],
      summary: 'Undo every action of a batch',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(undoRequestSchema) },
      responses: { 200: json(undoResultSchema, 'Undone'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await undoBatch(db, actorOf(c), c.req.valid('param').id, c.req.valid('json').force), 200),
  );

  return r;
};
