// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq, gt, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { SignupRequestStatus } from '@bines/shared';
import type { Db } from '../../db/client';
import { accountInvitations, accountMembers, accounts, signupRequests } from '../../db/schema';

/** Self sign-up requests (D32): platform-level rows, no account yet — the owner console reads them. */
export type SignupRequestRow = typeof signupRequests.$inferSelect;

export const insertSignupRequest = (db: Db, row: typeof signupRequests.$inferInsert) =>
  db.insert(signupRequests).values(row);

export const findSignupRequest = async (db: Db, id: string) =>
  (await db.select().from(signupRequests).where(eq(signupRequests.id, id)).limit(1))[0];

export const findSignupRequestByToken = async (db: Db, tokenHash: string) =>
  (await db.select().from(signupRequests).where(eq(signupRequests.tokenHash, tokenHash)).limit(1))[0];

export const updateSignupRequest = (db: Db, id: string, patch: Partial<typeof signupRequests.$inferInsert>) =>
  db
    .update(signupRequests)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(signupRequests.id, id));

/**
 * Moves a request from one of `from` to `to` — true for exactly one caller however many race (the verify link
 * clicked twice, the owner approving in two tabs).
 */
export const claimSignupRequest = async (
  db: Db,
  id: string,
  from: SignupRequestStatus[],
  to: SignupRequestStatus,
  patch: Partial<typeof signupRequests.$inferInsert> = {},
) =>
  (
    await db
      .update(signupRequests)
      .set({ ...patch, status: to, updatedAt: new Date() })
      .where(and(eq(signupRequests.id, id), inArray(signupRequests.status, from)))
      .returning({ id: signupRequests.id })
  ).length > 0;

/** Rows since `since` — by address, by client address, or all of them (the rate limits and the daily cap). */
export const countSignupRequests = async (db: Db, since: Date, by: { email?: string; ip?: string } = {}) =>
  Number(
    (
      await db
        .select({ n: count() })
        .from(signupRequests)
        .where(
          and(
            gt(signupRequests.createdAt, since),
            by.email ? eq(signupRequests.email, by.email) : undefined,
            by.ip ? eq(signupRequests.ip, by.ip) : undefined,
          ),
        )
    )[0]?.n ?? 0,
  );

/** The newest open request of an address in one of these statuses. */
export const latestSignupRequest = async (db: Db, email: string, statuses: SignupRequestStatus[]) =>
  (
    await db
      .select()
      .from(signupRequests)
      .where(and(eq(signupRequests.email, email), inArray(signupRequests.status, statuses)))
      .orderBy(desc(signupRequests.createdAt))
      .limit(1)
  )[0];

/** An address starting again: its earlier links stop working (one live link per address). */
export const expireOpenRequestsOf = (db: Db, email: string) =>
  db
    .update(signupRequests)
    .set({ status: 'expired', tokenHash: null, passwordHash: null, updatedAt: new Date() })
    .where(and(eq(signupRequests.email, email), inArray(signupRequests.status, ['pending_email', 'pending_provider'])));

export const listSignupRequests = (
  db: Db,
  q: { status?: SignupRequestStatus; q?: string; limit: number; before?: string },
) => {
  const like = q.q ? `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%` : null;
  return db
    .select()
    .from(signupRequests)
    .where(
      and(
        q.status ? eq(signupRequests.status, q.status) : undefined,
        like
          ? or(ilike(signupRequests.email, like), ilike(signupRequests.orgName, like), ilike(signupRequests.name, like))
          : undefined,
        // Keyset on the id (a ULID: time-ordered, unique) — `created_at` is µs in the column and ms in a
        // cursor, so two requests made in one millisecond lost the second one (audit B3).
        q.before ? lt(signupRequests.id, q.before) : undefined,
      ),
    )
    .orderBy(desc(signupRequests.createdAt), desc(signupRequests.id))
    .limit(q.limit + 1);
};

/**
 * The daily sweep: links past their time expire (the password hash goes with them); ended requests older than
 * `keepDays` are deleted. Returns how many rows each step touched.
 */
export const sweepSignupRequests = async (db: Db, now: Date, keepDays: number) => {
  const expired = await db
    .update(signupRequests)
    .set({ status: 'expired', tokenHash: null, passwordHash: null, updatedAt: now })
    .where(
      and(inArray(signupRequests.status, ['pending_email', 'pending_provider']), lt(signupRequests.expiresAt, now)),
    )
    .returning({ id: signupRequests.id });
  const cutoff = new Date(now.getTime() - keepDays * 86_400_000);
  const deleted = await db
    .delete(signupRequests)
    .where(
      and(
        inArray(signupRequests.status, ['expired', 'rejected', 'existing_user']),
        lt(signupRequests.updatedAt, cutoff),
      ),
    )
    .returning({ id: signupRequests.id });
  return { expired: expired.length, deleted: deleted.length };
};

/** How many accounts a person belongs to (a Google / Microsoft sign-up is only for someone new). */
export const membershipCount = async (db: Db, userId: string) =>
  Number((await db.select({ n: count() }).from(accountMembers).where(eq(accountMembers.userId, userId)))[0]?.n ?? 0);

/**
 * Does the person own an account here ? Owning = still an active admin of a live account whose first-admin
 * invitation they accepted — the account they opened by signing up, or the one the owner console created for them.
 * Someone only invited into other people's accounts (any role) owns none, and may open one by signing up.
 */
export const ownsAccount = async (db: Db, userId: string) =>
  (
    await db
      .select({ id: accountInvitations.id })
      .from(accountInvitations)
      .innerJoin(accounts, eq(accounts.id, accountInvitations.accountId))
      .innerJoin(
        accountMembers,
        and(eq(accountMembers.accountId, accountInvitations.accountId), eq(accountMembers.userId, userId)),
      )
      .where(
        and(
          eq(accountInvitations.acceptedBy, userId),
          sql`(${accountInvitations.payload} ->> 'first_admin') = 'true'`,
          isNull(accounts.deletedAt),
          eq(accountMembers.role, 'admin'),
          eq(accountMembers.status, 'active'),
        ),
      )
      .limit(1)
  ).length > 0;
