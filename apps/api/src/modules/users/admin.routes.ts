// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  bulkUsersResultSchema,
  bulkUsersSchema,
  deactivateUserSchema,
  defaultTransferUserSchema,
  deleteUserDetailsSchema,
  invitationSchema,
  memberSchema,
  recoveryLinkSchema,
  resendInvitationQuerySchema,
  transferOwnershipSchema,
  transferResultSchema,
  updateUserSchema,
} from '@bines/shared';
import { requestMeta, requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import {
  activateUser,
  bulkUsers,
  deactivateUser,
  deleteUserDetails,
  getDefaultTransferUser,
  resendInvitation,
  setDefaultTransferUser,
  transferOwnership,
  updateUser,
  usersCsv,
} from './admin.service';
import { accountRecoveryLink } from './recovery.service';
import { exportMemberData } from './personal-export';
import { personalExportSchema } from './personal-export.schema';
import { resetMemberTwoFactor } from '../admin/two-factor.service';

/** Administration → users (08 §3.2–3.3, account admin A2). Admins only; another account's people are 404. */
export const userAdminRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const middleware = [requireAccount(deps)];
  const tags = ['users'];
  const params = { headers: accountHeader, params: idParam };
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/users/export.csv',
      tags,
      summary: 'The people of the account as CSV (admin)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: { description: 'CSV', content: { 'text/csv': { schema: z.string() } } }, ...COMMON_ERRORS },
    }),
    async (c) =>
      new Response(await usersCsv(deps, actorOf(c)), {
        status: 200,
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': 'attachment; filename="users.csv"',
        },
      }) as never,
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/users/bulk',
      tags,
      summary: 'One action on many people (≤200; not yourself): set_role | deactivate | activate | resend',
      middleware,
      request: { headers: accountHeader, ...jsonBody(bulkUsersSchema) },
      responses: { 200: json(bulkUsersResultSchema, 'Result'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await bulkUsers(deps, actorOf(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/users/invitations/{id}/resend',
      tags,
      summary: 'Send an open invitation again with a fresh link (admin)',
      middleware,
      request: { ...params, query: resendInvitationQuerySchema },
      responses: {
        200: json(z.object({ invitation: invitationSchema, emailed: z.boolean() }), 'Invitation'),
        ...COMMON_ERRORS,
      },
    }),
    async (c) =>
      c.json(
        await resendInvitation(deps, actorOf(c), c.req.valid('param').id, false, c.req.valid('query').expires_in_days),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/users/invitations/{id}/link',
      tags,
      summary: 'A fresh invitation link to copy and send another way (WhatsApp …) — nothing is emailed (admin)',
      middleware,
      request: { ...params, query: resendInvitationQuerySchema },
      responses: {
        200: json(z.object({ invitation: invitationSchema, emailed: z.boolean() }), 'Invitation with its url'),
        ...COMMON_ERRORS,
      },
    }),
    async (c) =>
      c.json(
        await resendInvitation(deps, actorOf(c), c.req.valid('param').id, true, c.req.valid('query').expires_in_days),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/users/{id}/recovery-link',
      tags,
      summary:
        'A one-time link (1 hour) for a member to choose a new password and sign in — copied, never emailed; audited (admin)',
      middleware,
      request: params,
      responses: { 200: json(recoveryLinkSchema, 'Link'), ...errors(400, 401, 403, 404, 429) },
    }),
    async (c) => c.json(await accountRecoveryLink(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/users/{id}/reset-2fa',
      tags,
      summary:
        "Turn a member's two-factor authentication off (lost phone, no backup codes) — same rules as the recovery link; audited auth.2fa.reset (admin)",
      middleware,
      request: params,
      responses: { 200: json(okSchema, 'Reset'), ...errors(400, 401, 403, 404, 409) },
    }),
    async (c) => c.json(await resetMemberTwoFactor(deps, actorOf(c), c.req.valid('param').id, requestMeta(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/users/{id}',
      tags,
      summary: "Change a member's role, name, job title, department or phone (admin; never your own role)",
      middleware,
      request: { ...params, ...jsonBody(updateUserSchema) },
      responses: { 200: json(memberSchema, 'Member'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await updateUser(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/users/{id}/deactivate',
      tags,
      summary: 'Deactivate a member (optionally transferring what they own first, in one transaction)',
      middleware,
      request: { ...params, ...jsonBody(deactivateUserSchema) },
      responses: {
        200: json(z.object({ user: memberSchema, transfer: transferResultSchema.nullable() }), 'Deactivated'),
        ...COMMON_ERRORS,
      },
    }),
    async (c) => c.json(await deactivateUser(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/users/{id}/activate',
      tags,
      summary: 'Activate a deactivated member again',
      middleware,
      request: params,
      responses: { 200: json(memberSchema, 'Member'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await activateUser(deps, actorOf(c), c.req.valid('param').id), 200),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/users/{id}/transfer-ownership',
      tags,
      summary:
        'Move boards, automations, webhooks, service tokens and (optionally) people assignments to another member',
      middleware,
      request: { ...params, ...jsonBody(transferOwnershipSchema) },
      responses: { 200: json(transferResultSchema, 'Transferred'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await transferOwnership(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/users/{id}/export',
      tags,
      summary: "A member's personal data in this account, as JSON (an access request; admins only, audited)",
      middleware,
      request: params,
      responses: { 200: json(personalExportSchema, 'Export'), ...errors(401, 403, 404, 429) },
    }),
    async (c) => {
      const data = await exportMemberData(db, actorOf(c), c.req.valid('param').id, requestMeta(c));
      c.header('Content-Disposition', `attachment; filename="member-data-${data.generated_at.slice(0, 10)}.json"`);
      c.header('Cache-Control', 'no-store');
      return c.json(data, 200);
    },
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/users/{id}/details',
      tags,
      summary: "Delete a deactivated member's personal details (anonymise; content stays)",
      middleware,
      request: { ...params, query: deleteUserDetailsSchema },
      responses: { 200: json(memberSchema, 'Member'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await deleteUserDetails(deps, actorOf(c), c.req.valid('param').id, c.req.valid('query')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/accounts/me/default-transfer-user',
      tags: ['accounts'],
      summary: 'The default "transfer to" member offered when deactivating someone (admin)',
      middleware,
      request: { headers: accountHeader },
      responses: { 200: json(defaultTransferUserSchema, 'Setting'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await getDefaultTransferUser(db, actorOf(c)), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/accounts/me/default-transfer-user',
      tags: ['accounts'],
      summary: 'Set (or clear) the default "transfer to" member (admin)',
      middleware,
      request: { headers: accountHeader, ...jsonBody(defaultTransferUserSchema) },
      responses: { 200: json(defaultTransferUserSchema, 'Setting'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await setDefaultTransferUser(db, actorOf(c), c.req.valid('json').user_id), 200),
  );

  return r;
};
