// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq, gt, gte, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  accountMembers,
  accounts,
  apiTokens,
  assets,
  auditLog,
  authSessions,
  automationRuns,
  automations,
  boardMembers,
  boards,
  boardTeamMembers,
  items,
  teams,
  users,
  webhookDeliveries,
  workspaces,
} from '../../db/schema';

/** Administration A4 + A5 (08 §5, §8, §9, §11): the queries behind security, audit, usage and tidy up. */

// ---- sessions ----

/** Live sign-ins of the account's active people (service identities never sign in). */
export const listMemberSessions = (db: Db, accountId: string, now = new Date()) =>
  db
    .select({
      id: authSessions.id,
      userId: authSessions.userId,
      name: users.name,
      email: users.email,
      isPlatformOwner: users.isPlatformOwner,
      ip: authSessions.ipAddress,
      userAgent: authSessions.userAgent,
      createdAt: authSessions.createdAt,
      updatedAt: authSessions.updatedAt,
      expiresAt: authSessions.expiresAt,
    })
    .from(authSessions)
    .innerJoin(
      accountMembers,
      and(
        eq(accountMembers.userId, authSessions.userId),
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.status, 'active'),
      ),
    )
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(and(eq(users.isService, false), gt(authSessions.expiresAt, now)))
    .orderBy(desc(authSessions.updatedAt));

/** Of these people, those with an active membership in another live account. */
export const usersActiveElsewhere = async (db: Db, accountId: string, userIds: string[]) => {
  if (!userIds.length) return new Set<string>();
  const rows = await db
    .selectDistinct({ userId: accountMembers.userId })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .where(
      and(
        inArray(accountMembers.userId, userIds),
        ne(accountMembers.accountId, accountId),
        eq(accountMembers.status, 'active'),
        isNull(accounts.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.userId));
};

/** Of `userIds`, who is an active admin of another live account (S-15: their sign-ins are not this account's call). */
export const adminsElsewhere = async (db: Db, accountId: string, userIds: string[]) => {
  if (!userIds.length) return new Set<string>();
  const rows = await db
    .selectDistinct({ userId: accountMembers.userId })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .where(
      and(
        inArray(accountMembers.userId, userIds),
        ne(accountMembers.accountId, accountId),
        eq(accountMembers.status, 'active'),
        eq(accountMembers.role, 'admin'),
        isNull(accounts.deletedAt),
      ),
    );
  return new Set(rows.map((r) => r.userId));
};

export const deleteSessions = (db: Db, ids: string[]) =>
  ids.length
    ? db.delete(authSessions).where(inArray(authSessions.id, ids)).returning({ id: authSessions.id })
    : Promise.resolve([]);

// ---- audit log ----
export type AuditFilter = { actorId?: string; event?: string; from?: Date; to?: Date };

const auditWhere = (accountId: string, f: AuditFilter) =>
  and(
    eq(auditLog.accountId, accountId),
    f.actorId ? eq(auditLog.actorId, f.actorId) : undefined,
    f.event ? eq(auditLog.action, f.event) : undefined,
    f.from ? gte(auditLog.createdAt, f.from) : undefined,
    f.to ? lt(auditLog.createdAt, f.to) : undefined,
  );

export const listAudit = (db: Db, accountId: string, f: AuditFilter, limit: number, offset: number) =>
  db
    .select({ row: auditLog, actorName: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorId))
    .where(auditWhere(accountId, f))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit)
    .offset(offset);

export const countAudit = async (db: Db, accountId: string, f: AuditFilter) =>
  Number((await db.select({ n: count() }).from(auditLog).where(auditWhere(accountId, f)))[0]?.n ?? 0);

export const auditEventTypes = async (db: Db, accountId: string) =>
  (
    await db
      .selectDistinct({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.accountId, accountId))
      .orderBy(auditLog.action)
  ).map((r) => r.action);

export const userNames = async (db: Db, ids: string[]) => {
  if (!ids.length) return new Map<string, string>();
  const rows = await db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
};

export const boardNames = async (db: Db, accountId: string, ids: string[]) => {
  if (!ids.length) return new Map<string, string>();
  const rows = await db
    .select({ id: boards.id, name: boards.name })
    .from(boards)
    .where(and(eq(boards.accountId, accountId), inArray(boards.id, ids)));
  return new Map(rows.map((r) => [r.id, r.name]));
};

