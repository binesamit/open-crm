// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  createRecoveryRequestSchema,
  createSupportGrantSchema,
  recoveryLinkSchema,
  supportAccessResponseSchema,
  supportGrantSchema,
  supportRecoveryRequestSchema,
} from '@bines/shared';
import {
  currentUser,
  requestMeta,
  requireAccount,
  requirePlatformOwner,
  requireUser,
  actorOf,
} from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  cancelRecoveryRequest,
  createSupportGrant,
  emergencyRecoveryLink,
  getSupportAccess,
  listEmergencyRecovery,
  requestEmergencyRecovery,
  revokeSupportGrant,
} from './support.service';

/**
 * Remote support access: Administration → Security → Support access (admins; a session only — never
 * a token), and the owner console's emergency recovery path (platform owners; 404 to everyone else).
 */
export const supportRoutes = (deps: AppDeps) => {
  const middleware = [requireAccount(deps)];
  const owner = [requireUser(), requirePlatformOwner()];
  const tags = ['support'];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/support-access',
      tags,
      summary: 'Support access grants (active and past), emergency recovery requests and the grant options (admin)',
      description:
        "The account's support access grants (active and past), the platform owner's emergency recovery requests and the options of the grant form. Account admins only.",
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(supportAccessResponseSchema, 'Support access'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getSupportAccess(deps, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/support-access',
      tags,
      summary: 'Let support into the account for a while (view by default) — audited, the admins are emailed on entry',
      description:
        "Lets support into the account for `duration_hours`: the platform's support (`grantee: platform`) or one person by email, in `view` mode (reads only — changes answer 405 `support_read_only`) or `edit`. Even `edit` never manages people, tokens, security or support access. Every request under a grant is audited; the admins are emailed when a support session starts.",
      middleware,
      request: { headers: accountHeader, ...jsonBody(createSupportGrantSchema) },
      responses: { 201: json(supportGrantSchema, 'Granted'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await createSupportGrant(deps, actorOf(c), c.req.valid('json'), requestMeta(c)), 201),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/support-access/{id}',
      tags,
      summary: 'Revoke a support grant now',
      description: 'Ends a support grant at once: the next request under it is refused.',
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Revoked'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await revokeSupportGrant(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/support-access/recovery-requests/{id}/cancel',
      tags,
      summary: "Cancel the platform owner's emergency recovery link before it opens (any admin)",
      middleware,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Cancelled'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await cancelRecoveryRequest(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  // ---- owner console: the emergency path of the recovery link ----
  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/emergency-recovery',
      tags: ['platform'],
      summary: 'Emergency recovery requests of every account, newest first',
      middleware: owner,
      responses: {
        200: json(z.object({ data: z.array(supportRecoveryRequestSchema) }), 'Requests'),
        ...errors(401, 404),
      },
    }),
    async (c) => c.json({ data: await listEmergencyRecovery(deps, null) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/platform/accounts/{id}/emergency-recovery',
      tags: ['platform'],
      summary: "An account's emergency recovery requests",
      middleware: owner,
      request: { params: idParam },
      responses: {
        200: json(z.object({ data: z.array(supportRecoveryRequestSchema) }), 'Requests'),
        ...errors(401, 404),
      },
    }),
    async (c) => c.json({ data: await listEmergencyRecovery(deps, c.req.valid('param').id) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/accounts/{id}/emergency-recovery',
      tags: ['platform'],
      summary: 'Ask for a recovery link without a support grant: the admins are told; it opens after the wait',
      description:
        "The emergency path when no grant is possible (for example the only admin is locked out): the request is announced to every admin of the account at once, and the recovery link can be made only after the platform's wait (owner console, default 24 h). Any admin may cancel it until then.",
      middleware: owner,
      request: { params: idParam, ...jsonBody(createRecoveryRequestSchema) },
      responses: { 201: json(supportRecoveryRequestSchema, 'Requested'), ...errors(400, 401, 403, 404) },
    }),
    async (c) =>
      c.json(
        await requestEmergencyRecovery(
          deps,
          currentUser(c),
          c.req.valid('param').id,
          c.req.valid('json'),
          requestMeta(c),
        ),
        201,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/platform/emergency-recovery/{id}/link',
      tags: ['platform'],
      summary: 'The one-time link of an emergency request — after the wait, unless an admin cancelled it',
      description:
        'Makes the single-use recovery link of an emergency request once its wait has passed and no admin cancelled it. Refused before the wait ends or after a cancellation.',
      middleware: owner,
      request: { params: idParam },
      responses: { 200: json(recoveryLinkSchema, 'Link'), ...errors(401, 403, 404, 409, 429) },
    }),
    async (c) =>
      c.json(await emergencyRecoveryLink(deps, currentUser(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  return r;
};
