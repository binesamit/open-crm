// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { type DashboardLevel, higherDashboardLevel } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  activityLog,
  dashboardMembers,
  dashboards,
  dashboardWidgets,
  teamMembers,
  teams,
  users,
} from '../../db/schema';

export type DashboardRow = typeof dashboards.$inferSelect;
export type WidgetRow = typeof dashboardWidgets.$inferSelect;

/** A live dashboard of the account (not in trash). */
export const findDashboard = async (db: Db, accountId: string, id: string): Promise<DashboardRow | undefined> =>
  (
    await db
      .select()
      .from(dashboards)
      .where(and(eq(dashboards.accountId, accountId), eq(dashboards.id, id), isNull(dashboards.deletedAt)))
      .limit(1)
  )[0];

/** In or out of trash (restore). */
export const anyDashboard = async (db: Db, id: string): Promise<DashboardRow | undefined> =>
  (await db.select().from(dashboards).where(eq(dashboards.id, id)).limit(1))[0];

/** Live dashboards of the account by id (favourites, Fix: ). */
export const dashboardsByIds = (db: Db, accountId: string, ids: string[]): Promise<DashboardRow[]> =>
  ids.length
    ? db
        .select()
        .from(dashboards)
        .where(and(eq(dashboards.accountId, accountId), inArray(dashboards.id, ids), isNull(dashboards.deletedAt)))
    : Promise.resolve([]);

export const listDashboardsInWorkspace = (db: Db, accountId: string, workspaceId: string) =>
  db
    .select()
    .from(dashboards)
    .where(
      and(eq(dashboards.accountId, accountId), eq(dashboards.workspaceId, workspaceId), isNull(dashboards.deletedAt)),
    )
    .orderBy(asc(dashboards.position));

export const countDashboardsInWorkspace = async (db: Db, workspaceId: string) =>
  (
    await db
      .select({ id: dashboards.id })
      .from(dashboards)
      .where(and(eq(dashboards.workspaceId, workspaceId), isNull(dashboards.deletedAt)))
      .limit(1)
  ).length;

export const lastDashboardPosition = async (db: Db, workspaceId: string, folderId: string | null) =>
  (
    await db
      .select({ p: dashboards.position })
      .from(dashboards)
      .where(
        and(
          eq(dashboards.workspaceId, workspaceId),
          folderId ? eq(dashboards.folderId, folderId) : isNull(dashboards.folderId),
          isNull(dashboards.deletedAt),
        ),
      )
      .orderBy(desc(dashboards.position))
      .limit(1)
  )[0]?.p ?? null;

export const insertDashboard = (db: Db, row: typeof dashboards.$inferInsert) => db.insert(dashboards).values(row);

export const updateDashboardRow = (db: Db, id: string, patch: Partial<typeof dashboards.$inferInsert>) =>
  db
    .update(dashboards)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(dashboards.id, id));

/** Dashboards of these folders go to the workspace root (the folder went to trash); returns what moved. */
export const moveDashboardsToRoot = (db: Db, folderIds: string[]) =>
  folderIds.length
    ? db
        .update(dashboards)
        .set({ folderId: null, updatedAt: new Date() })
        .where(and(inArray(dashboards.folderId, folderIds), isNull(dashboards.deletedAt)))
        .returning({ id: dashboards.id, folderId: dashboards.folderId })
    : Promise.resolve([]);

export const dashboardsInFolders = (db: Db, folderIds: string[]) =>
  folderIds.length
    ? db
        .select({ id: dashboards.id, folderId: dashboards.folderId })
        .from(dashboards)
        .where(and(inArray(dashboards.folderId, folderIds), isNull(dashboards.deletedAt)))
    : Promise.resolve([]);

/** Dashboards of these folders follow them to another workspace. */
export const moveDashboardsOfFolders = (db: Db, accountId: string, folderIds: string[], workspaceId: string) =>
  folderIds.length
    ? db
        .update(dashboards)
        .set({ workspaceId, updatedAt: new Date() })
        .where(and(eq(dashboards.accountId, accountId), inArray(dashboards.folderId, folderIds)))
    : Promise.resolve();

export const returnDashboardsToFolder = (db: Db, ids: string[], folderId: string) =>
  ids.length
    ? db
        .update(dashboards)
        .set({ folderId, updatedAt: new Date() })
        .where(and(inArray(dashboards.id, ids), isNull(dashboards.folderId), isNull(dashboards.deletedAt)))
    : Promise.resolve();

