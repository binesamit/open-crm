// SPDX-License-Identifier: AGPL-3.0-only
import type { AccountRole } from './account';
import type { BoardKind } from './board';

/**
 * Dashboard permissions (M8 ד4, D25; "like boards"): any member (not an account viewer, not a guest)
 * creates dashboards; a `main` dashboard is seen by everyone in its workspace, a `private` one only by the people /
 * teams invited, a `shareable` one likewise — and guests may be invited to it (like a shareable board). An
 * invitation is `owner` (edits, shares, deletes), `editor` (edits widgets, layout, sources and filter) or `viewer`.
 * A guest never owns one (at most an editor). What a widget shows is still filtered per viewer by the boards' own
 * rules — seeing a dashboard never shows an item (or a board) one may not see.
 */
export const DASHBOARD_LEVELS = ['owner', 'editor', 'viewer'] as const;
export type DashboardLevel = (typeof DASHBOARD_LEVELS)[number];
export const DASHBOARD_KINDS = ['main', 'private', 'shareable'] as const;
export type DashboardKind = (typeof DASHBOARD_KINDS)[number];

export const DASHBOARD_ACTIONS = ['dashboard.read', 'dashboard.edit', 'dashboard.manage'] as const;
export type DashboardAction = (typeof DASHBOARD_ACTIONS)[number];

export type DashboardPermissionContext = {
  accountRole: AccountRole;
  /** The dashboard's workspace is visible to the actor (open, or a member of a closed one). */
  workspaceVisible: boolean;
  dashboard: { kind: BoardKind };
  /** The highest level the actor holds (personally or through a team); null = not invited. */
  level: DashboardLevel | null;
};

export type DashboardDecision = { ok: true; via: string } | { ok: false; reason: string; as404?: boolean };

const LEVEL_ACTIONS: Record<DashboardLevel, DashboardAction[]> = {
  owner: ['dashboard.read', 'dashboard.edit', 'dashboard.manage'],
  editor: ['dashboard.read', 'dashboard.edit'],
  viewer: ['dashboard.read'],
};

export const higherDashboardLevel = (a: DashboardLevel | null, b: DashboardLevel | null): DashboardLevel | null =>
  a === null ? b : b === null ? a : DASHBOARD_LEVELS.indexOf(a) <= DASHBOARD_LEVELS.indexOf(b) ? a : b;

/** The level that applies, or null when the dashboard is not seen at all (a 404). */
export const effectiveDashboardLevel = (ctx: DashboardPermissionContext): DashboardLevel | null => {
  // Guests: only a shareable dashboard they are invited to, never as its owner (like a shareable board / doc).
  if (ctx.accountRole === 'guest') {
    if (ctx.dashboard.kind !== 'shareable' || !ctx.level) return null;
    return ctx.level === 'owner' ? 'editor' : ctx.level;
  }
  if (ctx.accountRole === 'admin') return 'owner';
  if (!ctx.workspaceVisible) return null;
  const level = ctx.level ?? (ctx.dashboard.kind === 'main' ? 'viewer' : null);
  if (!level) return null;
  // Strictest wins: account viewers only look.
  return ctx.accountRole === 'viewer' ? 'viewer' : level;
};

export const canDashboard = (ctx: DashboardPermissionContext, action: DashboardAction): DashboardDecision => {
  const level = effectiveDashboardLevel(ctx);
  if (!level) return { ok: false, reason: 'dashboard_access', as404: true };
  return LEVEL_ACTIONS[level].includes(action) ? { ok: true, via: level } : { ok: false, reason: 'dashboard_level' };
};

export const dashboardCapabilities = (ctx: DashboardPermissionContext): Record<DashboardAction, boolean> =>
  Object.fromEntries(DASHBOARD_ACTIONS.map((a) => [a, canDashboard(ctx, a).ok])) as Record<DashboardAction, boolean>;

/** Who may create a dashboard (D25): members and admins of the account. */
export const canCreateDashboard = (role: AccountRole) => role === 'admin' || role === 'member';
