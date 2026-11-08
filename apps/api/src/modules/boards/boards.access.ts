// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type BoardAction,
  type BoardPermissionContext,
  boardCapabilities,
  canBoard,
  effectiveBoardRole,
  rankBetween,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { RestrictionList } from '../../db/schema';
import type { AccountContext, SessionUser } from '../../types';
import { getAccountSettings } from '../accounts/accounts.repo';
import {
  type BoardRow,
  boardMembershipsOf,
  boardsByIds,
  findBoard,
  findBoardMembership,
  findWorkspace,
  listWorkspaces,
  templateEditOf,
  userTeamIds,
  type WorkspaceRow,
  workspaceIdsWithMember,
} from './boards.repo';

export type BoardAccess = {
  board: BoardRow;
  workspace: WorkspaceRow;
  perm: BoardPermissionContext;
  userId: string;
  /** Teams the user is in — they count as the user in column restrictions and assignments. */
  teamIds: string[];
};

/** Open workspaces are visible to every non-guest; closed ones to admins and members (05 §3). */
export const workspaceVisibleTo = (workspace: WorkspaceRow, ctx: AccountContext, memberOf: string[]) =>
  ctx.role === 'guest' || // guests are filtered at board level (shareable + subscribed)
  ctx.role === 'admin' ||
  workspace.kind === 'open' ||
  memberOf.includes(workspace.id);

export const permissionContext = (
  ctx: AccountContext,
  board: BoardRow,
  workspaceVisible: boolean,
  membership: BoardPermissionContext['membership'],
): BoardPermissionContext => ({
  accountRole: ctx.role,
  workspaceVisible,
  board: { kind: board.kind, permissionSet: board.permissionSet },
  membership,
});

/**
 * Loads a board the actor can at least read; anything else is a 404 so ids of hidden boards don't leak.
 * A sub-board (D14) has no rights of its own: kind, permission set, subscribers and workspace are its parent's.
 */
export const loadBoardAccess = async (
  db: Db,
  ctx: AccountContext,
  user: SessionUser,
  boardId: string,
): Promise<BoardAccess> => {
  const own = await findBoard(db, ctx.accountId, boardId);
  if (!own) throw new AppError('not_found', 'Board not found');
  // A token limited to some boards: the rest do not exist for it (06 §1.2).
  if (!withinLimit(ctx, own)) throw new AppError('not_found', 'Board not found');
  const parent = own.parentBoardId ? await findBoard(db, ctx.accountId, own.parentBoardId) : own;
  if (!parent) throw new AppError('not_found', 'Board not found');
  const [workspace, membership, memberOf, teamIds] = await Promise.all([
    findWorkspace(db, ctx.accountId, parent.workspaceId),
    findBoardMembership(db, ctx.accountId, parent.id, user.id),
    workspaceIdsWithMember(db, ctx.accountId, user.id),
    userTeamIds(db, ctx.accountId, user.id),
  ]);
  if (!workspace) throw new AppError('not_found', 'Board not found');
  const perm = permissionContext(
    ctx,
    parent,
    workspaceVisibleTo(workspace, ctx, memberOf),
    membership ? { role: membership.role, level: membership.level } : null,
  );
  if (!canBoard(perm, 'board.read').ok) throw new AppError('not_found', 'Board not found');
  if (ctx.role === 'guest') perm.guestStructure = await guestsEditStructure(db, ctx.accountId);
  const board = own === parent ? own : { ...own, kind: parent.kind, permissionSet: parent.permissionSet };
  return { board, workspace, perm, userId: user.id, teamIds };
};

/** The account's "guests change board structure" switch (off unless an admin turns it on). */
const guestsEditStructure = async (db: Db, accountId: string) => {
  const settings = (await getAccountSettings(db, accountId)) as { permissions?: { guests_edit_structure?: unknown } };
  return settings.permissions?.guests_edit_structure === true;
};

export const assertBoard = (access: BoardAccess, action: BoardAction) => {
  const decision = canBoard(access.perm, action);
  if (!decision.ok) {
    throw decision.as404 ? new AppError('not_found', 'Not found') : new AppError('forbidden', decision.reason);
  }
};

export const capabilitiesOf = (access: BoardAccess) => boardCapabilities(access.perm);