// ---- members ----
/** Dashboard → the actor's highest level, personally or through a team. */
export const dashboardLevelsOf = async (
  db: Db,
  accountId: string,
  userId: string,
  ids: string[],
): Promise<Map<string, DashboardLevel>> => {
  if (!ids.length) return new Map();
  const rows = await db
    .select({ id: dashboardMembers.dashboardId, level: dashboardMembers.level })
    .from(dashboardMembers)
    .leftJoin(teamMembers, and(eq(teamMembers.teamId, dashboardMembers.teamId), eq(teamMembers.userId, userId)))
    .leftJoin(teams, eq(teams.id, dashboardMembers.teamId))
    .where(
      and(
        eq(dashboardMembers.accountId, accountId),
        or(eq(dashboardMembers.userId, userId), and(isNotNull(teamMembers.userId), isNull(teams.deletedAt))),
        inArray(dashboardMembers.dashboardId, ids),
      ),
    );
  const out = new Map<string, DashboardLevel>();
  for (const r of rows) out.set(r.id, higherDashboardLevel(out.get(r.id) ?? null, r.level)!);
  return out;
};

export const listDashboardMembers = (db: Db, dashboardId: string) =>
  db
    .select({
      userId: dashboardMembers.userId,
      teamId: dashboardMembers.teamId,
      level: dashboardMembers.level,
      userName: users.name,
      email: users.email,
      teamName: teams.name,
    })
    .from(dashboardMembers)
    .leftJoin(users, eq(users.id, dashboardMembers.userId))
    .leftJoin(teams, eq(teams.id, dashboardMembers.teamId))
    .where(eq(dashboardMembers.dashboardId, dashboardId))
    .orderBy(asc(dashboardMembers.createdAt));

export const replaceDashboardMembers = async (
  db: Db,
  dashboardId: string,
  rows: (typeof dashboardMembers.$inferInsert)[],
) => {
  await db.delete(dashboardMembers).where(eq(dashboardMembers.dashboardId, dashboardId));
  if (rows.length) await db.insert(dashboardMembers).values(rows);
};

export const insertDashboardMembers = (db: Db, rows: (typeof dashboardMembers.$inferInsert)[]) =>
  rows.length ? db.insert(dashboardMembers).values(rows).onConflictDoNothing() : Promise.resolve();

// ---- widgets ----
export const listWidgets = (db: Db, dashboardId: string) =>
  db
    .select()
    .from(dashboardWidgets)
    .where(and(eq(dashboardWidgets.dashboardId, dashboardId), isNull(dashboardWidgets.deletedAt)))
    .orderBy(asc(dashboardWidgets.createdAt), asc(dashboardWidgets.id));

export const findWidget = async (db: Db, accountId: string, id: string, withDeleted = false) =>
  (
    await db
      .select()
      .from(dashboardWidgets)
      .where(
        and(
          eq(dashboardWidgets.accountId, accountId),
          eq(dashboardWidgets.id, id),
          withDeleted ? undefined : isNull(dashboardWidgets.deletedAt),
        ),
      )
      .limit(1)
  )[0];

export const insertWidgets = (db: Db, rows: (typeof dashboardWidgets.$inferInsert)[]) =>
  rows.length ? db.insert(dashboardWidgets).values(rows) : Promise.resolve();

export const updateWidgetRow = (db: Db, id: string, patch: Partial<typeof dashboardWidgets.$inferInsert>) =>
  db
    .update(dashboardWidgets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(dashboardWidgets.id, id));

/** The dashboard an activity event is about (live stream: `dashboard.*` events carry it in `meta`). */
export const eventDashboardId = async (db: Db, eventId: string) => {
  const row = (
    await db.select({ payload: activityLog.payload }).from(activityLog).where(eq(activityLog.id, eventId)).limit(1)
  )[0];
  const meta = (row?.payload as { meta?: { dashboard_id?: unknown } } | undefined)?.meta;
  return typeof meta?.dashboard_id === 'string' ? meta.dashboard_id : null;
};

/** Names of people and teams of the account (people columns hold both). */
export const principalNames = async (db: Db, accountId: string, ids: string[]) => {
  if (!ids.length) return new Map<string, string>();
  const [u, tm] = await Promise.all([
    db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)),
    db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(and(eq(teams.accountId, accountId), inArray(teams.id, ids))),
  ]);
  return new Map<string, string>([
    ...u.map((x) => [x.id, x.name || x.email] as const),
    ...tm.map((x) => [x.id, x.name] as const),
  ]);
};

export const userNames = async (db: Db, ids: string[]) =>
  new Map(
    (ids.length
      ? await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))
      : []
    ).map((u) => [u.id, u.name]),
  );
