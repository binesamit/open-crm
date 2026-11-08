// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type BoardRole, canBoard, deleteGuardOf, type updateBoardPermissionsSchema } from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { AppDeps, Actor } from '../../types';
import { findMembership } from '../accounts/accounts.repo';
import { inviteNewPeople } from '../invitations/invitations.service';
import { addWorkspaceMember } from './workspace-members.service';
import { recordEvent } from '../activity/activity.repo';
import { isAccountMember } from '../items/items.repo';
import { recomputeNamesAfterRestriction } from '../items/names.service';
import { assertBoard, type BoardAccess, loadBoardAccess } from './boards.access';
import { findTeam } from '../teams/teams.repo';
import { guestPeople } from '../users/guest-people';
import { assertFreshCode } from '../secrets/step-up';
import {
  deleteBoardMember,
  deleteBoardTeam,
  findColumnByKey,
  hasActiveOwner,
  insertBoardMember,
  listBoardMembers,
  listBoardTeams,
  listColumns,
  setBoardMemberRole,
  updateBoardRow,
  updateColumnRow,
  upsertBoardTeam,
} from './boards.repo';

/**
 * The board permissions dialog (05 §4–6): the permission set, who sees which items (`view_items`), owners
 * and subscribers (people and teams, each with an optional explicit role), and owner-only columns. Changing them
 * is `board.manage_permissions` (owners, admins); adding a plain subscriber is `board.invite`. A board always keeps
 * an owner (a person or a team).
 */

type Subscription = { role: 'owner' | 'subscriber'; level: BoardRole | null };

/** Owners left if `change` is applied — a board keeps one (a person or a team). */
const ownersAfter = async (
  db: Db,
  boardId: string,
  change: { userId?: string; teamId?: string; to: Subscription | null },
) => {
  const [members, teams] = await Promise.all([listBoardMembers(db, boardId), listBoardTeams(db, boardId)]);
  const people = members.filter((m) => m.userId !== change.userId && m.role === 'owner').length;
  const viaTeams = teams.filter((t) => t.teamId !== change.teamId && t.role === 'owner').length;
  return people + viaTeams + (change.to?.role === 'owner' ? 1 : 0);
};
const loadMain = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  return access;
};

const viewItemsOf = (access: BoardAccess) => {
  const cfg = access.board.viewItemsConfig as { column_ids?: string[] | 'any_people' };
  return {
    // by_filter (rules) is shown as the closest built mode.
    mode: access.board.viewItems === 'all' ? ('all' as const) : ('assigned_or_created' as const),
    column_ids: cfg.column_ids ?? ('any_people' as const),
  };
};

export const getPermissions = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadMain(db, a, boardId);
  const [allMembers, allTeams, columns, owned] = await Promise.all([
    listBoardMembers(db, boardId),
    listBoardTeams(db, boardId),
    listColumns(db, boardId),
    hasActiveOwner(db, a.ctx.accountId, boardId),
  ]);
  // A guest sees only the people they may see anyway (D22.7) — not other guests of the board's items — and no teams.
  const people = a.ctx.role === 'guest' ? await guestPeople(db, a) : null;
  const members = people ? allMembers.filter((m) => people.has(m.userId)) : allMembers;
  const teams = people ? [] : allTeams;
  return {
    permission_set: access.board.permissionSet,
    view_items: viewItemsOf(access),
    delete_guard: deleteGuardOf(access.board.settings),
    members: members.map((m) => ({
      user_id: m.userId,
      name: m.name ?? '',
      email: m.email,
      role: m.role,
      level: m.level,
    })),
    teams: teams.map((t) => ({ team_id: t.teamId, name: t.name, role: t.role, level: t.level })),
    column_restrictions: columns.flatMap((c) => {
      const list = c.restrictedView ?? c.restrictedEdit;
      if (!list) return [];
      return [{ column_id: c.key, kind: c.restrictedView ? ('view' as const) : ('edit' as const), ...list }];
    }),
    can_manage: canBoard(access.perm, 'board.manage_permissions').ok,
    has_active_owner: owned,
  };
};

