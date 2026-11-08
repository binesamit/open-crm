// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  PWA_ICONS,
  type PwaIcon,
  pushEndpointSchema,
  pushSubscriptionInputSchema,
  pushSubscriptionListSchema,
  pushSubscriptionSchema,
  pwaConfigSchema,
  pwaStatusSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requireAccount, requireUser } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  buildManifest,
  mySubscriptions,
  pwaConfig,
  pwaStatus,
  renderIcon,
  subscribe,
  unsubscribe,
  unsubscribeEndpoint,
} from './pwa.service';

const iconParam = z.object({
  icon: z
    .string()
    .regex(new RegExp(`^(${PWA_ICONS.join('|')})\\.png$`))
    .openapi({ param: { name: 'icon', in: 'path' }, example: '192.png' }),
});
const accountIconParam = idParam.extend(iconParam.shape);
const iconOf = (file: string) => file.replace(/\.png$/, '') as PwaIcon;

/**
 * The phone app (PWA, the planning notes "PWA"). Public: the manifest and icons per account (browsers fetch them while
 * installing, without asking us who they are) and the service worker's kill switch. Signed in: the app's config in
 * an account and my phones registered for push.
 */
export const pwaRoutes = (deps: AppDeps) => {
  const scoped = [requireAccount(deps)];
  const actor = (c: Context<AppEnv>) => ({
    ctx: c.get('account'),
    user: currentUser(c),
    sessionId: c.get('sessionId') ?? null,
  });
  const r = new OpenAPIHono<AppEnv>();

  const manifest = (c: Context<AppEnv>, body: unknown) => {
    c.header('content-type', 'application/manifest+json; charset=utf-8');
    // The name and colour may change any time; the browser revalidates each launch.
    c.header('cache-control', 'no-cache');
    return c.body(JSON.stringify(body), 200);
  };
  const png = (c: Context<AppEnv>, bytes: Buffer) => {
    c.header('content-type', 'image/png');
    // The address carries the logo and colour version.
    c.header('cache-control', 'public, max-age=86400');
    return c.body(new Uint8Array(bytes), 200);
  };

  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/pwa/manifest.webmanifest',
      tags: ['pwa'],
      summary: "Public: the platform's web app manifest (sign-in page)",
      responses: { 200: { description: 'application/manifest+json' } },
    }),
    async (c) => manifest(c, await buildManifest(deps, null)),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/pwa/icon/{icon}',
      tags: ['pwa'],
      summary: "Public: one of the platform's app icons (PNG)",
      request: { params: iconParam },
      responses: { 200: { description: 'image/png' }, ...errors(400) },
    }),
    async (c) => png(c, await renderIcon(deps, null, iconOf(c.req.valid('param').icon))),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/pwa/a/{id}/manifest.webmanifest',
      tags: ['pwa'],
      summary: "Public: an account's web app manifest (its name, colour, icons and first screen)",
      request: { params: idParam },
      responses: { 200: { description: 'application/manifest+json' }, ...errors(404) },
    }),
    async (c) => manifest(c, await buildManifest(deps, c.req.valid('param').id)),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/pwa/a/{id}/icon/{icon}',
      tags: ['pwa'],
      summary: "Public: one of an account's app icons (PNG, from its logo)",
      request: { params: accountIconParam },
      responses: { 200: { description: 'image/png' }, ...errors(400, 404) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return png(c, await renderIcon(deps, p.id, iconOf(p.icon)));
    },
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/pwa/status',
      tags: ['pwa'],
      summary: "Public: the service worker's kill switch and the server's build",
      responses: { 200: json(pwaStatusSchema, 'Status') },
    }),
    async (c) => c.json(await pwaStatus(deps), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/pwa/config',
      tags: ['pwa'],
      summary: 'The phone app in this account: push availability and key, install suggestion, manifest',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(pwaConfigSchema, 'Config'), ...errors(401, 404) },
    }),
    async (c) => c.json(await pwaConfig(deps, c.get('account')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/me/push-subscriptions',
      tags: ['pwa'],
      summary: 'My phones / browsers that get push in this account (`endpoint` marks the current one)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        query: z.object({
          endpoint: z
            .string()
            .max(2048)
            .optional()
            .openapi({ param: { name: 'endpoint', in: 'query' } }),
        }),
      },
      responses: { 200: json(pushSubscriptionListSchema, 'Devices'), ...errors(401, 404) },
    }),
    async (c) => c.json(await mySubscriptions(deps, actor(c), c.req.valid('query').endpoint), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/push-subscriptions',
      tags: ['pwa'],
      summary: 'Register this browser for push in this account (the PushManager subscription)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(pushSubscriptionInputSchema) },
      responses: { 201: json(pushSubscriptionSchema, 'Registered'), ...errors(400, 401, 403, 404) },
    }),
    async (c) => c.json(await subscribe(deps, actor(c), c.req.valid('json'), c.req.header('user-agent')), 201),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/me/push-subscriptions/{id}',
      tags: ['pwa'],
      summary: 'Remove one of my devices from push in this account',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Removed'), ...errors(401, 404) },
    }),
    async (c) => c.json(await unsubscribe(deps, actor(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/me/push-subscriptions/unsubscribe',
      tags: ['pwa'],
      summary: "Sign-out: this browser's push endpoint leaves all my accounts",
      middleware: [requireUser()],
      request: jsonBody(pushEndpointSchema),
      responses: {
        200: json(z.object({ ok: z.literal(true), removed: z.number().int() }), 'Removed'),
        ...errors(400, 401),
      },
    }),
    async (c) => c.json(await unsubscribeEndpoint(deps, currentUser(c), c.req.valid('json').endpoint), 200),
  );
  return r;
};
