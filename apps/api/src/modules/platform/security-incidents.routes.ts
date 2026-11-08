// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono } from '@hono/zod-openapi';
import {
  securityIncidentInputSchema,
  securityIncidentListSchema,
  securityIncidentPatchSchema,
  securityIncidentSchema,
} from '@bines/shared';
import { currentUser, requirePlatformOwner, requireUser } from '../../middleware/auth';
import { errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { createIncident, deleteIncident, listIncidents, updateIncident } from './security-incidents';

/** Owner console → Security incidents (privacy): the register, platform owner only. */
export const securityIncidentRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const r = new OpenAPIHono<AppEnv>();
  const guard = [requireUser(), requirePlatformOwner()];
  const tags = ['platform'];

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/security-incidents',
      tags,
      summary: 'The security incident register, newest first (platform owner)',
      middleware: guard,
      responses: { 200: json(securityIncidentListSchema, 'Incidents'), ...errors(401, 404) },
    }),
    async (c) => c.json(await listIncidents(db), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/security-incidents',
      tags,
      summary: 'Record a security incident (platform owner)',
      middleware: guard,
      request: jsonBody(securityIncidentInputSchema),
      responses: { 201: json(securityIncidentSchema, 'Incident'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await createIncident(db, currentUser(c), c.req.valid('json')), 201),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/security-incidents/{id}',
      tags,
      summary: 'Update a security incident — status, notices, measures (platform owner)',
      middleware: guard,
      request: { params: idParam, ...jsonBody(securityIncidentPatchSchema) },
      responses: { 200: json(securityIncidentSchema, 'Incident'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await updateIncident(db, c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/security-incidents/{id}',
      tags,
      summary: 'Delete a security incident recorded by mistake (platform owner)',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...errors(401, 404) },
    }),
    async (c) => c.json(await deleteIncident(db, c.req.valid('param').id), 200),
  );
  return r;
};
