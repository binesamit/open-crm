// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { newId } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  accountMembers,
  accounts,
  supportAccessGrants,
  supportRecoveryRequests,
  supportTickets,
  users,
} from '../../db/schema';

/** Remote support access: grants and the emergency recovery requests. */
export type GrantRow = typeof supportAccessGrants.$inferSelect;
export type RecoveryRequestRow = typeof supportRecoveryRequests.$inferSelect;

export const insertGrant = async (db: Db, row: Omit<typeof supportAccessGrants.$inferInsert, 'id'>) => {
  const id = newId();
  await db.insert(supportAccessGrants).values({ ...row, id });
  return (await db.select().from(supportAccessGrants).where(eq(supportAccessGrants.id, id)))[0]!;
};

export const findGrant = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(supportAccessGrants)
      .where(and(eq(supportAccessGrants.accountId, accountId), eq(supportAccessGrants.id, id)))
      .limit(1)
  )[0];

/** Revokes a grant that is still open; returns whether it changed. */
export const revokeGrantRow = async (db: Db, accountId: string, id: string, by: string) =>
  (
    await db
      .update(supportAccessGrants)
      .set({ revokedAt: new Date(), revokedBy: by })
      .where(
        and(
          eq(supportAccessGrants.accountId, accountId),
          eq(supportAccessGrants.id, id),
          isNull(supportAccessGrants.revokedAt),
        ),
      )
      .returning({ id: supportAccessGrants.id })
  ).length > 0;

/** Revokes every open grant approved from a ticket (the ticket was solved or closed); returns the revoked rows. */
export const revokeTicketGrantRows = (db: Db, ticketId: string, by: string | null, now = new Date()) =>
  db
    .update(supportAccessGrants)
    .set({ revokedAt: now, revokedBy: by })
    .where(
      and(
        eq(supportAccessGrants.ticketId, ticketId),
        isNull(supportAccessGrants.revokedAt),
        gt(supportAccessGrants.expiresAt, now),
      ),
    )
    .returning();

/**
 * The active grant that lets this person into this account, if any: not revoked, not expired, and addressed to
 * them — a `platform` grant to a platform owner, an `email` grant to the verified address. The person's flags are
 * read from the database (a token's or a socket's user carries no owner flag). Edit wins over view.
 */
export const findActiveGrantFor = async (db: Db, accountId: string, userId: string, now = new Date()) => {
  const row = (
    await db
      .select({ grant: supportAccessGrants, ticketNumber: supportTickets.number })
      .from(supportAccessGrants)
      .innerJoin(users, eq(users.id, userId))
      .leftJoin(supportTickets, eq(supportTickets.id, supportAccessGrants.ticketId))
      .where(
        and(
          eq(supportAccessGrants.accountId, accountId),
          isNull(supportAccessGrants.revokedAt),
          gt(supportAccessGrants.expiresAt, now),
          or(
            and(eq(supportAccessGrants.granteeKind, 'platform'), eq(users.isPlatformOwner, true)),
            and(
              eq(supportAccessGrants.granteeKind, 'email'),
              eq(users.emailVerified, true),
              eq(sql`lower(${supportAccessGrants.grantedToEmail})`, sql`lower(${users.email})`),
            ),
          ),
        ),
      )
      .orderBy(desc(supportAccessGrants.scope), desc(supportAccessGrants.expiresAt))
      .limit(1)
  )[0];
  return row ? { ...row.grant, ticketNumber: row.ticketNumber } : undefined;
};

/** Accounts this person may open by an active grant now (the account switcher), with the grant. */
export const listActiveGrantAccountsFor = async (db: Db, userId: string, now = new Date()) => {
  const rows = await db
    .select({ grant: supportAccessGrants, account: accounts, ticketNumber: supportTickets.number })
    .from(supportAccessGrants)
    .innerJoin(users, eq(users.id, userId))
    .innerJoin(accounts, eq(accounts.id, supportAccessGrants.accountId))
    .leftJoin(supportTickets, eq(supportTickets.id, supportAccessGrants.ticketId))
    .where(
      and(
        isNull(accounts.deletedAt),
        isNull(supportAccessGrants.revokedAt),
        gt(supportAccessGrants.expiresAt, now),
        or(
          and(eq(supportAccessGrants.granteeKind, 'platform'), eq(users.isPlatformOwner, true)),
          and(
            eq(supportAccessGrants.granteeKind, 'email'),
            eq(users.emailVerified, true),
            eq(sql`lower(${supportAccessGrants.grantedToEmail})`, sql`lower(${users.email})`),
          ),
        ),
      ),
    )
    .orderBy(desc(supportAccessGrants.scope), desc(supportAccessGrants.expiresAt));
  const byAccount = new Map<
    string,
    { grant: GrantRow & { ticketNumber: number | null }; account: (typeof rows)[number]['account'] }
  >();
  for (const r of rows)
    if (!byAccount.has(r.account.id))
      byAccount.set(r.account.id, { grant: { ...r.grant, ticketNumber: r.ticketNumber }, account: r.account });
  return [...byAccount.values()];
};

const grantor = alias(users, 'grantor');
const revoker = alias(users, 'revoker');

