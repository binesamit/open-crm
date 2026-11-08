// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  AppError,
  EXT_STORAGE_SCOPES,
  extStorageEntrySchema,
  extStorageListSchema,
  putExtStorageSchema,
  extIntrospectSchema,
  extIntrospectionSchema,
  appPageBadgeSchema,
  setAppPageBadgeSchema,
  extAutomationListSchema,
  extAutomationsQuerySchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { fireExtensionTrigger, MAX_FIRE_BYTES } from './ext-automation';
import { introspectExtToken } from './ext-introspect';
import { setBadgeAsExtension } from './app-pages';
import { listExtAutomations } from './ext-automations';
import * as store from './ext-storage';

const scopeParam = z.object({
  scope: z.enum(EXT_STORAGE_SCOPES).openapi({ param: { name: 'scope', in: 'path' } }),
});
const keyParam = scopeParam.extend({
  key: z
    .string()
    .max(200)
    .openapi({ param: { name: 'key', in: 'path' } }),
});

/**
 * The extension's own API (D27 ת5) — called by its page with its token: storage per installation / user and file
 * uploads. And (ת4) the trigger its server fires — no session, signed with the installation's secret.
 */
export const extRoutes = (deps: AppDeps) => {
  const scoped = [requireAccount(deps)];
  const actor = (c: Context<AppEnv>): store.ExtActor => ({
    ctx: c.get('account'),
    user: currentUser(c),
    token: c.get('token'),
  });
  const r = new OpenAPIHono<AppEnv>();
  const tags = ['extensions'];

  r.openapi(
    createRoute({
      method: 'get',
      path: '/ext/storage/{scope}',
      tags,
      summary: "Extension token: its storage keys (the installation's shared keys, or this user's)",
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: scopeParam,
        query: z.object({ prefix: z.string().max(200).optional() }),
      },
      responses: { 200: json(extStorageListSchema, 'Keys'), ...errors(400, 401, 403, 404) },
    }),
    async (c) =>
      c.json(
        await store.listExtStorage(deps, actor(c), c.req.valid('param').scope, c.req.valid('query').prefix ?? ''),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/ext/storage/{scope}/{key}',
      tags,
      summary: 'Extension token: one stored value',
      middleware: scoped,
      request: { headers: accountHeader, params: keyParam },
      responses: { 200: json(extStorageEntrySchema, 'Value'), ...errors(400, 401, 403, 404, 422) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await store.getExtStorage(deps, actor(c), p.scope, p.key), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/ext/storage/{scope}/{key}',
      tags,
      summary: 'Extension token: store a JSON value (64 KB each, 1 MB per installation)',
      middleware: scoped,
      request: { headers: accountHeader, params: keyParam, ...jsonBody(putExtStorageSchema) },
      responses: {
        200: json(
          z.object({ key: z.string(), size: z.number(), used_bytes: z.number(), quota_bytes: z.number() }),
          'Stored',
        ),
        ...errors(400, 401, 403, 413, 422),
      },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await store.putExtStorage(deps, actor(c), p.scope, p.key, c.req.valid('json').value), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/ext/storage/{scope}/{key}',
      tags,
      summary: 'Extension token: remove a stored value',
      middleware: scoped,
      request: { headers: accountHeader, params: keyParam },
      responses: { 200: json(okSchema, 'Removed'), ...errors(400, 401, 403, 404, 422) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await store.deleteExtStorage(deps, actor(c), p.scope, p.key), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/ext/files',
      tags,
      summary: 'Extension token: upload a file (≤ 4 MB, raw body) — then attach it to a file cell',
      description: '`?name=` and `?mime=`; the body is the file. Needs `items:write`.',
      middleware: scoped,
      request: {
        headers: accountHeader,
        query: z.object({ name: z.string().min(1).max(255), mime: z.string().max(127).optional() }),
      },
      responses: {
        200: json(z.object({ id: z.string(), name: z.string(), size: z.number(), mime: z.string() }), 'File'),
        ...errors(400, 401, 403, 413, 429),
      },
    }),
    async (c) => {
      const q = c.req.valid('query');
      const body = await c.req.arrayBuffer();
      return c.json(
        await store.uploadExtFile(deps, actor(c), {
          name: q.name,
          mime: q.mime ?? c.req.header('content-type') ?? 'application/octet-stream',
          body,
        }),
        200,
      );
    },
  );

  // an extension's server asks who is on one of its pages — the page sends its token to its server
  // the server asks here. Only the installation's own server, only tokens of that installation.
  r.openapi(
    createRoute({
      method: 'post',
      path: '/ext/introspect',
      tags,
      summary: "Extension server: who a token of this extension's pages belongs to",
      description:
        'Server token (`bos_xat_`) only. Body `{token}` — a page token (`bos_ext_`) the page handed to its server. ' +
        '`active: false` when it is not well signed, expired, or of another installation.',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(extIntrospectSchema) },
      responses: { 200: json(extIntrospectionSchema, 'The token'), ...errors(400, 401, 403) },
    }),
    async (c) => c.json(await introspectExtToken(deps, c.get('token'), c.req.valid('json').token), 200),
  );

  // the count beside one of its sidebar pages (`app_page`) — its server or its page.
  r.openapi(
    createRoute({
      method: 'put',
      path: '/ext/app-pages/{key}/badge',
      tags,
      summary: 'Extension token: the count beside one of its sidebar pages',
      description:
        "Body `{count, user_id?}`; `count: null` removes it. Its server (`bos_xat_`) sets the account's count, or one " +
        "member's with `user_id` (wins over the account's for them). Its page (`bos_ext_`) sets only its own user's. " +
        'Only `app_page` keys of its own manifest (else 404). Open apps hear it at once.',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: z.object({
          key: z
            .string()
            .max(40)
            .openapi({ param: { name: 'key', in: 'path' } }),
        }),
        ...jsonBody(setAppPageBadgeSchema),
      },
      responses: { 200: json(appPageBadgeSchema, 'The count'), ...errors(400, 401, 403, 404, 429) },
    }),
    async (c) => c.json(await setBadgeAsExtension(deps, actor(c), c.req.valid('param').key, c.req.valid('json')), 200),
  );

  // which automations use one of its own triggers — its page, read only.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/ext/automations',
      tags,
      summary: 'Extension page token: the automations that use one of its own triggers',
      description:
        'Query `trigger` = one of its own `automation_trigger` keys (else 404). Only automations on the boards its ' +
        'token reads that this member reads: `{id, board_id, name, active, trigger}`. Read only; a page token only.',
      middleware: scoped,
      request: { headers: accountHeader, query: extAutomationsQuerySchema },
      responses: { 200: json(extAutomationListSchema, 'Automations'), ...errors(400, 401, 403, 404) },
    }),
    async (c) => c.json(await listExtAutomations(deps.db, actor(c), c.req.valid('query').trigger), 200),
  );

  // An extension's trigger (ת4): no session, no token — the installation id plus a signature with its secret.
  r.openapi(
    createRoute({
      method: 'post',
      path: '/automations/triggers/{block}/fire',
      tags: ['automations'],
      summary: "An extension's server fires its trigger (signed with the installation's secret)",
      description:
        'Headers: `X-Bines-Installation`, `X-Bines-Timestamp` (ms), `X-Bines-Signature: sha256=HMAC(secret, ' +
        '"<timestamp>.<body>")`. Body: `{board_id?, item_id?, payload}`. A stale timestamp or a replayed ' +
        'signature is refused.',
      request: {
        params: z.object({
          block: z
            .string()
            .max(90)
            .openapi({ param: { name: 'block', in: 'path' } }),
        }),
      },
      responses: {
        202: json(
          z.object({
            block: z.string(),
            events: z.array(z.object({ board_id: z.string(), event_id: z.string(), item_id: z.string().nullable() })),
          }),
          'Accepted',
        ),
        ...errors(400, 401, 404, 413, 429),
      },
    }),
    async (c) => {
      const raw = await c.req.text();
      if (raw.length > MAX_FIRE_BYTES) throw new AppError('payload_too_large', 'Payload too large');
      return c.json(
        await fireExtensionTrigger(deps, {
          block: c.req.valid('param').block,
          installationId: c.req.header('x-bines-installation'),
          timestamp: c.req.header('x-bines-timestamp'),
          signature: c.req.header('x-bines-signature'),
          rawBody: raw,
          clientIp: c.get('clientIp'),
        }),
        202,
      );
    },
  );
  return r;
};