// ---- usage ----
const n = (v: unknown) => Number(v ?? 0);

export const automationRunStats = async (db: Db, accountId: string, from: Date) => {
  const [row] = await db
    .select({
      runs: sql<number>`count(*) filter (where ${automationRuns.status} <> 'skipped')`,
      failures: sql<number>`count(*) filter (where ${automationRuns.status} = 'failed')`,
    })
    .from(automationRuns)
    .where(and(eq(automationRuns.accountId, accountId), gte(automationRuns.createdAt, from)));
  return { runs: n(row?.runs), failures: n(row?.failures) };
};

export const webhookStats = async (db: Db, accountId: string, from: Date) => {
  const [row] = await db
    .select({
      total: count(),
      failures: sql<number>`count(*) filter (where ${webhookDeliveries.status} in ('failed','dead'))`,
    })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.accountId, accountId), gte(webhookDeliveries.createdAt, from)));
  return { total: n(row?.total), failures: n(row?.failures) };
};

/** Runs (not skipped) and deliveries per UTC day since `from`. */
export const dailyCounts = async (db: Db, accountId: string, from: Date) => {
  const runDay = sql<string>`to_char(${automationRuns.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const runs = await db
    .select({ day: runDay, n: count() })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.accountId, accountId),
        gte(automationRuns.createdAt, from),
        ne(automationRuns.status, 'skipped'),
      ),
    )
    .groupBy(runDay);
  const hookDay = sql<string>`to_char(${webhookDeliveries.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
  const hooks = await db
    .select({ day: hookDay, n: count() })
    .from(webhookDeliveries)
    .where(and(eq(webhookDeliveries.accountId, accountId), gte(webhookDeliveries.createdAt, from)))
    .groupBy(hookDay);
  return {
    runs: new Map(runs.map((r) => [r.day, n(r.n)])),
    hooks: new Map(hooks.map((r) => [r.day, n(r.n)])),
  };
};

export const storageStats = async (db: Db, accountId: string) => {
  const [row] = await db
    .select({ bytes: sql<number>`coalesce(sum(${assets.size}), 0)`, files: count() })
    .from(assets)
    .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt), eq(assets.uploadStatus, 'uploaded')));
  return { bytes: n(row?.bytes), files: n(row?.files) };
};

export const itemsTotal = async (db: Db, accountId: string) =>
  n(
    (
      await db
        .select({ n: count() })
        .from(items)
        .where(and(eq(items.accountId, accountId), isNull(items.deletedAt)))
    )[0]?.n,
  );

export const boardsTotal = async (db: Db, accountId: string) =>
  n(
    (
      await db
        .select({ n: count() })
        .from(boards)
        .where(and(eq(boards.accountId, accountId), isNull(boards.deletedAt), isNull(boards.parentBoardId)))
    )[0]?.n,
  );

/** Active people of the account (not services) and how many were seen since `from` (session activity / last seen). */
export const memberActivity = async (db: Db, accountId: string, from: Date) => {
  const people = await db
    .select({ id: users.id, lastSeen: users.lastSeenAt })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(
      and(eq(accountMembers.accountId, accountId), eq(accountMembers.status, 'active'), eq(users.isService, false)),
    );
  const ids = people.map((p) => p.id);
  const recent = ids.length
    ? await db
        .selectDistinct({ userId: authSessions.userId })
        .from(authSessions)
        .where(and(inArray(authSessions.userId, ids), gte(authSessions.updatedAt, from)))
    : [];
  const active = new Set(recent.map((r) => r.userId));
  for (const p of people) if (p.lastSeen && p.lastSeen >= from) active.add(p.id);
  return { total: people.length, active: active.size };
};

export const topAutomations = (db: Db, accountId: string, from: Date, limit = 10) => {
  const runs = sql<number>`count(${automationRuns.id}) filter (where ${automationRuns.status} <> 'skipped')`;
  return db
    .select({
      id: automations.id,
      title: automations.title,
      boardId: automations.boardId,
      boardName: boards.name,
      isActive: automations.isActive,
      lastRunAt: automations.lastRunAt,
      runs,
      failures: sql<number>`count(${automationRuns.id}) filter (where ${automationRuns.status} = 'failed')`,
    })
    .from(automations)
    .innerJoin(
      automationRuns,
      and(eq(automationRuns.automationId, automations.id), gte(automationRuns.createdAt, from)),
    )
    .leftJoin(boards, eq(boards.id, automations.boardId))
    .where(and(eq(automations.accountId, accountId), isNull(automations.deletedAt)))
    .groupBy(automations.id, boards.name)
    .having(sql`${runs} > 0`)
    .orderBy(desc(runs))
    .limit(limit);
};