export const updatePermissions = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: z.infer<typeof updateBoardPermissionsSchema>,
) => {
  const access = await loadMain(db, a, boardId);
  assertBoard(access, 'board.manage_permissions');
  if (input.view_items && Array.isArray(input.view_items.column_ids)) {
    const people = (await listColumns(db, boardId)).filter((c) => c.type === 'people').map((c) => c.key);
    if (input.view_items.column_ids.some((k) => !people.includes(k))) {
      throw new AppError('invalid_value', 'Only people columns assign items');
    }
  }
  // while deleting takes a code, changing that (off, a longer window) takes the same code.
  const guardBefore = deleteGuardOf(access.board.settings);
  const guardChanged = !!input.delete_guard && JSON.stringify(input.delete_guard) !== JSON.stringify(guardBefore);
  if (guardChanged && guardBefore.enabled) {
    if (a.ctx.support) throw new AppError('forbidden', 'delete_requires_code');
    await assertFreshCode(db, a, guardBefore);
  }
  await db.transaction(async (tx) => {
    await updateBoardRow(tx, boardId, {
      ...(input.permission_set ? { permissionSet: input.permission_set } : {}),
      ...(input.view_items
        ? { viewItems: input.view_items.mode, viewItemsConfig: { column_ids: input.view_items.column_ids } }
        : {}),
      ...(guardChanged ? { settings: { ...(access.board.settings ?? {}), delete_guard: input.delete_guard } } : {}),
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.permissions_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: {
        permission_set: access.board.permissionSet,
        view_items: viewItemsOf(access),
        ...(guardChanged ? { delete_guard: guardBefore } : {}),
      },
      after: input,
    });
  });
  return getPermissions(db, a, boardId);
};

/**
 * POST /boards/:id/claim — an admin takes ownership of a board no owner can act on (05 §4). With an active owner
 * it is refused: ask them, or change owners in the dialog.
 */
export const claimOwnership = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadMain(db, a, boardId);
  if (access.perm.accountRole !== 'admin') throw new AppError('forbidden', 'admin_only');
  if (await hasActiveOwner(db, a.ctx.accountId, boardId)) throw new AppError('conflict', 'has_active_owner');
  const current = (await listBoardMembers(db, boardId)).find((m) => m.userId === a.user.id);
  await db.transaction(async (tx) => {
    if (current) await setBoardMemberRole(tx, boardId, a.user.id, { role: 'owner', level: null });
    else
      await insertBoardMember(tx, {
        boardId,
        userId: a.user.id,
        accountId: a.ctx.accountId,
        role: 'owner',
        addedBy: a.user.id,
      });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.ownership_claimed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: current ? { user_id: a.user.id, role: current.role, level: current.level } : null,
      after: { user_id: a.user.id, role: 'owner' },
    });
  });
  return getPermissions(db, a, boardId);
};

/** Owners are named, and explicit roles set, by owners/admins; anyone who may invite adds plain subscribers. */
const needed = (to: Subscription, current: Subscription | undefined) =>
  to.role === 'owner' || current?.role === 'owner' || to.level !== null || (current?.level ?? null) !== null
    ? ('board.manage_permissions' as const)
    : ('board.invite' as const);

/** PUT /boards/:id/members/:userId — subscribe someone, make them owner / subscriber, or set their explicit role. */
export const setMember = async (db: Db, a: Actor, boardId: string, userId: string, to: Subscription) => {
  const access = await loadMain(db, a, boardId);
  const current = (await listBoardMembers(db, boardId)).find((m) => m.userId === userId);
  assertBoard(access, needed(to, current));
  if (!(await isAccountMember(db, a.ctx.accountId, [userId]))) throw new AppError('invalid_value', 'Unknown member');
  // 05 §2: guests and account viewers never own a board (`canBoard` would not count them anyway).
  if (to.role === 'owner') {
    const accountRole = (await findMembership(db, a.ctx.accountId, userId))?.role;
    if (accountRole === 'guest' || accountRole === 'viewer')
      throw new AppError('invalid_value', 'board_owner_must_be_member');
  }
  if (current?.role === 'owner' && (await ownersAfter(db, boardId, { userId, to })) < 1) {
    throw new AppError('last_owner', 'A board keeps an owner');
  }
  const level = to.role === 'owner' ? null : to.level;
  const joinsWorkspace = !current && (await mustJoinWorkspace(db, a, access, userId));
  await db.transaction(async (tx) => {
    if (current) await setBoardMemberRole(tx, boardId, userId, { role: to.role, level });
    else
      await insertBoardMember(tx, {
        boardId,
        userId,
        accountId: a.ctx.accountId,
        role: to.role,
        level,
        addedBy: a.user.id,
      });
    if (joinsWorkspace) await addWorkspaceMember(tx, a, access.workspace, userId, 'member', 'board');
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.members_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: current ? { user_id: userId, role: current.role, level: current.level } : null,
      after: { user_id: userId, role: to.role, level },
    });
  });
  return getPermissions(db, a, boardId);
};

