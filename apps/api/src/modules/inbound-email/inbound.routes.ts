// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { AppError, inboundAddressSchema, type InboundKind } from '@bines/shared';
import { actorOf, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, idParam, json } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { emailImage } from './email-images';
import * as svc from './inbound.service';

/** Notices of the provider are small (metadata only — the message is fetched by the job). */
const MAX_WEBHOOK_BYTES = 256 * 1024;
const common = errors(400, 401, 403, 404);

/** Incoming email: the provider's webhook, and the addresses of items and boards. */
export const inboundEmailRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  // No session, no token: the provider's signature (svix-* headers) over the raw body — unsigned = 401.
  r.openapi(
    createRoute({
      method: 'post',
      path: '/hooks/email/resend',
      tags: ['inbound-email'],
      summary: "The mail provider's signed `email.received` notice → the message is queued for its item / board",
      request: {
        headers: z.object({
          'svix-id': z.string().optional(),
          'svix-timestamp': z.string().optional(),
          'svix-signature': z.string().optional(),
        }),
      },
      responses: { 200: json(z.object({ received: z.literal(true) }), 'Received'), ...errors(400, 401, 413, 429) },
    }),
    async (c) => {
      const raw = await c.req.text();
      if (raw.length > MAX_WEBHOOK_BYTES) throw new AppError('payload_too_large', 'Payload too large');
      const headers = {
        id: c.req.header('svix-id'),
        timestamp: c.req.header('svix-timestamp'),
        signature: c.req.header('svix-signature'),
      };
      return c.json(await svc.receiveWebhook(deps, raw, headers, c.get('clientIp')), 200);
    },
  );

  // an incoming email's image in its update. Loaded by <img>, so the account may come in the query.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/updates/{id}/email-images/{ref}',
      tags: ['inbound-email'],
      summary: "An image in an update's text, as the update shows it",
      description:
        "`ref` is `asset:<file id>` (an image of the update, kept as one of its files — an incoming email's body " +
        'image, or one pasted / uploaded into the text (an `image` node `{src: "asset:<file id>"}`): redirects to its ' +
        'short link) or `remote:<n>` (the n-th image the message loads from the web: fetched by the server and passed on, ' +
        'never stored — the sender does not learn who read it). Whoever may read the item; 404 otherwise, and for ' +
        "images from the web while the account's incoming-email setting does not show them.",
      middleware: [requireAccount(deps, { query: true })],
      request: {
        params: idParam.extend({
          ref: z
            .string()
            .max(40)
            .openapi({ param: { name: 'ref', in: 'path' } }),
        }),
        query: z.object({ account_id: z.string().optional() }),
      },
      responses: {
        200: {
          description: 'The image (PNG, JPEG, GIF, WebP or AVIF bytes)',
          content: { 'image/*': { schema: z.string(), example: '(the image bytes)' } },
        },
        302: { description: 'An image of the body: its short-lived link' },
        ...errors(401, 403, 404),
      },
    }),
    async (c) => {
      const { id, ref } = c.req.valid('param');
      const img = await emailImage(deps, actorOf(c), id, ref);
      if ('redirect' in img) return c.redirect(img.redirect, 302) as never;
      return new Response(new Uint8Array(img.body), {
        status: 200,
        headers: {
          'content-type': img.mime,
          'cache-control': 'private, max-age=86400',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'",
        },
      }) as never;
    },
  );

  const target = (kind: InboundKind, path: string, noun: string) => {
    r.openapi(
      createRoute({
        method: 'get',
        path,
        tags: ['inbound-email'],
        summary: `The ${noun}'s email address (null until made, or while incoming email is off)`,
        middleware: scoped,
        request: { headers: accountHeader, params: idParam },
        responses: { 200: json(inboundAddressSchema, 'Address'), ...common },
      }),
      async (c) => c.json(await svc.getAddress(db, actorOf(c), kind, c.req.valid('param').id), 200),
    );
    r.openapi(
      createRoute({
        method: 'post',
        path,
        tags: ['inbound-email'],
        summary: `The ${noun}'s email address — made on first use`,
        middleware: scoped,
        request: { headers: accountHeader, params: idParam },
        responses: { 200: json(inboundAddressSchema, 'Address'), ...common },
      }),
      async (c) => c.json(await svc.ensureAddress(db, actorOf(c), kind, c.req.valid('param').id), 200),
    );
    r.openapi(
      createRoute({
        method: 'post',
        path: `${path}/rotate`,
        tags: ['inbound-email'],
        summary: `A new email address for the ${noun}; the old one stops working for good`,
        middleware: scoped,
        request: { headers: accountHeader, params: idParam },
        responses: { 200: json(inboundAddressSchema, 'Address'), ...common },
      }),
      async (c) => c.json(await svc.rotateAddress(db, actorOf(c), kind, c.req.valid('param').id), 200),
    );
    r.openapi(
      createRoute({
        method: 'delete',
        path,
        tags: ['inbound-email'],
        summary: `Retires the ${noun}'s email address (mail to it is dropped)`,
        middleware: scoped,
        request: { headers: accountHeader, params: idParam },
        responses: { 200: json(inboundAddressSchema, 'Address'), ...common },
      }),
      async (c) => c.json(await svc.removeAddress(db, actorOf(c), kind, c.req.valid('param').id), 200),
    );
  };
  target('item', '/items/{id}/email-address', 'item');
  target('board', '/boards/{id}/email-address', 'board');
  return r;
};
