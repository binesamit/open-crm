// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountSecretUpdatesSchema,
  boardSecretUpdatesSchema,
  editedItemSchema,
  putBoardSecretUpdatesSchema,
  secretLogPageSchema,
  secretLogQuerySchema,
  secretRevealSchema,
  secretStatusSchema,
  secretUpdateRevealSchema,
  secretVerifySchema,
  setSecretSchema,
} from '@bines/shared';
import type { Context } from 'hono';
import { currentUser, requestMeta, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './secrets.service';
import * as upd from './secret-updates.service';

const cellParams = idParam.extend({ columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }) });
const common = errors(400, 401, 403, 404, 409, 422, 423, 429);

/** What a request brings to write / change a secret update: the key env, its session or token. */
export const secretWriterOf = (deps: Pick<AppDeps, 'env'>, c: Context<AppEnv>): upd.SecretWriter => ({
  env: deps.env,
  meta: requestMeta(c),
  sessionId: c.get('sessionId') ?? null,
  token: c.get('token') ?? null,
});

/** The value is said once: never kept by a browser or a proxy. */
const noStore = (c: Context<AppEnv>) => {
  c.header('Cache-Control', 'no-store, max-age=0');
  c.header('Pragma', 'no-cache');
};

/**
 * Secret columns: set / clear, the two-factor step-up, reveal, the copy event, the admins' log
 * and secret updates: reveal, copy, and their settings (the account's default, a board's override).
 */
export const secretRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const actor = (c: Context<AppEnv>): svc.SecretActor => ({
    ctx: c.get('account'),
    user: currentUser(c),
    requestId: c.get('requestId'),
    sessionId: c.get('sessionId') ?? null,
    token: c.get('token') ?? null,
    meta: requestMeta(c),
  });
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/updates/{id}/reveal',
      tags: ['updates'],
      summary:
        'Reveal the text of a secret update once (2FA and a fresh code; a token needs the secrets:read scope); audited',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(secretUpdateRevealSchema, 'The text'), ...common },
    }),
    async (c) => {
      const out = await upd.revealSecretUpdate(deps, actor(c), c.req.valid('param').id);
      noStore(c);
      return c.json(out, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/updates/{id}/secret-copy',
      tags: ['updates'],
      summary: 'Record that a revealed secret update was copied (audited; refused when copying is off)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Recorded'), ...common },
    }),
    async (c) => c.json(await upd.recordSecretUpdateCopy(db, actor(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{id}/secret-updates',
      tags: ['boards'],
      summary: "Secret updates on a board: what applies, the account's default and the board's own override",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(boardSecretUpdatesSchema, 'Settings'), ...common },
    }),
    async (c) => c.json(await upd.getBoardSecretUpdates(db, actor(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{id}/secret-updates',
      tags: ['boards'],
      summary:
        "Set a board's own secret-update settings (null = the account's); board owners and admins, with a fresh 2FA code",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(putBoardSecretUpdatesSchema) },
      responses: { 200: json(boardSecretUpdatesSchema, 'Settings'), ...common },
    }),
    async (c) =>
      c.json(await upd.putBoardSecretUpdates(db, actor(c), c.req.valid('param').id, c.req.valid('json').settings), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/secrets/update-settings',
      tags: ['accounts'],
      summary: "The account's default settings of secret updates (admins)",
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(accountSecretUpdatesSchema, 'Settings'), ...common },
    }),
    async (c) => c.json(await upd.getAccountSecretUpdates(db, actor(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/secrets/update-settings',
      tags: ['accounts'],
      summary: "Change the account's default settings of secret updates (admins, with a fresh 2FA code)",
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(accountSecretUpdatesSchema) },
      responses: { 200: json(accountSecretUpdatesSchema, 'Settings'), ...common },
    }),
    async (c) => c.json(await upd.putAccountSecretUpdates(db, actor(c), c.req.valid('json').settings), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/items/{id}/cells/{columnId}/secret',
      tags: ['items'],
      summary:
        'Set or clear the value of a secret column (encrypted; the cell shows only that a value exists). Replacing or clearing an existing value needs a fresh 2FA code when the column asks for it',
      middleware: scoped,
      request: { headers: accountHeader, params: cellParams, ...jsonBody(setSecretSchema) },
      responses: { 200: json(editedItemSchema, 'Item'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.setSecret(deps, actor(c), p.id, p.columnId, c.req.valid('json').value), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/cells/{columnId}/secret/reveal',
      tags: ['items'],
      summary: 'Reveal the value of a secret column once (2FA; a token needs the secrets:read scope); audited',
      middleware: scoped,
      request: { headers: accountHeader, params: cellParams },
      responses: { 200: json(secretRevealSchema, 'The value'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      const out = await svc.revealSecret(deps, actor(c), p.id, p.columnId);
      c.header('Cache-Control', 'no-store, max-age=0');
      c.header('Pragma', 'no-cache');
      return c.json(out, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/cells/{columnId}/secret/copy',
      tags: ['items'],
      summary: 'Record that a revealed secret was copied (audited; refused when the column does not allow copying)',
      middleware: scoped,
      request: { headers: accountHeader, params: cellParams },
      responses: { 200: json(okSchema, 'Recorded'), ...common },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.recordSecretCopy(db, actor(c), p.id, p.columnId), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/secrets/status',
      tags: ['items'],
      summary: 'My state for revealing secrets: 2FA on, and when I last entered a fresh code (session only)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(secretStatusSchema, 'Status'), ...common },
    }),
    async (c) => c.json(await svc.secretStatus(db, actor(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/secrets/verify',
      tags: ['items'],
      summary: 'Enter a fresh two-factor code to reveal secrets for a while (session only)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(secretVerifySchema) },
      responses: { 200: json(secretStatusSchema, 'Verified'), ...common },
    }),
    async (c) => c.json(await svc.verifyForSecrets(deps, actor(c), c.req.valid('json').code, c.req.raw.headers), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/secrets/log',
      tags: ['audit'],
      summary: 'Who revealed, copied or changed which secret and when (admins), with filters',
      middleware: scoped,
      request: { headers: accountHeader, query: secretLogQuerySchema },
      responses: { 200: json(secretLogPageSchema, 'Log'), ...common },
    }),
    async (c) => c.json(await svc.secretLog(db, actor(c), c.req.valid('query')), 200),
  );

  return r;
};
