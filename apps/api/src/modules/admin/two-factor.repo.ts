// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, like } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountMembers, accountSettings, accounts, authTwoFactors, authVerifications, users } from '../../db/schema';

/** M8 ד12: the queries behind two-factor policy, status and the admin reset. */

/** Every account I am an active member of, with my role and the account's settings (the strictest policy wins). */
export const activeMembershipsWithSettings = (db: Db, userId: string) =>
  db
    .select({ accountId: accountMembers.accountId, role: accountMembers.role, settings: accountSettings.settings })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .leftJoin(accountSettings, eq(accountSettings.accountId, accountMembers.accountId))
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.status, 'active'), isNull(accounts.deletedAt)));

export const twoFactorEnabledOf = async (db: Db, userId: string) =>
  (await db.select({ on: users.twoFactorEnabled }).from(users).where(eq(users.id, userId)).limit(1))[0]?.on ?? false;

/**
 * Turns a person's 2FA off (admin reset): the authenticator secret and backup codes go, the flag drops and every
 * "trusted device" of theirs stops counting. Their sessions stay.
 */
export const removeTwoFactor = async (db: Db, userId: string) => {
  await db.delete(authTwoFactors).where(eq(authTwoFactors.userId, userId));
  await db.update(users).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(eq(users.id, userId));
  await db
    .delete(authVerifications)
    .where(and(like(authVerifications.identifier, 'trust-device-%'), eq(authVerifications.value, userId)));
};
