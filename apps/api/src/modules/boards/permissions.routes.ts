// SPDX-License-Identifier: AGPL-3.0-only
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  accountRoleSchema,
  boardMemberInputSchema,
  invitationSchema,
  boardPermissionsSchema,
  columnRestrictionSchema,
  updateBoardPermissionsSchema,
} from '@bines/shared';
import { requireAccount, actorOf } from '../../middleware/auth';
import { accountHeader, json, jsonBody, COMMON_ERRORS } from '../../lib/openapi';
import type { AppDeps, AppEnv } from '../../types';
import * as svc from './permissions.service';
import * as ws from './workspace-members.service';

const boardParam = z.object({ boardId: z.string().openapi({ param: { name: 'boardId', in: 'path' } }) });
const memberParams = boardParam.extend({ userId: z.string().openapi({ param: { name: 'userId', in: 'path' } }) });
const teamParams = boardParam.extend({ teamId: z.string().openapi({ param: { name: 'teamId', in: 'path' } }) });
const columnParams = boardParam.extend({ columnId: z.string().openapi({ param: { name: 'columnId', in: 'path' } }) });
const answer = { 200: json(boardPermissionsSchema, 'Permissions'), ...COMMON_ERRORS };
const emails = z.array(z.email().toLowerCase()).min(1).max(50);
const inviteErrors = z.array(
  z.object({ email: z.string().optional(), user_id: z.string().optional(), code: z.string() }),
);
const boardInviteSchema = z.object({
  emails,
  role: accountRoleSchema.default('member'),
  message: z.string().max(1000).optional(),
  /** false = no emails to new people, only their links to copy. */
  send_email: z.boolean().optional(),
});
const boardInviteResultSchema = z.object({
  invited: z.array(invitationSchema),
  added: z.array(z.object({ email: z.string(), user_id: z.string() })),
  errors: inviteErrors,
  permissions: boardPermissionsSchema,
});
const workspaceParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const workspaceMemberParams = workspaceParam.extend({
  userId: z.string().openapi({ param: { name: 'userId', in: 'path' } }),
});
const workspaceMembersSchema = z.object({
  kind: z.enum(['open', 'closed']),
  members: z.array(
    z.object({
      user_id: z.string(),
      name: z.string(),
      email: z.string(),
      role: z.enum(['owner', 'member']),
      account_role: accountRoleSchema,
    }),
  ),
  can_manage: z.boolean(),
});
const addWorkspaceMembersSchema = z
  .object({
    user_ids: z.array(z.string()).max(50).optional(),
    emails: emails.optional(),
    role: z.enum(['admin', 'member', 'viewer']).default('member'),
    message: z.string().max(1000).optional(),
    /** false = no emails to new people, only their links to copy. */
    send_email: z.boolean().optional(),
  })
  .refine((v) => (v.user_ids?.length ?? 0) + (v.emails?.length ?? 0) > 0, { message: 'user_ids or emails' });

