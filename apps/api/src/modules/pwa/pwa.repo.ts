// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq } from 'drizzle-orm';
import { newId } from '@bines/shared';
import type { Db } from '../../db/client';
import { pushSubscriptions } from '../../db/schema';

export type PushSubscriptionRecord = typeof pushSubscriptions.$inferSelect;

/**
 * Registers (or refreshes) this browser's subscription in an account. The endpoint is unique per account: the same
 * phone signing in as someone else takes the row over (keys, user and session follow the newest sign-in).
 */
export const upsertSubscription = async (
  db: Db,
  s: {
    accountId: string;
    userId: string;
    sessionId: string | null;
    endpoint: string;
    p256dh: string;
    auth: string;
    deviceLabel: string;
  },
) => {
  const [row] = await db
    .insert(pushSubscriptions)
    .values({ id: newId(), ...s })
    .onConflictDoUpdate({
      target: [pushSubscriptions.accountId, pushSubscriptions.endpoint],
      set: {
        userId: s.userId,
        sessionId: s.sessionId,
        p256dh: s.p256dh,
        auth: s.auth,
        deviceLabel: s.deviceLabel,
        failures: 0,
      },
    })
    .returning();
  return row!;
};

export const listSubscriptions = (db: Db, accountId: string, userId: string) =>
  db
    .select()
    .from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.accountId, accountId), eq(pushSubscriptions.userId, userId)))
    .orderBy(desc(pushSubscriptions.createdAt))
    .limit(100);

export const deleteSubscription = async (db: Db, accountId: string, userId: string, id: string) =>
  (
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.accountId, accountId),
          eq(pushSubscriptions.userId, userId),
          eq(pushSubscriptions.id, id),
        ),
      )
      .returning({ id: pushSubscriptions.id })
  ).length;

/**
 * The member left the account or was removed (deactivated): every phone / browser of theirs in that account stops
 * at once — not only when the session ends (it may stay alive for their other accounts).
 */
export const deleteMemberSubscriptions = async (db: Db, accountId: string, userId: string) =>
  (
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.accountId, accountId), eq(pushSubscriptions.userId, userId)))
      .returning({ id: pushSubscriptions.id })
  ).length;

/** Sign-out on this browser: its endpoint leaves every account of this user. */
export const deleteEndpointForUser = async (db: Db, userId: string, endpoint: string) =>
  (
    await db
      .delete(pushSubscriptions)
      .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
      .returning({ id: pushSubscriptions.id })
  ).length;
