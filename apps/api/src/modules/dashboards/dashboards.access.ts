// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type BoardKind,
  canDashboard,
  type DashboardAction,
  type DashboardPermissionContext,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { AccountContext, SessionUser } from '../../types';
import { findWorkspace, listWorkspaces, type WorkspaceRow, workspaceIdsWithMember } from '../boards/boards.repo';
import { workspaceVisibleTo } from '../boards/boards.access';
import { dashboardLevelsOf, type DashboardRow, findDashboard } from './dashboards.repo';

export type DashboardAccess = {
  dashboard: DashboardRow;
  workspace: WorkspaceRow;
  perm: DashboardPermissionContext;
  userId: string;
};

const permOf = (
  ctx: AccountContext,
  d: { kind: BoardKind },
  workspaceVisible: boolean,
  level: DashboardPermissionContext['level'],
): DashboardPermissionContext => ({ accountRole: ctx.role, workspaceVisible, dashboard: { kind: d.kind }, level });

/**
 * A dashboard the actor may at least see; anything else (another account's, a private one they are not invited
 * to, one in trash, for a guest any but a shareable one shared with them, any for a board-limited token) is a
 * 404 — ids do not leak.
 */
export const loadDashboardAccess = async (
  db: Db,
  ctx: AccountContext,
  user: SessionUser,
  id: string,
): Promise<DashboardAccess> => {
  const notFound = () => new AppError('not_found', 'Dashboard not found');
  const dashboard = await findDashboard(db, ctx.accountId, id);
  if (!dashboard || ctx.boardLimit) throw notFound();
  const [workspace, memberOf, levels] = await Promise.all([
    findWorkspace(db, ctx.accountId, dashboard.workspaceId),
    workspaceIdsWithMember(db, ctx.accountId, user.id),
    dashboardLevelsOf(db, ctx.accountId, user.id, [dashboard.id]),
  ]);
  if (!workspace) throw notFound();
  const perm = permOf(ctx, dashboard, workspaceVisibleTo(workspace, ctx, memberOf), levels.get(dashboard.id) ?? null);
  if (!canDashboard(perm, 'dashboard.read').ok) throw notFound();
  return { dashboard, workspace, perm, userId: user.id };
};

export const assertDashboard = (access: DashboardAccess, action: DashboardAction) => {
  const d = canDashboard(access.perm, action);
  if (!d.ok) throw d.as404 ? new AppError('not_found', 'Dashboard not found') : new AppError('forbidden', d.reason);
};

/** Of these dashboards, the ones the actor may see, with the permission context of each (sidebar). */
export const readableDashboards = async (db: Db, ctx: AccountContext, user: SessionUser, rows: DashboardRow[]) => {
  if (!rows.length || ctx.boardLimit) return [];
  const [levels, memberOf, workspaces] = await Promise.all([
    dashboardLevelsOf(
      db,
      ctx.accountId,
      user.id,
      rows.map((d) => d.id),
    ),
    workspaceIdsWithMember(db, ctx.accountId, user.id),
    listWorkspaces(db, ctx.accountId),
  ]);
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const out: { dashboard: DashboardRow; perm: DashboardPermissionContext }[] = [];
  for (const d of rows) {
    const ws = wsById.get(d.workspaceId);
    if (!ws) continue;
    const perm = permOf(ctx, d, workspaceVisibleTo(ws, ctx, memberOf), levels.get(d.id) ?? null);
    if (canDashboard(perm, 'dashboard.read').ok) out.push({ dashboard: d, perm });
  }
  return out;
};
