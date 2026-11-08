// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, gt, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import { AppError, SERVICE_TOKEN_PREFIX } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  accountInvitations,
  accountMembers,
  accounts,
  apiTokens,
  authIdentities,
  authSessions,
  automations,
  boardMembers,
  cells,
  columns,
  supportAccessGrants,
  supportStaff,
  teamMembers,
  teams,
  users,
  webhooks,
} from '../../db/schema';

/** Administration → users (08 §3, account admin A2): the queries behind the admin service. */

/** The account's active admins who are people (not service identities): whom support entries, tickets and
 * deletion notices are written to (duplication #6 — one query for all three). */
export const activeAdminsOf = (db: Db, accountId: string) =>
  db
    .select({ id: users.id, email: users.email, name: users.name, locale: users.locale })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.role, 'admin'),
        eq(accountMembers.status, 'active'),
        eq(users.isService, false),
      ),
    );

/** A member of this account (any status) with the person behind it; service identities are not people. */
export const findMemberWithUser = async (db: Db, accountId: string, userId: string) =>
  (
    await db
      .select({ membership: accountMembers, user: users })
      .from(accountMembers)
      .innerJoin(users, eq(users.id, accountMembers.userId))
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId), eq(users.isService, false)),
      )
      .limit(1)
  )[0];

export const countActiveAdmins = async (db: Db, accountId: string) =>
  Number(
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(accountMembers)
        .innerJoin(users, eq(users.id, accountMembers.userId))
        .where(
          and(
            eq(accountMembers.accountId, accountId),
            eq(accountMembers.role, 'admin'),
            eq(accountMembers.status, 'active'),
            eq(users.isService, false),
          ),
        )
    )[0]?.n ?? 0,
  );

export const setMembership = (
  db: Db,
  accountId: string,
  userId: string,
  patch: Partial<typeof accountMembers.$inferInsert>,
) =>
  db
    .update(accountMembers)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));

