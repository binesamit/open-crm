// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  createOwnerGuideSchema,
  installGuideQuerySchema,
  installGuideSchema,
  isLocale,
  ownerGuideSchema,
  reorderOwnerGuidesSchema,
  updateOwnerGuideSchema,
} from '@bines/shared';
import { errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import { currentUser, requirePlatformOwner, requireUser } from '../../middleware/auth';
import type { AppDeps, AppEnv } from '../../types';
import {
  createOwnerGuide,
  deleteOwnerGuide,
  getInstallGuide,
  getOwnerGuide,
  listOwnerGuides,
  reorderOwnerGuides,
  updateOwnerGuide,
} from './guides.service';

/**
 * Guides: the installation and licensing guide inside the app (anyone signed in — the same text is
 * public at /api/docs/guide), and the platform owner's private guides (owner console → Guides; owner only).
 */
export const guidesRoutes = (deps: AppDeps) => {
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/guides/install',
      tags: ['guides'],
      summary: 'The installation and licensing guide, rendered (in the app)',
      middleware: [requireUser()],
      request: { query: installGuideQuerySchema },
      responses: { 200: json(installGuideSchema, 'Guide'), ...errors(401) },
    }),
    async (c) => {
      const user = currentUser(c);
      // The person's interface language unless the page asks for the other one.
      const locale = c.req.valid('query').locale ?? (user.locale && isLocale(user.locale) ? user.locale : 'he');
      return c.json(await getInstallGuide(deps, locale), 200);
    },
  );

  // ------------------------------------------------------------------------------------------ owner console
  // Tokens are refused on /platform/* (lib/scopes.ts): the owner reads and writes these in person.
  const guard = [requireUser(), requirePlatformOwner()];
  const tags = ['platform'];
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/guides',
      tags,
      summary: "The platform owner's guides (owner console)",
      middleware: guard,
      responses: { 200: json(z.object({ data: z.array(ownerGuideSchema) }), 'Guides'), ...errors(401, 404) },
    }),
    async (c) => c.json({ data: await listOwnerGuides(deps) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/guides',
      tags,
      summary: 'Add an owner guide (title and Markdown body per language)',
      middleware: guard,
      request: jsonBody(createOwnerGuideSchema),
      responses: { 200: json(ownerGuideSchema, 'Guide'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await createOwnerGuide(deps, currentUser(c), c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/platform/guides/order',
      tags,
      summary: 'Reorder the owner guides',
      middleware: guard,
      request: jsonBody(reorderOwnerGuidesSchema),
      responses: { 200: json(z.object({ data: z.array(ownerGuideSchema) }), 'Guides'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json({ data: await reorderOwnerGuides(deps, c.req.valid('json').ids) }, 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/guides/{id}',
      tags,
      summary: 'One owner guide',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(ownerGuideSchema, 'Guide'), ...errors(401, 404) },
    }),
    async (c) => c.json(await getOwnerGuide(deps, c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'patch',
      path: '/platform/guides/{id}',
      tags,
      summary: "Edit an owner guide's title or Markdown body",
      middleware: guard,
      request: { params: idParam, ...jsonBody(updateOwnerGuideSchema) },
      responses: { 200: json(ownerGuideSchema, 'Guide'), ...errors(400, 401, 404) },
    }),
    async (c) =>
      c.json(await updateOwnerGuide(deps, currentUser(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/guides/{id}',
      tags,
      summary: 'Delete an owner guide',
      middleware: guard,
      request: { params: idParam },
      responses: { 200: json(okSchema, 'Deleted'), ...errors(401, 404) },
    }),
    async (c) => {
      await deleteOwnerGuide(deps, currentUser(c), c.req.valid('param').id);
      return c.json({ ok: true as const }, 200);
    },
  );

  return r;
};
