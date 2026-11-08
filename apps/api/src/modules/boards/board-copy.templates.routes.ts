// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  duplicateTemplateSchema,
  hiddenTemplateSchema,
  saveTemplateDraftSchema,
  startTemplateDraftSchema,
  templateDraftSchema,
  templateSummarySchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  discardTemplateDraft,
  duplicateTemplate,
  hiddenBuiltinTemplates,
  restoreBuiltinTemplate,
  saveTemplateDraft,
  startTemplateDraft,
} from './board-copy.templates';

const common = errors(400, 401, 403, 404, 422, 423);
const keyParam = z.object({ key: z.string().openapi({ param: { name: 'key', in: 'path' } }) });
const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });

/** Template management beyond rename / delete (fix2): duplicate, and the built-ins an admin removed. */
export const templateRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'post',
      path: '/templates/{key}/duplicate',
      tags: ['boards'],
      summary: 'Copy a template (built-in or the account’s) as a new template of this account (admins, members)',
      middleware: scoped,
      request: { headers: accountHeader, params: keyParam, ...jsonBody(duplicateTemplateSchema) },
      responses: { 201: json(templateSummarySchema, 'The copy'), ...common },
    }),
    async (c) => c.json(await duplicateTemplate(db, actorOf(c), c.req.valid('param').key, c.req.valid('json')), 201),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/templates/hidden',
      tags: ['boards'],
      summary: 'Built-in templates removed from this account (admins)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(hiddenTemplateSchema) }), 'Removed templates'), ...common },
    }),
    async (c) => c.json({ data: await hiddenBuiltinTemplates(db, actorOf(c)) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/templates/{key}/restore',
      tags: ['boards'],
      summary: 'Bring a removed built-in template back to this account (admins)',
      middleware: scoped,
      request: { headers: accountHeader, params: keyParam },
      responses: { 200: json(templateSummarySchema, 'Template'), ...common },
    }),
    async (c) => c.json(await restoreBuiltinTemplate(db, actorOf(c), c.req.valid('param').key), 200),
  );

  // ---- a template's working board (fix3) ----
  r.openapi(
    createRoute({
      method: 'post',
      path: '/templates/{key}/draft',
      tags: ['boards'],
      summary: 'My working board of a template (the open one, else a new hidden one) — who may edit the template',
      middleware: scoped,
      request: { headers: accountHeader, params: keyParam, ...jsonBody(startTemplateDraftSchema) },
      responses: { 200: json(templateDraftSchema, 'The working board'), ...common },
    }),
    async (c) => c.json(await startTemplateDraft(db, actorOf(c), c.req.valid('param').key, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/template-draft/save',
      tags: ['boards'],
      summary: 'Save my template working board over its template; the working board is removed',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(saveTemplateDraftSchema) },
      responses: { 200: json(z.object({ key: z.string(), name: z.string() }), 'Template'), ...common },
    }),
    async (c) =>
      c.json(await saveTemplateDraft(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/boards/{boardId}/template-draft',
      tags: ['boards'],
      summary: 'Discard my template working board (the template stays as it was)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: { 200: json(z.object({ ok: z.literal(true) }), 'Discarded'), ...common },
    }),
    async (c) => {
      await discardTemplateDraft(db, actorOf(c), c.req.valid('param').boardId);
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
};