/**
 * A board in a closed workspace is out of sight for whoever is not in the workspace — so subscribing an account
 * member (not a guest: guests see shareable boards by subscription alone) adds them to it (owner fix6-server 3).
 */
const mustJoinWorkspace = async (db: Db, a: Actor, access: BoardAccess, userId: string) => {
  if (access.workspace.kind !== 'closed') return false;
  const m = await findMembership(db, a.ctx.accountId, userId);
  return !!m && m.role !== 'guest';
};

export type BoardInviteInput = {
  emails: string[];
  /** The account role for people new to the account; guests only to shareable boards (05 §4). */
  role?: 'admin' | 'member' | 'viewer' | 'guest';
  message?: string;
  /** false = no emails, only the links to copy. */
  send_email?: boolean;
};

/**
 * POST /boards/:id/invite — "invite" in the board's members section: people already in the account
 * are subscribed at once; new emails get an account invitation that subscribes them on accepting (and joins the
 * closed workspace the board is in). Anyone who may invite to the board (`board.invite`); inviting new people to
 * the account follows the account's invite rules.
 */
export const inviteToBoard = async (
  deps: Pick<AppDeps, 'db' | 'mailer' | 'env' | 'logger'>,
  a: Actor,
  boardId: string,
  input: BoardInviteInput,
) => {
  const { db } = deps;
  const access = await loadMain(db, a, boardId);
  assertBoard(access, 'board.invite');
  const role = input.role ?? 'member';
  if (role === 'guest' && access.board.kind !== 'shareable')
    throw new AppError('invalid_value', 'guest_needs_shareable_board');
  const res = await inviteNewPeople(deps, a.ctx, a.user, {
    emails: input.emails,
    role,
    message: input.message,
    sendEmail: input.send_email,
    boardIds: [boardId],
    workspaceIds: access.workspace.kind === 'closed' && role !== 'guest' ? [access.workspace.id] : [],
  });
  const errors = [...res.errors];
  const added: { email: string; user_id: string }[] = [];
  const members = await listBoardMembers(db, boardId);
  await db.transaction(async (tx) => {
    for (const e of res.existing) {
      if (e.role === 'guest' && access.board.kind !== 'shareable') {
        errors.push({ email: e.email, code: 'guest_needs_shareable_board' });
        continue;
      }
      if (!members.some((m) => m.userId === e.userId)) {
        await insertBoardMember(tx, {
          boardId,
          userId: e.userId,
          accountId: a.ctx.accountId,
          role: 'subscriber',
          addedBy: a.user.id,
        });
        await recordEvent(tx, {
          accountId: a.ctx.accountId,
          type: 'board.members_changed',
          actorId: a.user.id,
          requestId: a.requestId,
          boardId,
          before: null,
          after: { user_id: e.userId, role: 'subscriber', level: null, via: 'invite' },
        });
      }
      if (access.workspace.kind === 'closed' && e.role !== 'guest')
        await addWorkspaceMember(tx, a, access.workspace, e.userId, 'member', 'board');
      added.push({ email: e.email, user_id: e.userId });
    }
  });
  return { invited: res.invited, added, errors, permissions: await getPermissions(db, a, boardId) };
};

