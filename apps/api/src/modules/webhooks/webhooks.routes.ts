// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AppError,
  createWebhookSchema,
  updateWebhookSchema,
  webhookDeliverySchema,
  webhookSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { MAX_PAYLOAD_BYTES, receiveInbound } from './inbound';
import * as svc from './webhooks.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const common = errors(400, 401, 403, 404, 422);

/** Board webhooks (06 §2.17) and the inbound automation hook (04 §2 webhook_in). */
export const webhookRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/webhooks',
      tags: ['webhooks'],
      summary: "The board's webhooks (owners and admins)",
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(z.object({ data: z.array(webhookSchema) }), 'Webhooks'), ...common },
    }),
    async (c) => c.json(await svc.listWebhooks(db, actorOf(c), c.req.valid('param').boardId), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/webhooks',
      tags: ['webhooks'],
      summary: 'Subscribe a URL to a board event — the URL must answer the challenge first',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(createWebhookSchema) },
      responses: { 201: json(webhookSchema, 'Created'), ...common },
    }),
    async (c) =>
      c.json(await svc.createWebhook(deps, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/webhooks/{id}',
      tags: ['webhooks'],
      summary: 'One webhook (an integration checks its subscription still exists)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(webhookSchema, 'Webhook'), ...common },
    }),
    async (c) => c.json(await svc.getWebhook(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/webhooks/{id}',
      tags: ['webhooks'],
      summary: 'Change URL (re-handshake), config, description, on/off',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateWebhookSchema) },
      responses: { 200: json(webhookSchema, 'Webhook'), ...common },
    }),
    async (c) => c.json(await svc.updateWebhook(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/webhooks/{id}',
      tags: ['webhooks'],
      summary: 'Delete a webhook',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...common },
    }),
    async (c) => c.json(await svc.deleteWebhook(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks/{id}/rotate-secret',
      tags: ['webhooks'],
      summary: 'A new signing secret',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(webhookSchema, 'Webhook'), ...common },
    }),
    async (c) => c.json(await svc.rotateSecret(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/webhooks/{id}/deliveries',
      tags: ['webhooks'],
      summary: 'Delivery log, newest first',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, query: z.object({ before: z.string().optional() }) },
      responses: {
        200: json(z.object({ data: z.array(webhookDeliverySchema), next: z.string().nullable() }), 'Deliveries'),
        ...common,
      },
    }),
    async (c) =>
      c.json(await svc.listDeliveries(db, actorOf(c), c.req.valid('param').id, c.req.valid('query').before), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks/deliveries/{id}/redeliver',
      tags: ['webhooks'],
      summary: 'Send a delivery again now',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(webhookDeliverySchema, 'Delivery'), ...common },
    }),
    async (c) => c.json(await svc.redeliver(deps, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/webhooks/{id}/test',
      tags: ['webhooks'],
      summary: 'Send a synthetic ping',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(webhookDeliverySchema, 'Delivery'), ...common },
    }),
    async (c) => c.json(await svc.pingWebhook(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  // Inbound: no session, no token — the automation id plus its secret (X-Bines-Secret header only, S-11).
  r.openapi(
    createRoute({
      method: 'post',
      path: '/hooks/in/{id}',
      tags: ['webhooks'],
      summary: 'Inbound webhook → runs the automation (the automation secret in the X-Bines-Secret header)',
      request: { params: idParam, headers: z.object({ 'x-bines-secret': z.string().optional() }) },
      responses: {
        202: json(z.object({ event_id: z.string(), item_id: z.string().nullable() }), 'Accepted'),
        ...errors(401, 404, 413, 429),
      },
    }),
    async (c) => {
      const raw = await c.req.text();
      if (raw.length > MAX_PAYLOAD_BYTES) throw new AppError('payload_too_large', 'Payload too large');
      let payload: unknown = {};
      try {
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        payload = { raw: raw.slice(0, 2000) };
      }
      // A secret in the URL ends up in proxy and access logs: refused outright, with a pointer to the header.
      if (c.req.query('secret') !== undefined) throw new AppError('unauthenticated', 'secret_must_be_in_header');
      const secret = c.req.header('x-bines-secret');
      return c.json(await receiveInbound(db, c.req.valid('param').id, payload, secret, c.get('clientIp')), 202);
    },
  );
  return r;
};
