// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  automationSavedSchema,
  automationTemplateListSchema,
  automationTemplateSchema,
  installAutomationTemplateSchema,
  saveAutomationTemplateSchema,
  templateProposalQuerySchema,
  templateProposalSchema,
  updateAutomationTemplateSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './templates.service';

const common = errors(400, 401, 403, 404, 409, 422);

/** Account automation templates: save any automation as one, list, edit, delete, install on a board. */
export const automationTemplateRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/automation-templates',
      tags: ['automations'],
      summary: "The account's automation templates",
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(automationTemplateListSchema, 'Templates'), ...common },
    }),
    async (c) => c.json(await svc.listAutomationTemplates(db, actorOf(c)), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/automations/{id}/save-as-template',
      tags: ['automations'],
      summary: 'Save an automation as an account template (board references become slots)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(saveAutomationTemplateSchema) },
      responses: { 201: json(automationTemplateSchema, 'Saved'), ...common },
    }),
    async (c) => c.json(await svc.saveAsTemplate(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/automation-templates/{id}',
      tags: ['automations'],
      summary: 'One automation template',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(automationTemplateSchema, 'Template'), ...common },
    }),
    async (c) => c.json(await svc.getAutomationTemplate(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/automation-templates/{id}',
      tags: ['automations'],
      summary: 'Rename / describe an automation template',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateAutomationTemplateSchema) },
      responses: { 200: json(automationTemplateSchema, 'Updated'), ...common },
    }),
    async (c) =>
      c.json(await svc.updateAutomationTemplate(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/automation-templates/{id}',
      tags: ['automations'],
      summary: 'Delete an automation template',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...common },
    }),
    async (c) => c.json(await svc.deleteAutomationTemplate(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/automation-templates/{id}/proposal',
      tags: ['automations'],
      summary: "The install form for a board: each slot's choices and proposed pick",
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam,
        ...jsonBody(templateProposalQuerySchema.extend({ mapping: z.record(z.string(), z.string()).default({}) })),
      },
      responses: { 200: json(templateProposalSchema, 'Proposal'), ...common },
    }),
    async (c) => {
      const body = c.req.valid('json');
      return c.json(
        await svc.templateProposal(db, actorOf(c), c.req.valid('param').id, body.board_id, body.mapping),
        200,
      );
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/automation-templates/{id}/install',
      tags: ['automations'],
      summary: 'Install an automation template on a board (slots picked; validated like any automation)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(installAutomationTemplateSchema) },
      responses: { 201: json(automationSavedSchema, 'Installed'), ...common },
    }),
    async (c) =>
      c.json(await svc.installAutomationTemplate(db, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 201),
  );
  return r;
};