/** PUT /boards/:id/teams/:teamId — subscribe a team (every member of it), as owner or subscriber. */
export const setTeam = async (db: Db, a: Actor, boardId: string, teamId: string, to: Subscription) => {
  const access = await loadMain(db, a, boardId);
  const current = (await listBoardTeams(db, boardId)).find((t) => t.teamId === teamId);
  assertBoard(access, needed(to, current));
  const team = await findTeam(db, a.ctx.accountId, teamId);
  if (!team) throw new AppError('invalid_value', 'Unknown team');
  if (current?.role === 'owner' && (await ownersAfter(db, boardId, { teamId, to })) < 1) {
    throw new AppError('last_owner', 'A board keeps an owner');
  }
  const level = to.role === 'owner' ? null : to.level;
  await db.transaction(async (tx) => {
    await upsertBoardTeam(tx, {
      boardId,
      teamId,
      accountId: a.ctx.accountId,
      role: to.role,
      level,
      addedBy: a.user.id,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.members_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: current ? { team_id: teamId, role: current.role, level: current.level } : null,
      after: { team_id: teamId, role: to.role, level },
    });
  });
  return getPermissions(db, a, boardId);
};

export const removeTeam = async (db: Db, a: Actor, boardId: string, teamId: string) => {
  const access = await loadMain(db, a, boardId);
  const current = (await listBoardTeams(db, boardId)).find((t) => t.teamId === teamId);
  if (!current) throw new AppError('not_found', 'Not subscribed');
  assertBoard(access, 'board.manage_permissions');
  if (current.role === 'owner' && (await ownersAfter(db, boardId, { teamId, to: null })) < 1) {
    throw new AppError('last_owner', 'A board keeps an owner');
  }
  await db.transaction(async (tx) => {
    await deleteBoardTeam(tx, boardId, teamId);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.members_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: { team_id: teamId, role: current.role, level: current.level },
      after: null,
    });
  });
  return getPermissions(db, a, boardId);
};

export const removeMember = async (db: Db, a: Actor, boardId: string, userId: string) => {
  const access = await loadMain(db, a, boardId);
  const current = (await listBoardMembers(db, boardId)).find((m) => m.userId === userId);
  if (!current) throw new AppError('not_found', 'Not a member');
  // Anyone may leave; removing others is for owners/admins.
  if (userId !== a.user.id) assertBoard(access, 'board.manage_permissions');
  if (current.role === 'owner' && (await ownersAfter(db, boardId, { userId, to: null })) < 1) {
    throw new AppError('last_owner', 'A board keeps an owner');
  }
  await db.transaction(async (tx) => {
    await deleteBoardMember(tx, boardId, userId);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.members_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: { user_id: userId, role: current.role, level: current.level },
      after: null,
    });
  });
  return getPermissions(db, a, boardId);
};

/**
 * PUT /boards/:id/columns/:key/restriction — `edit`: only owners (and the listed people/teams) edit it; `view`: only
 * they see it (05 §6.1).
 */
export const setColumnRestriction = async (
  db: Db,
  a: Actor,
  boardId: string,
  key: string,
  input: { kind: 'edit' | 'view' | null; users: string[]; teams: string[] },
) => {
  const { kind } = input;
  const access = await loadMain(db, a, boardId);
  assertBoard(access, 'board.manage_permissions');
  const column = await findColumnByKey(db, boardId, key);
  if (!column) throw new AppError('not_found', 'Column not found');
  if (column.type === 'name' && kind === 'view') throw new AppError('bad_request', 'The name column is always visible');
  const users = [...new Set(input.users)];
  const teams = [...new Set(input.teams)];
  if (users.length && !(await isAccountMember(db, a.ctx.accountId, users))) {
    throw new AppError('invalid_value', 'Unknown member');
  }
  for (const id of teams) {
    if (!(await findTeam(db, a.ctx.accountId, id))) throw new AppError('invalid_value', 'Unknown team');
  }
  const list = { users, teams };
  await db.transaction(async (tx) => {
    // view wins over edit (who cannot see cannot edit), so one of them at a time.
    await updateColumnRow(tx, column.id, {
      restrictedEdit: kind === 'edit' ? list : null,
      restrictedView: kind === 'view' ? list : null,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'column.restricted',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      columnId: column.id,
      before: { edit: column.restrictedEdit, view: column.restrictedView },
      after: { kind, ...(kind ? list : {}) },
    });
  });
  // Hidden or shown again: computed item names never carry a hidden column (audit 2026-10-10 follow-up).
  if (!!column.restrictedView !== (kind === 'view'))
    await recomputeNamesAfterRestriction(
      db,
      { accountId: a.ctx.accountId, actorId: a.user.id, requestId: a.requestId },
      boardId,
    );
  return getPermissions(db, a, boardId);
};