/** Teams of each member of the account (live teams only). */
export const memberTeams = async (db: Db, accountId: string) => {
  const rows = await db
    .select({ userId: teamMembers.userId, id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(and(eq(teamMembers.accountId, accountId), isNull(teams.deletedAt)))
    .orderBy(teams.name);
  const map = new Map<string, { id: string; name: string }[]>();
  for (const r of rows) map.set(r.userId, [...(map.get(r.userId) ?? []), { id: r.id, name: r.name }]);
  return map;
};

/** Last time each person was seen: their newest session activity (sessions are global, D12). */
export const lastSeen = async (db: Db, userIds: string[]) => {
  if (!userIds.length) return new Map<string, Date>();
  const rows = await db
    .select({ userId: authSessions.userId, at: sql<string>`max(${authSessions.updatedAt})` })
    .from(authSessions)
    .where(inArray(authSessions.userId, userIds))
    .groupBy(authSessions.userId);
  const seen = await db.select({ id: users.id, at: users.lastSeenAt }).from(users).where(inArray(users.id, userIds));
  const map = new Map<string, Date>();
  for (const r of rows) if (r.at) map.set(r.userId, new Date(r.at));
  for (const r of seen) if (r.at && (!map.get(r.id) || map.get(r.id)! < r.at)) map.set(r.id, r.at);
  return map;
};

/** Active memberships of a person in other live accounts. */
export const activeElsewhere = async (db: Db, accountId: string, userId: string) =>
  (
    await db
      .select({ id: accountMembers.id })
      .from(accountMembers)
      .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
      .where(
        and(
          eq(accountMembers.userId, userId),
          ne(accountMembers.accountId, accountId),
          eq(accountMembers.status, 'active'),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1)
  ).length > 0;

/**
 * May an admin of `accountId` take over this person's sign-in (a recovery link, a 2FA reset, wiping their sign-ins)?
 * Their password and second factor are global (D12), so not when they open more than this account (S-52):
 * the platform owner; someone active in another account; an active support person (the console, by their address —
 * verified or not); someone holding a live support grant to another account (email grant, or one made out to them);
 * someone with a pending invitation to another account (taking their sign-in would take that membership too).
 */
export type SignInGuard =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'platform_owner'
        | 'member_of_other_accounts'
        | 'support_staff'
        | 'support_grant_elsewhere'
        | 'invited_elsewhere';
    };

export const mayTakeOverSignIn = async (db: Db, accountId: string, userId: string): Promise<SignInGuard> => {
  const user = (
    await db
      .select({ email: users.email, isPlatformOwner: users.isPlatformOwner })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0];
  if (!user) return { ok: true };
  if (user.isPlatformOwner) return { ok: false, reason: 'platform_owner' };
  if (await activeElsewhere(db, accountId, userId)) return { ok: false, reason: 'member_of_other_accounts' };
  const email = user.email.toLowerCase();
  const staff = await db
    .select({ id: supportStaff.id })
    .from(supportStaff)
    .where(
      and(
        eq(supportStaff.status, 'active'),
        or(eq(sql`lower(${supportStaff.email})`, email), eq(supportStaff.userId, userId)),
      ),
    )
    .limit(1);
  if (staff.length) return { ok: false, reason: 'support_staff' };
  const now = new Date();
  const grants = await db
    .select({ id: supportAccessGrants.id })
    .from(supportAccessGrants)
    .innerJoin(accounts, eq(accounts.id, supportAccessGrants.accountId))
    .where(
      and(
        ne(supportAccessGrants.accountId, accountId),
        isNull(supportAccessGrants.revokedAt),
        gt(supportAccessGrants.expiresAt, now),
        isNull(accounts.deletedAt),
        or(
          and(
            eq(supportAccessGrants.granteeKind, 'email'),
            eq(sql`lower(${supportAccessGrants.grantedToEmail})`, email),
          ),
          eq(supportAccessGrants.grantedToUserId, userId),
        ),
      ),
    )
    .limit(1);
  if (grants.length) return { ok: false, reason: 'support_grant_elsewhere' };
  const invited = await db
    .select({ id: accountInvitations.id })
    .from(accountInvitations)
    .innerJoin(accounts, eq(accounts.id, accountInvitations.accountId))
    .where(
      and(
        ne(accountInvitations.accountId, accountId),
        eq(sql`lower(${accountInvitations.email})`, email),
        isNull(accountInvitations.acceptedAt),
        isNull(accountInvitations.revokedAt),
        gt(accountInvitations.expiresAt, now),
        isNull(accounts.deletedAt),
      ),
    )
    .limit(1);
  if (invited.length) return { ok: false, reason: 'invited_elsewhere' };
  return { ok: true };
};

/** 403 with the reason when an admin of `accountId` may not take over this person's sign-in (S-52). */
export const assertMayTakeOverSignIn = async (db: Db, accountId: string, userId: string) => {
  const guard = await mayTakeOverSignIn(db, accountId, userId);
  if (!guard.ok) throw new AppError('forbidden', guard.reason);
};

/**
 * The people of `userIds` whose name an admin of `accountId` may not change (S-63): the name is the person's own,
 * in every account, so not when it shows in more than this one — the platform owner, an active support person,
 * someone active in another live account.
 */
export const namesManagedElsewhere = async (db: Db, accountId: string, userIds: string[]): Promise<Set<string>> => {
  const out = new Set<string>();
  if (!userIds.length) return out;
  const people = await db
    .select({ id: users.id, email: users.email, isPlatformOwner: users.isPlatformOwner })
    .from(users)
    .where(inArray(users.id, userIds));
  for (const p of people) if (p.isPlatformOwner) out.add(p.id);
  const elsewhere = await db
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
  for (const r of elsewhere) out.add(r.userId);
  const emails = people.map((p) => p.email.toLowerCase());
  const staff = await db
    .select({ userId: supportStaff.userId, email: supportStaff.email })
    .from(supportStaff)
    .where(
      and(
        eq(supportStaff.status, 'active'),
        or(inArray(supportStaff.userId, userIds), inArray(sql`lower(${supportStaff.email})`, emails)),
      ),
    );
  for (const s of staff) {
    if (s.userId && userIds.includes(s.userId)) out.add(s.userId);
    const byEmail = people.find((p) => p.email.toLowerCase() === s.email.toLowerCase());
    if (byEmail) out.add(byEmail.id);
  }
  return out;
};

export const deleteSessionsOf = (db: Db, userId: string) =>
  db.delete(authSessions).where(eq(authSessions.userId, userId));

export const deleteIdentitiesOf = (db: Db, userId: string) =>
  db.delete(authIdentities).where(eq(authIdentities.userId, userId));

/** The person's own (personal) API tokens in this account → revoked. */
export const revokePersonalTokens = (db: Db, accountId: string, userId: string) =>
  db
    .update(apiTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiTokens.accountId, accountId), eq(apiTokens.userId, userId), isNull(apiTokens.revokedAt)))
    .returning({ id: apiTokens.id });

/** Automations the person owns that still run → off, with the reason (08 §3.2). */
export const disableOwnedAutomations = (db: Db, accountId: string, userId: string) =>
  db
    .update(automations)
    .set({ isActive: false, deactivatedReason: 'owner_deactivated', updatedAt: new Date() })
    .where(
      and(
        eq(automations.accountId, accountId),
        eq(automations.ownerId, userId),
        eq(automations.isActive, true),
        isNull(automations.deletedAt),
      ),
    )
    .returning({ id: automations.id, boardId: automations.boardId });

export const disableOwnedWebhooks = (db: Db, accountId: string, userId: string) =>
  db
    .update(webhooks)
    .set({ isActive: false, disabledReason: 'owner_deactivated', updatedAt: new Date() })
    .where(
      and(
        eq(webhooks.accountId, accountId),
        eq(webhooks.createdBy, userId),
        eq(webhooks.isActive, true),
        isNull(webhooks.deletedAt),
      ),
    )
    .returning({ id: webhooks.id, boardId: webhooks.boardId });

