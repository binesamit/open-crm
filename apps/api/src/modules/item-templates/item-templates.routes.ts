// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  applyItemTemplateResultSchema,
  applyItemTemplateSchema,
  createItemTemplateSchema,
  itemTemplateDtoSchema,
  itemTemplateListSchema,
  saveItemAsTemplateSchema,
  updateItemTemplateSchema,
} from '@bines/shared';
import { actorOf, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './item-templates.service';

const common = errors(400, 401, 403, 404, 409, 422);
const deleted = z.object({ ok: z.literal(true), id: z.string() });

/** Item templates: a board's templates, saving an item as one, editing, applying. */
export const itemTemplateRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();
  const tags = ['item-templates'];

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{id}/item-templates',
      tags,
      summary: "A board's item templates (without their trees)",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(itemTemplateListSchema, 'Templates'), ...common },
    }),
    async (c) => c.json(await svc.listItemTemplates(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{id}/item-templates',
      tags,
      summary: 'Create an item template from a tree (who may change the board structure)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(createItemTemplateSchema) },
      responses: { 201: json(itemTemplateDtoSchema, 'Created'), ...common },
    }),
    async (c) =>
      c.json(await svc.createItemTemplate(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/items/{id}/save-as-template',
      tags,
      summary: 'Save an item and its subitems as an item template',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(saveItemAsTemplateSchema) },
      responses: { 201: json(itemTemplateDtoSchema, 'Created'), ...common },
    }),
    async (c) =>
      c.json(await svc.saveItemAsTemplate(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/item-templates/{id}',
      tags,
      summary: 'An item template with its tree',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(itemTemplateDtoSchema, 'Template'), ...common },
    }),
    async (c) => c.json(await svc.getItemTemplate(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/item-templates/{id}',
      tags,
      summary: 'Change an item template (a new tree or variables is a new version)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateItemTemplateSchema) },
      responses: { 200: json(itemTemplateDtoSchema, 'Template'), ...common },
    }),
    async (c) =>
      c.json(await svc.updateItemTemplate(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/item-templates/{id}',
      tags,
      summary: 'Delete an item template (restore brings it back)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(deleted, 'Deleted'), ...common },
    }),
    async (c) => c.json(await svc.deleteItemTemplate(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/item-templates/{id}/restore',
      tags,
      summary: 'Bring a deleted item template back',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(itemTemplateDtoSchema, 'Template'), ...common },
    }),
    async (c) => c.json(await svc.restoreItemTemplate(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/item-templates/{id}/apply',
      tags,
      summary: 'Apply an item template: a new item, or its subitems under an item (one undo)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(applyItemTemplateSchema) },
      responses: { 201: json(applyItemTemplateResultSchema, 'Applied'), ...common },
    }),
    async (c) =>
      c.json(await svc.applyItemTemplate(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  return r;
};