/** An account's grants, newest first (active and past). */
export const listGrants = (db: Db, accountId: string, limit = 100) =>
  db
    .select({ grant: supportAccessGrants, grantorName: grantor.name, revokerName: revoker.name })
    .from(supportAccessGrants)
    .leftJoin(grantor, eq(grantor.id, supportAccessGrants.grantedBy))
    .leftJoin(revoker, eq(revoker.id, supportAccessGrants.revokedBy))
    .where(eq(supportAccessGrants.accountId, accountId))
    .orderBy(desc(supportAccessGrants.createdAt))
    .limit(limit);

/**
 * Marks a grant used now. Returns true when this request starts a session: the grant was never used, or not for
 * longer than `idleMs` (one atomic update, so two parallel requests start one session).
 */
export const touchGrant = async (db: Db, id: string, idleMs: number, now = new Date()) => {
  const idleBefore = new Date(now.getTime() - idleMs);
  const started = await db
    .update(supportAccessGrants)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(supportAccessGrants.id, id),
        or(isNull(supportAccessGrants.lastUsedAt), lt(supportAccessGrants.lastUsedAt, idleBefore)),
      ),
    )
    .returning({ id: supportAccessGrants.id });
  if (started.length) return true;
  // Keep-alive, at most once a minute per grant.
  await db
    .update(supportAccessGrants)
    .set({ lastUsedAt: now })
    .where(and(eq(supportAccessGrants.id, id), lt(supportAccessGrants.lastUsedAt, new Date(now.getTime() - 60_000))));
  return false;
};

/** Active admins of an account with their email and language (support notices). */
/** Is this address a platform owner's (the owner console must not hand an owner a membership by itself)? */
export const isPlatformOwnerEmail = async (db: Db, email: string) =>
  (
    await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(sql`lower(${users.email})`, email.toLowerCase()), eq(users.isPlatformOwner, true)))
      .limit(1)
  ).length > 0;

/** Is this person a platform owner (from the database — a token's session never says so)? */
export const isPlatformOwnerUser = async (db: Db, userId: string) =>
  (
    await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.isPlatformOwner, true)))
      .limit(1)
  ).length > 0;

/** Has anyone (a person, not a service identity) an active membership in this account yet? */
export const hasActivePeople = async (db: Db, accountId: string) =>
  (
    await db
      .select({ id: accountMembers.id })
      .from(accountMembers)
      .innerJoin(users, eq(users.id, accountMembers.userId))
      .where(
        and(eq(accountMembers.accountId, accountId), eq(accountMembers.status, 'active'), eq(users.isService, false)),
      )
      .limit(1)
  ).length > 0;

// ---- emergency recovery requests ----

export const insertRecoveryRequest = async (
  db: Db,
  row: Omit<typeof supportRecoveryRequests.$inferInsert, 'id'>,
): Promise<RecoveryRequestRow> => {
  const id = newId();
  await db.insert(supportRecoveryRequests).values({ ...row, id });
  return (await db.select().from(supportRecoveryRequests).where(eq(supportRecoveryRequests.id, id)))[0]!;
};

const requester = alias(users, 'requester');
const canceller = alias(users, 'canceller');

export const listRecoveryRequests = (db: Db, accountIds: string[] | null, limit = 50) =>
  db
    .select({ request: supportRecoveryRequests, requesterName: requester.name, cancellerName: canceller.name })
    .from(supportRecoveryRequests)
    .leftJoin(requester, eq(requester.id, supportRecoveryRequests.requestedBy))
    .leftJoin(canceller, eq(canceller.id, supportRecoveryRequests.cancelledBy))
    .where(accountIds ? inArray(supportRecoveryRequests.accountId, accountIds) : undefined)
    .orderBy(desc(supportRecoveryRequests.createdAt))
    .limit(limit);

export const findRecoveryRequest = async (db: Db, id: string, accountId?: string) =>
  (
    await db
      .select()
      .from(supportRecoveryRequests)
      .where(
        and(
          eq(supportRecoveryRequests.id, id),
          accountId ? eq(supportRecoveryRequests.accountId, accountId) : undefined,
        ),
      )
      .limit(1)
  )[0];

/** Cancels a request that is neither used nor cancelled; returns whether it changed. */
export const cancelRecoveryRequestRow = async (db: Db, accountId: string, id: string, by: string) =>
  (
    await db
      .update(supportRecoveryRequests)
      .set({ cancelledAt: new Date(), cancelledBy: by })
      .where(
        and(
          eq(supportRecoveryRequests.accountId, accountId),
          eq(supportRecoveryRequests.id, id),
          isNull(supportRecoveryRequests.cancelledAt),
          isNull(supportRecoveryRequests.usedAt),
        ),
      )
      .returning({ id: supportRecoveryRequests.id })
  ).length > 0;

/** Uses a request once (single use): only when ready, not cancelled, not used. */
export const useRecoveryRequestRow = async (db: Db, id: string, now = new Date()) =>
  (
    await db
      .update(supportRecoveryRequests)
      .set({ usedAt: now })
      .where(
        and(
          eq(supportRecoveryRequests.id, id),
          isNull(supportRecoveryRequests.cancelledAt),
          isNull(supportRecoveryRequests.usedAt),
          lt(supportRecoveryRequests.availableAt, now),
        ),
      )
      .returning({ id: supportRecoveryRequests.id })
  ).length > 0;