/** Live tokens by their last use (there is no per-request counter). */
export const recentTokens = (db: Db, accountId: string, limit = 10) =>
  db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      prefix: apiTokens.tokenPrefix,
      userName: users.name,
      lastUsedAt: apiTokens.lastUsedAt,
    })
    .from(apiTokens)
    .leftJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.accountId, accountId),
        isNull(apiTokens.revokedAt),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())),
        isNotNull(apiTokens.lastUsedAt),
      ),
    )
    .orderBy(desc(apiTokens.lastUsedAt))
    .limit(limit);

export const tokensUsedSince = async (db: Db, accountId: string, from: Date) =>
  n(
    (
      await db
        .select({ n: count() })
        .from(apiTokens)
        .where(and(eq(apiTokens.accountId, accountId), gte(apiTokens.lastUsedAt, from)))
    )[0]?.n,
  );

// ---- tidy up ----

/** Every top-level board of the account (archived too; not deleted, not a template's working board). */
export const listAccountBoards = (db: Db, accountId: string) =>
  db
    .select({
      id: boards.id,
      name: boards.name,
      kind: boards.kind,
      workspaceId: boards.workspaceId,
      workspaceName: workspaces.name,
      createdByName: users.name,
      updatedAt: boards.updatedAt,
      archivedAt: boards.archivedAt,
    })
    .from(boards)
    .innerJoin(workspaces, and(eq(workspaces.id, boards.workspaceId), isNull(workspaces.deletedAt)))
    .leftJoin(users, eq(users.id, boards.createdBy))
    .where(
      and(
        eq(boards.accountId, accountId),
        isNull(boards.deletedAt),
        isNull(boards.parentBoardId),
        sql`not (${boards.settings} ? 'template_edit')`,
      ),
    )
    .orderBy(boards.name);

/** Live, not archived items per board and the newest item change. */
export const itemStatsByBoard = async (db: Db, accountId: string) => {
  const rows = await db
    .select({
      boardId: items.boardId,
      n: sql<number>`count(*) filter (where ${items.archivedAt} is null)`,
      last: sql<
        string | null
      >`max(greatest(${items.updatedAt}, coalesce(${items.lastCellChangeAt}, ${items.updatedAt})))`,
    })
    .from(items)
    .where(and(eq(items.accountId, accountId), isNull(items.deletedAt)))
    .groupBy(items.boardId);
  return new Map(rows.map((r) => [r.boardId, { count: n(r.n), last: r.last ? new Date(r.last) : null }]));
};

export const boardOwners = (db: Db, accountId: string) =>
  db
    .select({
      boardId: boardMembers.boardId,
      userId: boardMembers.userId,
      name: users.name,
      status: accountMembers.status,
    })
    .from(boardMembers)
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .leftJoin(
      accountMembers,
      and(eq(accountMembers.userId, boardMembers.userId), eq(accountMembers.accountId, accountId)),
    )
    .where(and(eq(boardMembers.accountId, accountId), eq(boardMembers.role, 'owner')));

export const boardOwnerTeams = (db: Db, accountId: string) =>
  db
    .select({ boardId: boardTeamMembers.boardId, teamId: teams.id, name: teams.name })
    .from(boardTeamMembers)
    .innerJoin(teams, and(eq(teams.id, boardTeamMembers.teamId), isNull(teams.deletedAt)))
    .where(and(eq(boardTeamMembers.accountId, accountId), eq(boardTeamMembers.role, 'owner')));

export const currentBoardOwners = (db: Db, accountId: string, boardId: string) =>
  db
    .select({ userId: boardMembers.userId })
    .from(boardMembers)
    .where(
      and(eq(boardMembers.accountId, accountId), eq(boardMembers.boardId, boardId), eq(boardMembers.role, 'owner')),
    );
