// SPDX-License-Identifier: AGPL-3.0-only
import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountInvitations, accounts, users } from '../../db/schema';
import { sha256 } from '../../lib/tokens';

export type InvitationRow = typeof accountInvitations.$inferSelect;

const pending = () =>
  and(
    isNull(accountInvitations.acceptedAt),
    isNull(accountInvitations.revokedAt),
    gt(accountInvitations.expiresAt, sql`now()`),
  );

const sameEmail = (email: string) => sql`lower(${accountInvitations.email}) = ${email.toLowerCase()}`;

export const insertInvitation = (db: Db, row: typeof accountInvitations.$inferInsert) =>
  db.insert(accountInvitations).values(row);

/** Pending, unexpired invitation by its raw token; also requires the account to be live. */
export const findValidInvitationByToken = async (db: Db, token: string) =>
  (
    await db
      .select({ invitation: accountInvitations, account: accounts })
      .from(accountInvitations)
      .innerJoin(accounts, eq(accounts.id, accountInvitations.accountId))
      .where(and(eq(accountInvitations.tokenHash, sha256(token)), pending(), isNull(accounts.deletedAt)))
      .limit(1)
  ).map((r) => ({ ...r.invitation, account: r.account }))[0];

export const hasPendingInvitationForEmail = async (db: Db, email: string): Promise<boolean> =>
  (
    await db
      .select({ id: accountInvitations.id })
      .from(accountInvitations)
      .innerJoin(accounts, eq(accounts.id, accountInvitations.accountId))
      .where(and(sameEmail(email), pending(), isNull(accounts.deletedAt)))
      .limit(1)
  ).length > 0;

export const listPendingInvitationsForEmail = (db: Db, email: string) =>
  db
    .select({ invitation: accountInvitations, account: accounts })
    .from(accountInvitations)
    .innerJoin(accounts, eq(accounts.id, accountInvitations.accountId))
    .where(and(sameEmail(email), pending(), isNull(accounts.deletedAt)))
    .orderBy(desc(accountInvitations.createdAt));

export const findPendingInvitationForAccountEmail = async (db: Db, accountId: string, email: string) =>
  (
    await db
      .select()
      .from(accountInvitations)
      .where(and(eq(accountInvitations.accountId, accountId), sameEmail(email), pending()))
      .limit(1)
  )[0];

export const findInvitationInAccount = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(accountInvitations)
      .where(and(eq(accountInvitations.accountId, accountId), eq(accountInvitations.id, id)))
      .limit(1)
  )[0];

export const markInvitationAccepted = (db: Db, id: string, userId: string) =>
  db
    .update(accountInvitations)
    .set({ acceptedAt: new Date(), acceptedBy: userId })
    .where(and(eq(accountInvitations.id, id), isNull(accountInvitations.acceptedAt)));

export const revokeInvitation = (db: Db, id: string, by: string | null = null) =>
  db.update(accountInvitations).set({ revokedAt: new Date(), revokedBy: by }).where(eq(accountInvitations.id, id));

/** Not accepted and not cancelled — pending or expired (the list shows expired ones to re-send). */
const notClosed = () => and(isNull(accountInvitations.acceptedAt), isNull(accountInvitations.revokedAt));

const inviter = alias(users, 'inviter');

/** The account's open invitations (pending + expired), newest first, with the inviter's name. */
export const listOpenInvitationsForAccount = async (db: Db, accountId: string) =>
  (
    await db
      .select({ invitation: accountInvitations, inviterName: inviter.name })
      .from(accountInvitations)
      .leftJoin(inviter, eq(inviter.id, accountInvitations.invitedBy))
      .where(and(eq(accountInvitations.accountId, accountId), notClosed()))
      .orderBy(desc(accountInvitations.createdAt))
  ).map((r) => ({ ...r.invitation, inviterName: r.inviterName }));

/** The open invitation (pending or expired) to an address — a new invitation replaces it. */
export const findOpenInvitationForAccountEmail = async (db: Db, accountId: string, email: string) =>
  (
    await db
      .select()
      .from(accountInvitations)
      .where(and(eq(accountInvitations.accountId, accountId), sameEmail(email), notClosed()))
      .orderBy(desc(accountInvitations.createdAt))
      .limit(1)
  )[0];

/** A new link for the same invitation (re-send / copy link): the earlier link stops working at once. */
export const rotateInvitationToken = (db: Db, id: string, tokenHash: string, expiresAt: Date) =>
  db.update(accountInvitations).set({ tokenHash, expiresAt }).where(eq(accountInvitations.id, id));

/** The email went out (or failed): when, by whom, one more send. */
export const markInvitationEmailed = (db: Db, id: string, by: string | null, ok: boolean) =>
  db
    .update(accountInvitations)
    .set({
      lastSentAt: new Date(),
      lastSentBy: by,
      sendCount: sql`${accountInvitations.sendCount} + 1`,
      emailStatus: ok ? 'sent' : 'failed',
    })
    .where(eq(accountInvitations.id, id));

/** The first time the link is opened (the public preview); later opens change nothing. */
export const markInvitationOpened = (db: Db, id: string) =>
  db
    .update(accountInvitations)
    .set({ openedAt: new Date() })
    .where(and(eq(accountInvitations.id, id), isNull(accountInvitations.openedAt)));

export const findInviterName = async (db: Db, userId: string | null) =>
  userId
    ? (await db.select({ name: users.name }).from(users).where(eq(users.id, userId)).limit(1))[0]?.name
    : undefined;
