// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  approveUpdateSchema,
  EXTENSION_DOC_PAGES,
  extensionDocPageSchema,
  exportPackSchema,
  extensionManifestSchema,
  extensionBlocksSchema,
  appPageBadgeSchema,
  extensionAppPageSchema,
  setAppPageBadgeSchema,
  extensionBoardViewSchema,
  extensionFrameFeatureSchema,
  extensionInstallationSchema,
  extensionSecretSchema,
  extensionPreviewSchema,
  extensionsListSchema,
  extensionTokenSchema,
  installExtensionSchema,
  killExtensionSchema,
  mintExtensionTokenSchema,
  platformExtensionSchema,
  previewExtensionSchema,
  starterKitOptionSchema,
  updateCheckResultSchema,
  updateInstallationSchema,
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
import { listAppPages, setBadgeFromPage } from './app-pages';
import { getExtensionDoc } from './dev-docs';
import * as svc from './extensions.service';
import { exportPack } from './pack-export';
import { killExtension, listPlatformExtensions, starterKitOptions, unkillExtension } from './platform-extensions';

const tags = ['extensions'];
const common = errors(400, 401, 403, 404, 409, 422);

/**
 * Extensions — "תוספות" (D27, the planning notes "MARKETPLACE" ת0–ת2). Session only (lib/scopes): no API token and no
 * extension token can manage extensions or mint tokens. The owner console's kill switch and starter kits are under
 * /platform (404 to anyone else).
 */