/** The board permissions dialog (05 §4–6). */
export const permissionRoutes = (deps: AppDeps) => {
  const { db } = deps;
  const scoped = [requireAccount(deps)];
  const r = new OpenAPIHono<AppEnv>();

  r.openapi(
    createRoute({
      method: 'get',
      path: '/boards/{boardId}/permissions',
      tags: ['permissions'],
      summary: 'Permission set, item visibility, owners/subscribers, owner-only columns',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: answer,
    }),
    async (c) => c.json(await svc.getPermissions(db, actorOf(c), c.req.valid('param').boardId), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{boardId}/permissions',
      tags: ['permissions'],
      summary: 'Change the permission set and/or who sees which items (owners / admins)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(updateBoardPermissionsSchema) },
      responses: answer,
    }),
    async (c) =>
      c.json(await svc.updatePermissions(db, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{boardId}/members/{userId}',
      tags: ['permissions'],
      summary: 'Subscribe a member, make them owner / subscriber, or set an explicit role (a board keeps an owner)',
      middleware: scoped,
      request: { headers: accountHeader, params: memberParams, ...jsonBody(boardMemberInputSchema) },
      responses: answer,
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.setMember(db, actorOf(c), p.boardId, p.userId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/boards/{boardId}/members/{userId}',
      tags: ['permissions'],
      summary: 'Remove a member (or leave the board)',
      middleware: scoped,
      request: { headers: accountHeader, params: memberParams },
      responses: answer,
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.removeMember(db, actorOf(c), p.boardId, p.userId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/claim',
      tags: ['permissions'],
      summary: 'An admin takes ownership of a board no owner can act on (409 has_active_owner otherwise)',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam },
      responses: answer,
    }),
    async (c) => c.json(await svc.claimOwnership(db, actorOf(c), c.req.valid('param').boardId), 200),
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{boardId}/teams/{teamId}',
      tags: ['permissions'],
      summary: 'Subscribe a team (all its members), as owner or subscriber, with an optional explicit role',
      middleware: scoped,
      request: { headers: accountHeader, params: teamParams, ...jsonBody(boardMemberInputSchema) },
      responses: answer,
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.setTeam(db, actorOf(c), p.boardId, p.teamId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/boards/{boardId}/teams/{teamId}',
      tags: ['permissions'],
      summary: 'Unsubscribe a team',
      middleware: scoped,
      request: { headers: accountHeader, params: teamParams },
      responses: answer,
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.removeTeam(db, actorOf(c), p.boardId, p.teamId), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'put',
      path: '/boards/{boardId}/columns/{columnId}/restriction',
      tags: ['permissions'],
      summary:
        'Restricted column: edit (others read) or view (others do not see it) — owners and the listed people/teams; null clears',
      middleware: scoped,
      request: { headers: accountHeader, params: columnParams, ...jsonBody(columnRestrictionSchema) },
      responses: answer,
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await svc.setColumnRestriction(db, actorOf(c), p.boardId, p.columnId, c.req.valid('json')), 200);
    },
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/boards/{boardId}/invite',
      tags: ['permissions'],
      summary: 'Invite by email from the board: account members are subscribed at once, new people get an invitation',
      description:
        'New people join the account with `role` (guest only on shareable boards) and are subscribed on accepting; ' +
        'a board in a closed workspace also adds them to the workspace.',
      middleware: scoped,
      request: { headers: accountHeader, params: boardParam, ...jsonBody(boardInviteSchema) },
      responses: { 200: json(boardInviteResultSchema, 'Invited'), ...COMMON_ERRORS },
    }),
    async (c) =>
      c.json(await svc.inviteToBoard(deps, actorOf(c), c.req.valid('param').boardId, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'get',
      path: '/workspaces/{id}/members',
      tags: ['workspaces'],
      summary: 'Workspace members (who sees a closed workspace) and whether the actor manages them',
      middleware: scoped,
      request: { headers: accountHeader, params: workspaceParam },
      responses: { 200: json(workspaceMembersSchema, 'Members'), ...COMMON_ERRORS },
    }),
    async (c) => c.json(await ws.getWorkspaceMembers(db, actorOf(c), c.req.valid('param').id), 200),
  );
  r.openapi(
    createRoute({
      method: 'post',
      path: '/workspaces/{id}/members',
      tags: ['workspaces'],
      summary: 'Add account members, or invite new people by email (they join on accepting) — workspace editors',
      middleware: scoped,
      request: { headers: accountHeader, params: workspaceParam, ...jsonBody(addWorkspaceMembersSchema) },
      responses: {
        200: json(
          workspaceMembersSchema.extend({ invited: z.array(invitationSchema), errors: inviteErrors }),
          'Members',
        ),
        ...COMMON_ERRORS,
      },
    }),
    async (c) =>
      c.json(await ws.addWorkspaceMembers(deps, actorOf(c), c.req.valid('param').id, c.req.valid('json')), 200),
  );
  r.openapi(
    createRoute({
      method: 'delete',
      path: '/workspaces/{id}/members/{userId}',
      tags: ['workspaces'],
      summary: 'Remove a workspace member (editors), or leave it',
      middleware: scoped,
      request: { headers: accountHeader, params: workspaceMemberParams },
      responses: { 200: json(workspaceMembersSchema, 'Members'), ...COMMON_ERRORS },
    }),
    async (c) => {
      const p = c.req.valid('param');
      return c.json(await ws.removeWorkspaceMember(db, actorOf(c), p.id, p.userId), 200);
    },
  );
  return r;
};
