// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { ARCHIVE_TYPES, archiveListSchema, deletedSchema, unarchivedSchema } from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, idParam, json, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './archive.service';

const boardParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const groupParams = z.object({
  boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }),
  groupId: z.string().openapi({ param: { name: 'groupId', in: 'path' } }),
});
const restoreParams = z.object({
  type: z.enum(ARCHIVE_TYPES).openapi({ param: { name: 'type', in: 'path' } }),
  id: z.string().openapi({ param: { name: 'id', in: 'path' } }),
});
const archived = { 200: json(deletedSchema, 'Archived — event_id for undo'), ...COMMON_ERRORS };

/** Archive (07 §5.1): items, groups, boards — out of sight, kept forever, back from the archive page or undo. */
export const archiveRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/archive',
      tags: ['archive'],
      summary: 'Archive an item (delete right)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: archived,
    }),
    async (c) =>
      c.json({ ok: true as const, event_id: await svc.archiveItem(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/groups/{groupId}/archive',
      tags: ['archive'],
      summary: 'Archive a group with its items (not the last group)',
      middleware: scoped,
      request: { headers: accountHeader, params: groupParams },
      responses: archived,
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json({ ok: true as const, event_id: await svc.archiveGroup(db, actorOf(c), p.boardId, p.groupId) }, 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{id}/archive',
      tags: ['archive'],
      summary: 'Archive a board (owner / admin)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: archived,
    }),
    async (c) =>
      c.json({ ok: true as const, event_id: await svc.archiveBoard(db, actorOf(c), c.req.valid('param').id) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/archive',
      tags: ['archive'],
      summary: 'Archived items, groups and boards on boards I can read, newest first',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(archiveListSchema, 'Archive'), ...COMMON_ERRORS },
    }),
    async (c) => c.json({ data: await svc.listArchive(db, actorOf(c)) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/archive/{type}/{id}/restore',
      tags: ['archive'],
      summary: 'Bring an archived item / group / board back',
      middleware: scoped,
      request: { headers: accountHeader, params: restoreParams },
      responses: { 200: json(unarchivedSchema, 'Restored'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.restoreArchived(db, actorOf(c), p.type, p.id), 200);
    },
  );
  return r;
};
