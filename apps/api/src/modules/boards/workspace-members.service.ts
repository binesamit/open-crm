// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, newId } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps, Actor } from '../../types';
import { findMembership } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { inviteNewPeople } from '../invitations/invitations.service';
import { workspaceVisibleTo } from './boards.access';
import { findWorkspace, type WorkspaceRow, workspaceIdsWithMember } from './boards.repo';
import {
  deleteWorkspaceMember,
  findWorkspaceMember,
  insertWorkspaceMember,
  listWorkspaceMembers,
} from './workspace-members.repo';

type Deps = Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>;

/**
 * Workspace members (owner fix6-server 3b, 05 §3): a closed workspace is seen by admins and its members only, so
 * its editors (admins, its creator, its owners) add account members, invite new people by email (they join on
 * accepting) and remove members. Open workspaces keep the list too (it is ready when one is closed).
 */

/** A workspace the actor sees (guests never manage workspaces); anything else is a 404. */
const loadVisible = async (db: Db, a: Actor, workspaceId: string) => {
  const workspace = await findWorkspace(db, a.ctx.accountId, workspaceId);
  if (!workspace || a.ctx.role === 'guest') throw new AppError('not_found', 'Workspace not found');
  const memberOf = await workspaceIdsWithMember(db, a.ctx.accountId, a.user.id);
  if (!workspaceVisibleTo(workspace, a.ctx, memberOf)) throw new AppError('not_found', 'Workspace not found');
  return workspace;
};

const canManage = async (db: Db, a: Actor, w: WorkspaceRow) =>
  a.ctx.role === 'admin' ||
  (a.ctx.role !== 'viewer' &&
    (w.createdBy === a.user.id || (await findWorkspaceMember(db, a.ctx.accountId, w.id, a.user.id))?.role === 'owner'));

const assertManage = async (db: Db, a: Actor, w: WorkspaceRow) => {
  if (!(await canManage(db, a, w))) throw new AppError('forbidden', 'workspace_owner_only');
};

export const getWorkspaceMembers = async (db: Db, a: Actor, workspaceId: string) => {
  const workspace = await loadVisible(db, a, workspaceId);
  const rows = await listWorkspaceMembers(db, a.ctx.accountId, workspaceId);
  return {
    kind: workspace.kind,
    members: rows.map((m) => ({
      user_id: m.userId!,
      name: m.name ?? '',
      email: m.email,
      role: m.role,
      account_role: m.accountRole,
    })),
    can_manage: await canManage(db, a, workspace),
  };
};

/** Adds one account member (not guests: they see the shareable boards they subscribe to). */
export const addWorkspaceMember = async (
  db: Db,
  a: Actor,
  workspace: WorkspaceRow,
  userId: string,
  role: 'owner' | 'member' = 'member',
  via?: string,
) => {
  const added = await insertWorkspaceMember(db, {
    id: newId(),
    accountId: a.ctx.accountId,
    workspaceId: workspace.id,
    userId,
    role,
    addedBy: a.user.id,
  });
  if (added)
    await recordEvent(db, {
      accountId: a.ctx.accountId,
      type: 'workspace.members_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      before: null,
      after: { workspace_id: workspace.id, user_id: userId, role, ...(via ? { via } : {}) },
    });
  return added;
};

export type AddWorkspaceMembersInput = {
  user_ids?: string[];
  emails?: string[];
  /** The account role of people invited by email (never guest). */
  role?: 'admin' | 'member' | 'viewer';
  message?: string;
  /** false = no emails, only the links to copy. */
  send_email?: boolean;
};

/**
 * POST /workspaces/:id/members — account members by id join at once; emails of people already in the account
 * join at once too; new emails get an account invitation that joins the workspace on accepting.
 */
export const addWorkspaceMembers = async (
  deps: Deps,
  a: Actor,
  workspaceId: string,
  input: AddWorkspaceMembersInput,
) => {
  const { db } = deps;
  const workspace = await loadVisible(db, a, workspaceId);
  await assertManage(db, a, workspace);
  const errors: { email?: string; user_id?: string; code: string }[] = [];
  const toAdd: string[] = [];
  for (const userId of new Set(input.user_ids ?? [])) {
    const m = await findMembership(db, a.ctx.accountId, userId);
    if (!m || m.status !== 'active') errors.push({ user_id: userId, code: 'unknown_member' });
    else if (m.role === 'guest') errors.push({ user_id: userId, code: 'guest_not_workspace_member' });
    else toAdd.push(userId);
  }
  let invited: Awaited<ReturnType<typeof inviteNewPeople>>['invited'] = [];
  if (input.emails?.length) {
    const res = await inviteNewPeople(deps, a.ctx, a.user, {
      emails: input.emails,
      role: input.role ?? 'member',
      message: input.message,
      sendEmail: input.send_email,
      workspaceIds: [workspace.id],
    });
    invited = res.invited;
    errors.push(...res.errors);
    for (const e of res.existing) {
      if (e.role === 'guest') errors.push({ email: e.email, code: 'guest_not_workspace_member' });
      else toAdd.push(e.userId);
    }
  }
  await db.transaction(async (tx) => {
    for (const userId of new Set(toAdd)) await addWorkspaceMember(tx, a, workspace, userId);
  });
  return { ...(await getWorkspaceMembers(db, a, workspaceId)), invited, errors };
};

/** DELETE /workspaces/:id/members/:userId — editors remove anyone; a member may leave. */
export const removeWorkspaceMember = async (db: Db, a: Actor, workspaceId: string, userId: string) => {
  const workspace = await loadVisible(db, a, workspaceId);
  if (userId !== a.user.id) await assertManage(db, a, workspace);
  const current = await findWorkspaceMember(db, a.ctx.accountId, workspaceId, userId);
  if (!current) throw new AppError('not_found', 'Not a member');
  await db.transaction(async (tx) => {
    await deleteWorkspaceMember(tx, a.ctx.accountId, workspaceId, userId);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'workspace.members_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { workspace_id: workspaceId, user_id: userId, role: current.role },
      after: null,
    });
  });
  // Leaving a closed workspace takes it out of sight: the answer is then the plain result.
  const memberOf = await workspaceIdsWithMember(db, a.ctx.accountId, a.user.id);
  return workspaceVisibleTo(workspace, a.ctx, memberOf)
    ? getWorkspaceMembers(db, a, workspaceId)
    : { kind: workspace.kind, members: [], can_manage: false };
};
