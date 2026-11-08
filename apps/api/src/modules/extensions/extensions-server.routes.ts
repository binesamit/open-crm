// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  catalogPreviewSchema,
  catalogSourceSchema,
  extensionInstallationSchema,
  extensionVersioningSchema,
  extensionVersionSchema,
  publishCatalogSchema,
  rollbackExtensionSchema,
} from '@bines/shared';
import {
  currentUser,
  requestMeta,
  requireAccount,
  requirePlatformOwner,
  requireUser,
  actorOf,
} from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { previewCatalog, publishCatalog, unpublishCatalog } from './catalog';
import * as svc from './extensions.service';

const tags = ['extensions'];
const common = errors(400, 401, 403, 404, 409, 422);

/**
 * Extensions ת6–ת7 (D27): versions (lock, automatic updates, history, rollback), the extension's own server
 * (reconnect = new credentials in a fresh `installed` call) and the platform catalog (publish with the §8 review,
 * unpublish). Session only, like every /extensions route (lib/scopes); the catalog is the owner console's (404 to
 * anyone else). The server's OAuth token endpoint is /oauth/token (`grant_type=client_credentials`).
 */
export const extensionServerRoutes = (deps: AppDeps) => {
  const scoped = [requireAccount(deps)];
  const owner = [requireUser(), requirePlatformOwner()];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/extensions/installations/{id}/versioning',
      tags,
      summary: 'Admins: lock on this version / automatic updates on or off',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(extensionVersioningSchema) },
      responses: { 200: json(extensionInstallationSchema, 'Updated'), ...common },
    }),
    async (c) =>
      c.json(
        await svc.setVersioning(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/extensions/installations/{id}/versions',
      tags,
      summary: 'Admins: the versions this installation ran, newest first',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(z.object({ data: z.array(extensionVersionSchema) }), 'Versions'), ...common },
    }),
    async (c) => c.json(await svc.installationVersions(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/extensions/installations/{id}/rollback',
      tags,
      summary: 'Admins: back to an approved version (locks it); one that needs more waits for consent',
      description:
        'Rolls the installation back to a version it ran before and locks it there (otherwise the daily check would move it forward again). A version that would need more than is granted now waits for consent like an update.',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(rollbackExtensionSchema) },
      responses: {
        200: json(
          z.object({ status: z.enum(['updated', 'pending']), installation: extensionInstallationSchema }),
          'Rolled back',
        ),
        ...common,
      },
    }),
    async (c) =>
      c.json(
        await svc.rollbackInstallation(
          deps,
          actorOf(c),
          c.req.valid('param').id,
          c.req.valid('json').version_id,
          requestMeta(c),
        ),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/extensions/installations/{id}/server/reconnect',
      tags,
      summary: "Admins: new credentials for the extension's server, sent in a fresh signed `installed` call",
      description:
        "Issues new server credentials for the installation (the old ones and their tokens stop) and sends them in a fresh signed `installed` call to the extension's server — after its developer fixed the server, or when a secret may have leaked.",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(extensionInstallationSchema, 'Reconnected'), ...common },
    }),
    async (c) => c.json(await svc.reconnectServer(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  // ---- the platform catalog (owner console) ----
  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/extensions/catalog/preview',
      tags: ['platform'],
      summary: 'Platform owner: validate an extension for the catalog (URL or pasted manifest)',
      description:
        'Validates an extension for the platform catalog (a URL or a pasted manifest) and shows what would be published and which catalog entry it replaces. Publishes nothing.',
      middleware: owner,
      request: jsonBody(catalogSourceSchema),
      responses: { 200: json(catalogPreviewSchema, 'Preview'), ...errors(400, 401, 404, 413, 422) },
    }),
    async (c) => c.json(await previewCatalog(deps, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/extensions/catalog',
      tags: ['platform'],
      summary: 'Platform owner: publish for every account, with the §8 security review (code: every check)',
      description:
        "Publishes an extension in the catalog for every account — each account still installs it through the consent screen. A code extension needs every item of the security review ticked (kept with the entry); a data pack's review is optional. Republishing a key replaces the entry; installations pick it up through their update check.",
      middleware: owner,
      request: jsonBody(publishCatalogSchema),
      responses: { 200: json(okSchema, 'Published'), ...errors(400, 401, 403, 404, 413, 422) },
    }),
    async (c) => c.json(await publishCatalog(deps, currentUser(c), c.req.valid('json'), requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/extensions/catalog/{key}',
      tags: ['platform'],
      summary: 'Platform owner: take an extension out of the catalog (installed copies keep their version)',
      description:
        'Removes an extension from the catalog: no new installs. Existing installations keep the version they approved; use the kill switch to stop it everywhere.',
      middleware: owner,
      request: {
        params: z.object({
          key: z
            .string()
            .max(48)
            .openapi({ param: { name: 'key', in: 'path' } }),
        }),
      },
      responses: { 200: json(okSchema, 'Unpublished'), ...errors(401, 404) },
    }),
    async (c) => c.json(await unpublishCatalog(deps, currentUser(c), c.req.valid('param').key, requestMeta(c)), 200),
  );

  return r;
};