// ---- transfer ownership ----
export const ownedBoards = (db: Db, accountId: string, userId: string) =>
  db
    .select({ boardId: boardMembers.boardId })
    .from(boardMembers)
    .where(and(eq(boardMembers.accountId, accountId), eq(boardMembers.userId, userId), eq(boardMembers.role, 'owner')));

export const setBoardRole = (
  db: Db,
  accountId: string,
  boardId: string,
  userId: string,
  role: 'owner' | 'subscriber',
  addedBy: string,
) =>
  db
    .insert(boardMembers)
    .values({ boardId, userId, accountId, role, addedBy })
    .onConflictDoUpdate({ target: [boardMembers.boardId, boardMembers.userId], set: { role, level: null } });

export const demoteBoardOwner = (db: Db, accountId: string, boardId: string, userId: string) =>
  db
    .update(boardMembers)
    .set({ role: 'subscriber' })
    .where(
      and(eq(boardMembers.accountId, accountId), eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)),
    );

/** Automations owned by `from` move to `to`; the ones turned off because their owner left run again. */
export const moveAutomations = async (db: Db, accountId: string, from: string, to: string) => {
  const where = and(eq(automations.accountId, accountId), eq(automations.ownerId, from), isNull(automations.deletedAt));
  const rows = await db
    .select({ id: automations.id, boardId: automations.boardId, reason: automations.deactivatedReason })
    .from(automations)
    .where(where);
  if (!rows.length) return rows;
  await db.update(automations).set({ ownerId: to, updatedAt: new Date() }).where(where);
  const revive = rows.filter((r) => r.reason === 'owner_deactivated').map((r) => r.id);
  if (revive.length)
    await db
      .update(automations)
      .set({ isActive: true, deactivatedReason: null })
      .where(inArray(automations.id, revive));
  return rows;
};

export const moveWebhooks = async (db: Db, accountId: string, from: string, to: string) => {
  const where = and(eq(webhooks.accountId, accountId), eq(webhooks.createdBy, from), isNull(webhooks.deletedAt));
  const rows = await db
    .select({ id: webhooks.id, boardId: webhooks.boardId, reason: webhooks.disabledReason })
    .from(webhooks)
    .where(where);
  if (!rows.length) return rows;
  await db.update(webhooks).set({ createdBy: to, updatedAt: new Date() }).where(where);
  const revive = rows.filter((r) => r.reason === 'owner_deactivated').map((r) => r.id);
  if (revive.length)
    await db.update(webhooks).set({ isActive: true, disabledReason: null }).where(inArray(webhooks.id, revive));
  return rows;
};

/** Live service tokens (06 §1.2) the person created: who answers for them. */
export const moveServiceTokens = (db: Db, accountId: string, from: string, to: string) =>
  db
    .update(apiTokens)
    .set({ createdBy: to })
    .where(
      and(
        eq(apiTokens.accountId, accountId),
        eq(apiTokens.createdBy, from),
        like(apiTokens.tokenPrefix, `${SERVICE_TOKEN_PREFIX}%`),
        isNull(apiTokens.revokedAt),
      ),
    )
    .returning({ id: apiTokens.id, name: apiTokens.name });

/** People cells of the account that name this person (03 §2.9) — with their column settings. */
export const peopleCellsOf = (db: Db, accountId: string, userId: string) =>
  db
    .select({
      itemId: cells.itemId,
      columnId: cells.columnId,
      boardId: cells.boardId,
      value: cells.value,
      settings: columns.settings,
      columnKey: columns.key,
    })
    .from(cells)
    .innerJoin(columns, eq(columns.id, cells.columnId))
    .where(
      and(
        eq(cells.accountId, accountId),
        eq(columns.type, 'people'),
        sql`${cells.value} @> ${JSON.stringify({ persons_and_teams: [{ id: userId, kind: 'person' }] })}::jsonb`,
      ),
    );

/** "Delete details" (08 §3.2): the person's identity goes, the row (and everything pointing at it) stays. */
export const anonymiseUser = (db: Db, userId: string, email: string, name: string) =>
  db
    .update(users)
    .set({
      email,
      name,
      emailVerified: false,
      image: null,
      avatarAssetId: null,
      title: null,
      phone: null,
      department: null,
      birthday: null,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId))
    // Who they were in each account (Fix: ) goes with the identity.
    .then(() =>
      db
        .update(accountMembers)
        .set({ title: null, phone: null, department: null, updatedAt: new Date() })
        .where(eq(accountMembers.userId, userId)),
    );

/** Board ownership of the person in this account ends (they stay a subscriber, greyed). */
export const dropBoardOwnership = (db: Db, accountId: string, userId: string) =>
  db
    .update(boardMembers)
    .set({ role: 'subscriber' })
    .where(and(eq(boardMembers.accountId, accountId), eq(boardMembers.userId, userId), eq(boardMembers.role, 'owner')))
    .returning({ boardId: boardMembers.boardId });