export const extensionRoutes = (deps: AppDeps) => {
  const scoped = [requireAccount(deps)];
  const owner = [requireUser(), requirePlatformOwner()];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/extensions',
      tags,
      summary: 'Admins: installed extensions and the platform catalog',
      description:
        "The account's installed extensions (enabled or not, version, granted scopes, boards, a waiting update) and the platform catalog it can install from. Account admins only; session only.",
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(extensionsListSchema, 'Extensions'), ...common },
    }),
    async (c) => c.json(await svc.listExtensions(deps, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/extensions/preview',
      tags,
      summary: 'Admins: validate a manifest (URL, pasted JSON or catalog key) — the consent screen',
      description:
        'Fetches and validates an extension manifest — from a URL, pasted JSON or a catalog key — and answers what the consent screen shows: what it adds and the permissions it asks for, in plain words. Installs nothing.',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(previewExtensionSchema) },
      responses: { 200: json(extensionPreviewSchema, 'Preview'), ...errors(400, 401, 403, 404, 413, 422) },
    }),
    async (c) => c.json(await svc.previewExtension(deps, actorOf(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/extensions/install',
      tags,
      summary: 'Admins: install with consent (scopes ≤ requested, boards, guests); a pack loads its data',
      description:
        "Installs an extension with the admin's consent: the granted scopes (at most what it asks for), the boards it may use and whether guests see it. A data pack's templates and data load in the same transaction; reinstalling reuses the earlier row, so nothing is created twice.",
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(installExtensionSchema) },
      responses: { 201: json(extensionInstallationSchema, 'Installed'), ...errors(400, 401, 403, 404, 409, 413, 422) },
    }),
    async (c) => c.json(await svc.installExtension(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 201),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/extensions/installations/{id}',
      tags,
      summary: 'Admins: enable / disable, scopes, boards, guests',
      description:
        'Enables or disables an installation, narrows or widens its scopes (never beyond what it asked for), and changes its boards and guest visibility.',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(updateInstallationSchema) },
      responses: { 200: json(extensionInstallationSchema, 'Updated'), ...common },
    }),
    async (c) =>
      c.json(
        await svc.updateInstallation(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json'), requestMeta(c)),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/extensions/installations/{id}',
      tags,
      summary: 'Admins: uninstall (its views and tokens stop at once)',
      description:
        "Uninstalls an extension: its views stop loading and its tokens stop working at once; a pack's templates leave the picker. Boards, automations and agents it created stay — they belong to the account.",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Uninstalled'), ...common },
    }),
    async (c) => c.json(await svc.uninstallExtension(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/extensions/installations/{id}/check-update',
      tags,
      summary: 'Admins: fetch the manifest again — updates now, or waits for consent if it asks for more',
      description:
        "Checks the extension's manifest now, like the daily job: nothing new to consent to → updated at once; a new scope, origin or feature (or automatic updates off) → the version waits for an admin's approval; a locked installation only reports it.",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: {
        200: json(z.object({ status: updateCheckResultSchema, installation: extensionInstallationSchema }), 'Checked'),
        ...common,
      },
    }),
    async (c) => c.json(await svc.checkForUpdate(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/extensions/installations/{id}/approve-update',
      tags,
      summary: 'Admins: consent to the waiting version (new scopes / origins / features)',
      description:
        'Approves the version waiting for consent (new scopes, origins or features): the installation moves to it.',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(approveUpdateSchema) },
      responses: { 200: json(extensionInstallationSchema, 'Approved'), ...common },
    }),
    async (c) =>
      c.json(
        await svc.approveUpdate(
          deps,
          actorOf(c),
          c.req.valid('param').id,
          c.req.valid('json').consent,
          requestMeta(c),
          c.req.valid('json').version,
        ),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/extensions/board-views',
      tags,
      summary: 'Board views of enabled extensions this member may open (optionally on one board)',
      middleware: scoped,
      request: { headers: accountHeader, query: z.object({ board_id: z.string().max(26).optional() }) },
      responses: { 200: json(z.object({ data: z.array(extensionBoardViewSchema) }), 'Board views'), ...common },
    }),
    async (c) => c.json(await svc.listBoardViews(deps, actorOf(c), c.req.valid('query').board_id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/extensions/features',
      tags,
      summary: 'Framed features of enabled extensions this member may open (item tabs, menu actions, widgets, …)',
      middleware: scoped,
      request: {
        headers: accountHeader,
        query: z.object({
          board_id: z.string().max(26).optional(),
          workspace_id: z.string().max(26).optional(),
          type: extensionFrameFeatureSchema.shape.type.optional(),
        }),
      },
      responses: { 200: json(z.object({ data: z.array(extensionFrameFeatureSchema) }), 'Features'), ...common },
    }),
    async (c) => c.json(await svc.listFrameFeatures(deps, actorOf(c), c.req.valid('query')), 200),
  );

  // the extensions' pages in the sidebar, with their counts.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/extensions/app-pages',
      tags,
      summary: "Extensions' pages in the sidebar this member may open, each with its count",
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(z.object({ data: z.array(extensionAppPageSchema) }), 'Pages'), ...common },
    }),
    async (c) => c.json(await listAppPages(deps, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'put',
      path: '/extensions/installations/{id}/app-pages/{key}/badge',
      tags,
      summary: "`setBadge` from an extension's page: my own count beside one of its sidebar pages",
      description:
        "The app calls it when a page of the extension asks (`setBadge`). Only the signed-in member's own count; " +
        "`count: null` removes it (the account's count shows again).",
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: idParam.extend({
          key: z
            .string()
            .max(40)
            .openapi({ param: { name: 'key', in: 'path' } }),
        }),
        ...jsonBody(setAppPageBadgeSchema),
      },
      responses: { 200: json(appPageBadgeSchema, 'The count'), ...errors(400, 401, 403, 404, 429) },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await setBadgeFromPage(deps, actorOf(c), p.id, p.key, c.req.valid('json')), 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/extensions/automation-blocks',
      tags,
      summary: 'Automation actions and triggers of enabled extensions (optionally on one board) — the builder',
      middleware: scoped,
      request: { headers: accountHeader, query: z.object({ board_id: z.string().max(26).optional() }) },
      responses: { 200: json(extensionBlocksSchema, 'Blocks'), ...common },
    }),
    async (c) => c.json(await svc.listAutomationBlocks(deps, actorOf(c), c.req.valid('query').board_id), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/extensions/installations/{id}/secret',
      tags,
      summary: "Admins: the installation's signing secret (its server checks our calls and signs its triggers)",
      description:
        "Reveals the installation's signing secret: the extension's server verifies our signed calls with it and signs the triggers it sends. Audited.",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(extensionSecretSchema, 'Secret'), ...common },
    }),
    async (c) => c.json(await svc.revealSecret(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/extensions/installations/{id}/secret/rotate',
      tags,
      summary: 'Admins: a new signing secret (the old one stops at once)',
      description:
        "Issues a new signing secret for the installation; the old one stops working at once (update the extension's server).",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(extensionSecretSchema, 'Secret'), ...common },
    }),
    async (c) => c.json(await svc.rotateSecret(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/extensions/installations/{id}/token',
      tags,
      summary:
        'A short-lived token for one framed feature where it is shown — a board, a dashboard widget or the ' +
        'settings page (handed to its iframe by postMessage)',
      description:
        "Mints a short-lived extension token (minutes) for one framed feature where it is shown, limited to the granted scopes: on a board (the board must be allowed for the installation and readable by this person), for one dashboard widget (only the widget's boards this viewer reads), or for the settings page (admins, no board content). The web app hands it to the iframe by postMessage.",
      middleware: scoped,
      request: { headers: accountHeader, params: idParam, ...jsonBody(mintExtensionTokenSchema) },
      responses: { 200: json(extensionTokenSchema, 'Token'), ...errors(400, 401, 403, 404, 429) },
    }),
    async (c) => c.json(await svc.mintToken(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/extensions/packs/export',
      tags,
      summary: 'Admins: "save as pack" — these boards as templates + a starter kit (+ their automations), a manifest',
      description:
        'Exports the chosen boards as a data-pack manifest: their structure as templates, a starter kit and (optionally) their automations — to publish in the catalog or install in another account.',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(exportPackSchema) },
      responses: { 200: json(extensionManifestSchema, 'Manifest'), ...common },
    }),
    async (c) => c.json(await exportPack(deps.db, actorOf(c), c.req.valid('json')), 200),
  );

  // ---- owner console ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/extensions',
      tags: ['platform'],
      summary: 'Platform owner: the catalog and every extension installed anywhere, with kill state',
      description:
        'Every extension key known to the platform — catalog entries and keys installed in any account — with whether the kill switch is on.',
      middleware: owner,
      responses: { 200: json(z.object({ data: z.array(platformExtensionSchema) }), 'Extensions'), ...errors(401, 404) },
    }),
    async (c) => c.json(await listPlatformExtensions(deps.db), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/extensions/kill',
      tags: ['platform'],
      summary: 'Platform owner: emergency kill switch — the extension stops in every account at once',
      description:
        'Switches an extension key off in every account, effective on the next request: its tokens are refused, its frames stop loading and its origins leave CORS. Needs a reason; audited. Installations are kept, so switching it back on restores them.',
      middleware: owner,
      request: jsonBody(killExtensionSchema),
      responses: { 200: json(okSchema, 'Killed'), ...errors(400, 401, 404) },
    }),
    async (c) => c.json(await killExtension(deps, currentUser(c), c.req.valid('json'), requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/platform/extensions/kill/{key}',
      tags: ['platform'],
      summary: 'Platform owner: switch a killed extension back on',
      description:
        'Lifts the kill switch of an extension key: its installations in every account work again as they were. Audited.',
      middleware: owner,
      request: {
        params: z.object({
          key: z
            .string()
            .max(48)
            .openapi({ param: { name: 'key', in: 'path' } }),
        }),
      },
      responses: { 200: json(okSchema, 'Restored'), ...errors(401, 404) },
    }),
    async (c) => c.json(await unkillExtension(deps, currentUser(c), c.req.valid('param').key, requestMeta(c)), 200),
  );

  // s37market: the developer guide and quickstart inside the app (the public pages stay at /api/docs/extensions).
  r.openapi(
    createRoute({
      method: 'get',
      path: '/extensions/docs/{page}',
      tags,
      summary: 'Admins: the extension developer guide or quickstart, rendered for the in-app developer area',
      middleware: scoped,
      request: {
        headers: accountHeader,
        params: z.object({
          page: z.enum(EXTENSION_DOC_PAGES).openapi({ param: { name: 'page', in: 'path' } }),
        }),
      },
      responses: { 200: json(extensionDocPageSchema, 'The page'), ...errors(400, 401, 403) },
    }),
    async (c) => c.json(await getExtensionDoc(deps, c.get('account'), c.req.valid('param').page), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/starter-kits',
      tags: ['platform'],
      summary: 'Platform owner: starter kits a new account can open with (catalog data packs)',
      middleware: owner,
      responses: {
        200: json(z.object({ data: z.array(starterKitOptionSchema) }), 'Starter kits'),
        ...errors(401, 404),
      },
    }),
    async (c) => c.json(await starterKitOptions(deps.db), 200),
  );

  return r;
};
