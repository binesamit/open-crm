// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountDetailSchema,
  emailPreviewQuerySchema,
  emailPreviewSchema,
  invitationSchema,
  inviteResultSchema,
  inviteUsersSchema,
  listUsersQuerySchema,
  memberSchema,
  setAccountLogoSchema,
  sendTestEmailSchema,
  setAvatarSchema,
  testEmailResultSchema,
  updateAccountSchema,
} from '@bines/shared';
import { currentUser, requestMeta, requireAccount } from '../../middleware/auth';
import { accountHeader, errors, idParam, json, jsonBody, okSchema } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import { inviteUsers, listAccountInvitations, revokeAccountInvitation } from '../invitations/invitations.service';
import { adminRoutes } from '../admin/admin.routes';
import { userAdminRoutes } from '../users/admin.routes';
import { listMembers, removeMyAvatar, setMyAvatar } from '../users/users.service';
import {
  accountLogoLocation,
  emailLogoLocation,
  getAccountDetail,
  removeAccountEmailLogo,
  removeAccountLogo,
  setAccountEmailLogo,
  setAccountLogo,
  updateAccount,
} from './accounts.service';
import { previewEmail, sendTestEmail } from './email-preview.service';

/** Account-scoped routes (X-Account-Id + membership, D12): the account itself, its users and invitations. */
export const accountRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/accounts/me',
      tags: ['accounts'],
      summary: 'The current account and its settings',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(accountDetailSchema, 'Account'), ...errors(400, 401, 403, 404, 423) },
    }),
    async (c) => c.json(await getAccountDetail(deps, c.get('account')), 200),
  );

  r.openapi(
    createRoute({
      method: 'patch',
      path: '/accounts/me',
      tags: ['accounts'],
      summary: 'Update name and settings (admin)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(updateAccountSchema) },
      responses: { 200: json(accountDetailSchema, 'Account'), ...errors(400, 401, 403, 404, 423) },
    }),
    async (c) =>
      c.json(
        await updateAccount(
          deps,
          { ctx: c.get('account'), user: currentUser(c), requestId: c.get('requestId') },
          c.req.valid('json'),
          requestMeta(c),
        ),
        200,
      ),
  );

  // The logo (A3): set from an upload, removed, and served to <img> through a redirect to a signed URL.
  r.openapi(
    createRoute({
      method: 'put',
      path: '/accounts/me/logo',
      tags: ['accounts'],
      summary: 'Set the account logo from an uploaded image ≤2 MB (admin)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(setAccountLogoSchema) },
      responses: { 200: json(accountDetailSchema, 'Account'), ...errors(400, 401, 403, 404, 413, 422, 423) },
    }),
    async (c) =>
      c.json(
        await setAccountLogo(
          deps,
          { ctx: c.get('account'), user: currentUser(c), requestId: c.get('requestId') },
          c.req.valid('json').file_id,
          requestMeta(c),
        ),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/accounts/me/logo',
      tags: ['accounts'],
      summary: 'Remove the account logo (admin)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(accountDetailSchema, 'Account'), ...errors(401, 403, 404, 423) },
    }),
    async (c) =>
      c.json(
        await removeAccountLogo(
          deps,
          { ctx: c.get('account'), user: currentUser(c), requestId: c.get('requestId') },
          requestMeta(c),
        ),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/accounts/me/logo',
      tags: ['accounts'],
      summary: 'Redirect to the account logo (also takes ?account_id= — an <img> cannot send headers)',
      middleware: [requireAccount(deps, { query: true })],
      request: { query: z.object({ account_id: z.string().optional(), v: z.string().optional() }) },
      responses: { 302: { description: 'Redirect to a short-lived signed URL' }, ...errors(401, 403, 404, 423) },
    }),
    async (c) => {
      c.header('cache-control', 'private, max-age=300');
      return c.redirect(await accountLogoLocation(deps, c.get('account')), 302);
    },
  );

  // The email logo (ANSWERS 6א.3): a separate mark for emails; public redirect so an email shows it days later.
  r.openapi(
    createRoute({
      method: 'put',
      path: '/accounts/me/email-logo',
      tags: ['accounts'],
      summary: 'Set the logo shown in the account emails from an uploaded image ≤2 MB (admin)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(setAccountLogoSchema) },
      responses: { 200: json(accountDetailSchema, 'Account'), ...errors(400, 401, 403, 404, 413, 422, 423) },
    }),
    async (c) =>
      c.json(
        await setAccountEmailLogo(
          deps,
          { ctx: c.get('account'), user: currentUser(c), requestId: c.get('requestId') },
          c.req.valid('json').file_id,
          requestMeta(c),
        ),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/accounts/me/email-logo',
      tags: ['accounts'],
      summary: 'Remove the email logo — emails show the account logo (admin)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: json(accountDetailSchema, 'Account'), ...errors(401, 403, 404, 423) },
    }),
    async (c) =>
      c.json(
        await removeAccountEmailLogo(
          deps,
          { ctx: c.get('account'), user: currentUser(c), requestId: c.get('requestId') },
          requestMeta(c),
        ),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/public/email-logo/{id}',
      tags: ['accounts'],
      summary: 'Public: redirect to the account email logo (for <img> in emails)',
      request: { params: idParam, query: z.object({ v: z.string().max(40).optional() }) },
      responses: { 302: { description: 'Redirect to a short-lived signed URL' }, ...errors(404) },
    }),
    async (c) => {
      c.header('cache-control', 'public, max-age=300');
      return c.redirect(await emailLogoLocation(deps, c.req.valid('param').id), 302);
    },
  );
  // M11: how the account's emails look (any template, sample data, he/en) and a test send to the admin.
  r.openapi(
    createRoute({
      method: 'get',
      path: '/accounts/me/email-preview',
      tags: ['accounts'],
      summary: "Render any email with sample data in the account's brand, in Hebrew or English (admin)",
      description:
        "Returns the subject, HTML and plain-text parts of one email (invitation, sign-in link, password reset, notification, digest, automation email, channel test) as this account's members get it: sender name, Reply-To, logo and accent colour. `accent` tries an unsaved colour. Account admins only.",
      middleware: scoped,
      request: { headers: accountHeader, query: emailPreviewQuerySchema },
      responses: { 200: json(emailPreviewSchema, 'Email preview'), ...errors(400, 401, 403, 404, 423) },
    }),
    async (c) =>
      c.json(await previewEmail(deps, { ctx: c.get('account'), user: currentUser(c) }, c.req.valid('query')), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/accounts/me/email-test',
      tags: ['accounts'],
      summary:
        'Send any email with sample data to yourself, marked as a test (admin; rate-limited; MAIL_ALLOWLIST applies)',
      description:
        "Sends the chosen email, with sample data and a test mark in the subject, to the signed-in admin's own address only. Limited per admin per hour by the platform setting (429 `rate_limited`). When MAIL_ALLOWLIST is set and the address is not on it, nothing is sent and `skipped` is `not_allowlisted`.",
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(sendTestEmailSchema) },
      responses: {
        200: json(testEmailResultSchema, 'Test email'),
        ...errors(400, 401, 403, 404, 423, 429),
        503: { description: 'The email could not be sent' },
      },
    }),
    async (c) =>
      c.json(await sendTestEmail(deps, { ctx: c.get('account'), user: currentUser(c) }, c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/users',
      tags: ['users'],
      summary: 'Members of the account (filters: role, status, team_id, q)',
      middleware: scoped,
      request: { headers: accountHeader, query: listUsersQuerySchema },
      responses: {
        200: json(z.object({ data: z.array(memberSchema) }), 'Members'),
        ...errors(400, 401, 403, 404, 423),
      },
    }),
    async (c) => c.json({ data: await listMembers(deps, c.get('account'), currentUser(c), c.req.valid('query')) }, 200),
  );
  const avatarResponse = json(z.object({ avatar_url: z.string().nullable() }), 'Avatar');
  r.openapi(
    createRoute({
      method: 'put',
      path: '/users/me/avatar',
      tags: ['users'],
      summary: 'Set my profile photo from an uploaded image (≤5 MB)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(setAvatarSchema) },
      responses: { 200: avatarResponse, ...errors(400, 401, 403, 404, 413, 422, 423) },
    }),
    async (c) =>
      c.json(
        await setMyAvatar(
          deps,
          { ctx: c.get('account'), user: currentUser(c), requestId: c.get('requestId') },
          c.req.valid('json').file_id,
        ),
        200,
      ),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/users/me/avatar',
      tags: ['users'],
      summary: 'Remove my profile photo',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: { 200: avatarResponse, ...errors(401, 403, 404, 423) },
    }),
    async (c) =>
      c.json(
        await removeMyAvatar(deps, { ctx: c.get('account'), user: currentUser(c), requestId: c.get('requestId') }),
        200,
      ),
  );

  r.openapi(
    createRoute({
      method: 'post',
      path: '/users/invite',
      tags: ['users'],
      summary: 'Invite people by email (05 §2 decides who may invite which role)',
      middleware: scoped,
      request: { headers: accountHeader, ...jsonBody(inviteUsersSchema) },
      responses: { 200: json(inviteResultSchema, 'Result'), ...errors(400, 401, 403, 404, 422, 423) },
    }),
    async (c) => c.json(await inviteUsers(deps, c.get('account'), currentUser(c), c.req.valid('json')), 200),
  );

  r.openapi(
    createRoute({
      method: 'get',
      path: '/users/invitations',
      tags: ['users'],
      summary: 'Open invitations — pending and expired — with status, inviter and email history (admin)',
      middleware: scoped,
      request: { headers: accountHeader },
      responses: {
        200: json(z.object({ data: z.array(invitationSchema) }), 'Invitations'),
        ...errors(401, 403, 404, 423),
      },
    }),
    async (c) => c.json({ data: await listAccountInvitations(db, c.get('account')) }, 200),
  );

  r.openapi(
    createRoute({
      method: 'delete',
      path: '/users/invitations/{id}',
      tags: ['users'],
      summary: 'Revoke a pending invitation (admin)',
      middleware: scoped,
      request: { headers: accountHeader, params: idParam },
      responses: { 200: json(okSchema, 'Revoked'), ...errors(401, 403, 404, 423) },
    }),
    async (c) => {
      await revokeAccountInvitation(db, c.get('account'), currentUser(c), c.req.valid('param').id, requestMeta(c));
      return c.json({ ok: true as const }, 200);
    },
  );

  // Administration → users (A2): role, edit, deactivate / activate, transfer, delete details, bulk, CSV.
  r.route('/', userAdminRoutes(deps));
  // Administration A4 + A5: security, audit log, usage, tidy up.
  r.route('/', adminRoutes(deps));

  return r;
};
