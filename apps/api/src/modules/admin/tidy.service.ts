// SPDX-License-Identifier: AGPL-3.0-only
import { type AdminBoard, AppError, newId, type TransferBoard, transferBoardSchema } from '@bines/shared';
import type { Db } from '../../db/client';
import type { RequestMeta } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { archiveBoard } from '../archive/archive.service';
import { recordAudit } from '../audit/audit.repo';
import { loadBoardAccess } from '../boards/boards.access';
import { boardMembershipsOf, hasActiveOwner } from '../boards/boards.repo';
import { deleteBoard } from '../boards/boards.service';
import { demoteBoardOwner, findMemberWithUser, setBoardRole } from '../users/admin.repo';
import { boardOwners, boardOwnerTeams, currentBoardOwners, itemStatsByBoard, listAccountBoards } from './admin.repo';
import { type AdminActor } from './security.service';
import { assertAccountAdmin } from '../../lib/account-admin';

/**
 * Administration → סדר וניקיון (08 §9, account admin A5): every board of the account with its owners, last change
 * and items; archive, delete (to the trash) and transfer ownership. Private / shareable boards are metadata only —
 * the admin sees their name and owners, never their items (05 §10).
 */
export const listAdminBoards = async (db: Db, a: AdminActor): Promise<AdminBoard[]> => {
  assertAccountAdmin(a.ctx);
  const id = a.ctx.accountId;
  const [rows, stats, owners, teamOwners, mine] = await Promise.all([
    listAccountBoards(db, id),
    itemStatsByBoard(db, id),
    boardOwners(db, id),
    boardOwnerTeams(db, id),
    boardMembershipsOf(db, id, a.user.id),
  ]);
  const subscribed = new Set(mine.map((m) => m.boardId));
  // Owners by board, once (not a scan of every owner per board — accounts with thousands of boards).
  const byBoard = <T extends { boardId: string }>(list: T[]) => {
    const map = new Map<string, T[]>();
    for (const x of list) {
      const at = map.get(x.boardId);
      if (at) at.push(x);
      else map.set(x.boardId, [x]);
    }
    return map;
  };
  const ownersOf = byBoard(owners);
  const teamsOf = byBoard(teamOwners);
  const out: AdminBoard[] = [];
  for (const b of rows) {
    const people = (ownersOf.get(b.id) ?? []).map((o) => ({
      user_id: o.userId,
      name: o.name,
      active: o.status === 'active',
    }));
    const teams = (teamsOf.get(b.id) ?? []).map((t) => ({ team_id: t.teamId, name: t.name }));
    const active = people.some((p) => p.active) || (teams.length > 0 && (await hasActiveOwner(db, id, b.id)));
    const s = stats.get(b.id);
    const last = s?.last && s.last > b.updatedAt ? s.last : b.updatedAt;
    out.push({
      id: b.id,
      name: b.name,
      workspace_id: b.workspaceId,
      workspace_name: b.workspaceName,
      kind: b.kind,
      created_by_name: b.createdByName ?? null,
      owners: people,
      owner_teams: teams,
      has_active_owner: active,
      items_count: s?.count ?? 0,
      updated_at: last.toISOString(),
      archived_at: b.archivedAt?.toISOString() ?? null,
      content_access: b.kind === 'main' || subscribed.has(b.id),
    });
  }
  return out;
};

const audit = (db: Db, a: AdminActor, meta: RequestMeta, action: string, boardId: string, p: Record<string, unknown>) =>
  recordAudit(db, {
    accountId: a.ctx.accountId,
    actorId: a.user.id,
    action,
    targetType: 'board',
    targetId: boardId,
    payload: p,
    ip: meta.ip,
    userAgent: meta.userAgent,
  });

/** POST /admin/boards/:id/archive — the board service (permission + event), plus an audit row. */
export const archiveAdminBoard = async (db: Db, a: AdminActor, boardId: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  await archiveBoard(db, a, boardId);
  await audit(db, a, meta, 'board.archived', boardId, { name: access.board.name, via: 'tidy' });
  return { ok: true as const };
};

/** DELETE /admin/boards/:id — to the trash (30 days), plus an audit row. */
export const deleteAdminBoard = async (db: Db, a: AdminActor, boardId: string, meta: RequestMeta) => {
  assertAccountAdmin(a.ctx);
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  await deleteBoard(db, a, boardId);
  await audit(db, a, meta, 'board.deleted', boardId, { name: access.board.name, via: 'tidy' });
  return { ok: true as const };
};

/**
 * POST /admin/boards/:id/transfer-ownership — the chosen active member / admin becomes an owner; today's owners
 * become subscribers unless kept. One batch of `board.members_changed` events and an audit row.
 */
export const transferAdminBoard = async (
  db: Db,
  a: AdminActor,
  boardId: string,
  raw: TransferBoard,
  meta: RequestMeta,
) => {
  assertAccountAdmin(a.ctx);
  const input = transferBoardSchema.parse(raw);
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  const to = await findMemberWithUser(db, a.ctx.accountId, input.to_user_id);
  if (!to || to.membership.status !== 'active') throw new AppError('invalid_value', 'transfer_target_inactive');
  if (to.membership.role !== 'admin' && to.membership.role !== 'member')
    throw new AppError('invalid_value', 'transfer_target_role');
  const before = (await currentBoardOwners(db, a.ctx.accountId, boardId)).map((o) => o.userId);
  const batchId = newId();
  await db.transaction(async (tx) => {
    await setBoardRole(tx, a.ctx.accountId, boardId, input.to_user_id, 'owner', a.user.id);
    const demoted = input.keep_current_owners ? [] : before.filter((u) => u !== input.to_user_id);
    for (const u of demoted) await demoteBoardOwner(tx, a.ctx.accountId, boardId, u);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.members_changed',
      actorId: a.user.id,
      requestId: a.requestId ?? meta.requestId,
      boardId,
      batchId,
      before: { owners: before },
      after: {
        owners: [...new Set([...before.filter((u) => !demoted.includes(u)), input.to_user_id])],
      },
      meta: { via: 'tidy_transfer', to_user_id: input.to_user_id },
    });
    await audit(tx, a, meta, 'board.ownership_transferred', boardId, {
      name: access.board.name,
      from_user_ids: before,
      to_user_id: input.to_user_id,
      kept: input.keep_current_owners,
    });
  });
  return (await listAdminBoards(db, a)).find((b) => b.id === boardId)!;
};
