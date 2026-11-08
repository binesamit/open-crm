// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  boardNotificationsSchema,
  followSchema,
  markReadSchema,
  notificationListSchema,
  notificationSettingsSchema,
  patchNotificationSettingsSchema,
  setBoardNotificationsSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { loadItem } from '../items/items.service';
import {
  boardNotifications,
  listMyNotifications,
  markMyNotificationsRead,
  myFollow,
  mySettings,
  setBoardNotifications,
  setMyFollow,
  updateMySettings,
} from './notifications.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });

const listQuery = z.object({
  before: z
    .string()
    .optional()
    .openapi({ param: { name: 'before', in: 'query' }, description: '`next_cursor` of the previous page' }),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .openapi({ param: { name: 'limit', in: 'query' } }),
  unread: z
    .enum(['1', 'true'])
    .optional()
    .openapi({ param: { name: 'unread', in: 'query' }, description: 'Only unread ones' }),
});

/** The bell (07 §9.3): my notifications in this account. New ones also arrive on `GET /me/events`. */
export const notificationRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/notifications',
      tags: ['notifications'],
      summary: 'My notifications, newest first, with the unread count',
      middleware: scoped,
      request: { headers: accountHeader, query: listQuery },
      responses: { 200: json(notificationListSchema, 'Notifications'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      const q = c.req.valid('query');
      return c.json(await listMyNotifications(db, actorOf(c), { ...q, unread: !!q.unread }), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/notifications/read',
      tags: ['notifications'],
      summary: 'Mark some (`ids`) or all (`all: true`) of my notifications read',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(markReadSchema) },
      responses: {
        200: json(z.object({ ok: z.literal(true), unread_count: z.number().int() }), 'Marked'),
        ...errors(400, 401, 404),
      },
    }),
    async (c) => {
      const body = c.req.valid('json');
      return c.json(await markMyNotificationsRead(db, actorOf(c), 'ids' in body ? body.ids : null), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/notifications/settings',
      tags: ['notifications'],
      summary: 'My notification settings in this account (08 §12.3): bell / email per category, digest, muted boards',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(notificationSettingsSchema, 'Settings'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await mySettings(db, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/me/notifications/settings',
      tags: ['notifications'],
      summary: 'Change some categories and/or the digest',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(patchNotificationSettingsSchema) },
      responses: { 200: json(notificationSettingsSchema, 'Settings'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updateMySettings(db, actorOf(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/notifications',
      tags: ['notifications'],
      summary: "A board's notifications for me: my mute and the owners' mute for everyone (08 §12.2)",
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(boardNotificationsSchema, 'Board notifications'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await boardNotifications(db, actorOf(c), c.req.valid('param').boardId), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{boardId}/notifications',
      tags: ['notifications'],
      summary: 'Mute a board for me; `muted_for_everyone` — board owners and admins',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(setBoardNotificationsSchema) },
      responses: { 200: json(boardNotificationsSchema, 'Board notifications'), ...errors(400, 401, 403, 404) },
    }),
    async (c) =>
      c.json(await setBoardNotifications(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/items/{id}/follow',
      tags: ['notifications'],
      summary: 'Do I follow this item (updates on it notify me)?',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(followSchema, 'Follow'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      const a = actorOf(c);
      const { item } = await loadItem(db, a, c.req.valid('param').id);
      return c.json(await myFollow(db, a, item), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/items/{id}/follow',
      tags: ['notifications'],
      summary: 'Follow / unfollow an item (an unfollow is remembered against automatic following)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(followSchema) },
      responses: { 200: json(followSchema, 'Follow'), ...errors(400, 401, 404) },
    }),
    async (c) => {
      const a = actorOf(c);
      const { item } = await loadItem(db, a, c.req.valid('param').id);
      return c.json(await setMyFollow(db, a, item, c.req.valid('json').following), 200);
    },
  );

  return r;
};