/**
 * Admin, or an owner the way `canBoard` counts one (`effectiveBoardRole`): a guest or an account viewer saved as a
 * board owner (05 §2: they never own a board) is not one — before such a guest passed every column edit
 * restriction (a "only these people edit" secret column included), bulk edit and conversions here while `canBoard`
 * already treated them as a plain subscriber.
 */
export const isOwnerOrAdmin = (access: BoardAccess) =>
  access.perm.accountRole === 'admin' || effectiveBoardRole(access.perm) === 'owner';

/**
 * Column restriction (05 §6.1): no list = everyone; else board owners and admins, the listed people and the
 * members of the listed teams.
 */
export const columnAllowed = (access: BoardAccess, list: RestrictionList | null) =>
  !list ||
  isOwnerOrAdmin(access) ||
  list.users.includes(access.userId) ||
  list.teams.some((t) => access.teamIds.includes(t));

/**
 * `rankBetween` that survives two neighbours with the same key (older concurrent appends, audit 2026-10-10 C5):
 * instead of throwing — which answered 500 to every drop between the tied pair — the new key lands right after
 * `before`, so the row sorts after both (the board order breaks the tie by id).
 */
export const rankBetweenOrAfter = (before: string | null, after: string | null) =>
  before !== null && after !== null && before >= after ? rankBetween(before, null) : rankBetween(before, after);

/**
 * Resolves `{after_id} | {before_id} | 'top' | 'bottom'` to a lexorank among ordered siblings (07 §3).
 * `siblings` must be sorted by position.
 */
export const positionAmong = (
  siblings: { id: string; position: string }[],
  position: { after_id: string } | { before_id: string } | 'top' | 'bottom' | undefined,
): string => {
  if (!siblings.length) return rankBetween(null, null);
  if (position === 'top') return rankBetween(null, siblings[0]!.position);
  if (!position || position === 'bottom') return rankBetween(siblings[siblings.length - 1]!.position, null);
  const anchorId = 'after_id' in position ? position.after_id : position.before_id;
  const i = siblings.findIndex((s) => s.id === anchorId);
  if (i < 0) throw new AppError('bad_request', 'Unknown position anchor');
  return 'after_id' in position
    ? rankBetweenOrAfter(siblings[i]!.position, siblings[i + 1]?.position ?? null)
    : rankBetweenOrAfter(siblings[i - 1]?.position ?? null, siblings[i]!.position);
};

/** An API token's board limit (`ctx.boardLimit`): a board, or a sub-board of one, on its list. */
export const withinLimit = (ctx: AccountContext, b: { id: string; parentBoardId: string | null }) =>
  !ctx.boardLimit || ctx.boardLimit.includes(b.parentBoardId ?? b.id);

/**
 * Of `boardIds`, those whose items the actor may read — for lists across boards (search, My Work, favourites,
 * inbox …). A template's working board (fix3) is never among them: it opens from the templates page only.
 */
export const readableBoardIds = async (
  db: Db,
  ctx: AccountContext,
  user: SessionUser,
  boardIds: string[],
): Promise<Set<string>> => {
  if (!boardIds.length) return new Set();
  const [found, memberships, memberOf, workspaces] = await Promise.all([
    boardsByIds(db, ctx.accountId, [...new Set(boardIds)]),
    boardMembershipsOf(db, ctx.accountId, user.id),
    workspaceIdsWithMember(db, ctx.accountId, user.id),
    listWorkspaces(db, ctx.accountId),
  ]);
  // Sub-boards are readable when their parent is (D14).
  const parentIds = [...new Set(found.flatMap((b) => (b.parentBoardId ? [b.parentBoardId] : [])))];
  const parents = new Map(
    (parentIds.length ? await boardsByIds(db, ctx.accountId, parentIds) : []).map((b) => [b.id, b]),
  );
  const membershipOf = new Map(memberships.map((m) => [m.boardId, m]));
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const readable = (b: BoardRow) => {
    const ws = wsById.get(b.workspaceId);
    if (!ws) return false;
    const perm = permissionContext(ctx, b, workspaceVisibleTo(ws, ctx, memberOf), membershipOf.get(b.id) ?? null);
    return canBoard(perm, 'item.read').ok;
  };
  return new Set(
    found
      .filter((b) => {
        if (!withinLimit(ctx, b) || templateEditOf(b)) return false;
        if (!b.parentBoardId) return readable(b);
        const parent = parents.get(b.parentBoardId);
        return !!parent && !templateEditOf(parent) && readable(parent);
      })
      .map((b) => b.id),
  );
};
