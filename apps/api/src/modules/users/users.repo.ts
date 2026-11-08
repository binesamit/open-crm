// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNotNull, like, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountMembers, assets, authIdentities, authVerifications, userProfileSettings, users } from '../../db/schema';

export const markPlatformOwner = (db: Db, userId: string) =>
  db.update(users).set({ isPlatformOwner: true, updatedAt: new Date() }).where(eq(users.id, userId));

export const findUserById = async (db: Db, userId: string) =>
  (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0];

export const getLastAccountId = async (db: Db, userId: string): Promise<string | null> => {
  const row = (
    await db
      .select({ last: sql<string | null>`${userProfileSettings.settings}->>'last_account_id'` })
      .from(userProfileSettings)
      .where(eq(userProfileSettings.userId, userId))
      .limit(1)
  )[0];
  return row?.last ?? null;
};

export const setLastAccountId = (db: Db, userId: string, accountId: string) =>
  db
    .insert(userProfileSettings)
    .values({ userId, settings: { last_account_id: accountId } })
    .onConflictDoUpdate({
      target: userProfileSettings.userId,
      set: {
        settings: sql`${userProfileSettings.settings} || jsonb_build_object('last_account_id', ${accountId}::text)`,
        updatedAt: new Date(),
      },
    });

export const listAccountMembers = (db: Db, accountId: string) =>
  db
    .select({
      userId: users.id,
      email: users.email,
      name: users.name,
      // Who the person is in this account (Fix: ) — per membership, not per user.
      title: accountMembers.title,
      phone: accountMembers.phone,
      department: accountMembers.department,
      role: accountMembers.role,
      status: accountMembers.status,
      joinedAt: accountMembers.joinedAt,
      deactivatedAt: accountMembers.deactivatedAt,
      settings: accountMembers.settings,
      image: users.image,
      avatarKey: assets.storageKey,
      avatarName: assets.fileName,
      avatarMime: assets.mime,
      twoFactorEnabled: users.twoFactorEnabled,
    })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .leftJoin(assets, eq(assets.id, users.avatarAssetId))
    // Service identities (API service tokens) are not people: not in member lists or people pickers.
    .where(and(eq(accountMembers.accountId, accountId), eq(users.isService, false)))
    .orderBy(asc(users.name));

/** A user's language by email (auth and invitation emails read in the recipient's language); undefined = no user. */
export const findLocaleByEmail = async (db: Db, email: string): Promise<string | undefined> =>
  (
    await db
      .select({ locale: users.locale })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1)
  )[0]?.locale ?? undefined;

/** The language of an active member of `accountId` with this email (an automation's recipient), if any. */
export const findMemberLocaleByEmail = async (db: Db, accountId: string, email: string): Promise<string | undefined> =>
  (
    await db
      .select({ locale: users.locale })
      .from(users)
      .innerJoin(accountMembers, eq(accountMembers.userId, users.id))
      .where(
        and(
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.status, 'active'),
          sql`lower(${users.email}) = ${email.toLowerCase()}`,
        ),
      )
      .limit(1)
  )[0]?.locale ?? undefined;

export const findUserIdByEmail = async (db: Db, email: string): Promise<string | undefined> =>
  (
    await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1)
  )[0]?.id;

/** The avatar sources of one user: an uploaded asset, else the provider image. */
export const userAvatar = async (db: Db, userId: string) =>
  (
    await db
      .select({
        image: users.image,
        avatarKey: assets.storageKey,
        avatarName: assets.fileName,
        avatarMime: assets.mime,
      })
      .from(users)
      .leftJoin(assets, eq(assets.id, users.avatarAssetId))
      .where(eq(users.id, userId))
      .limit(1)
  )[0];

/** The uploaded photo of one user (its id and the account that stores it), if any. */
export const userAvatarAsset = async (db: Db, userId: string) =>
  (
    await db
      .select({ id: assets.id, accountId: assets.accountId })
      .from(users)
      .innerJoin(assets, eq(assets.id, users.avatarAssetId))
      .where(eq(users.id, userId))
      .limit(1)
  )[0];

export const setUserAvatar = (db: Db, userId: string, assetId: string | null) =>
  db.update(users).set({ avatarAssetId: assetId, updatedAt: new Date() }).where(eq(users.id, userId));

/** The personal profile fields of one user (fix2) — the same in every account. */
export const userProfile = async (db: Db, userId: string) =>
  (
    await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        birthday: users.birthday,
        locale: users.locale,
        timezone: users.timezone,
        marketingOptInAt: users.marketingOptInAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0];

export type ProfilePatch = Partial<
  Pick<typeof users.$inferInsert, 'name' | 'birthday' | 'locale' | 'timezone' | 'marketingOptInAt'>
>;

export const updateUserProfile = (db: Db, userId: string, patch: ProfilePatch) =>
  db
    .update(users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(users.id, userId));

/** Fix: the fields that differ per account — job title, department, work phone (`account_members`). */
export const MEMBER_PROFILE_FIELDS = ['title', 'department', 'phone'] as const;
export type MemberProfile = { title: string | null; department: string | null; phone: string | null };
export type MemberProfilePatch = Partial<MemberProfile>;

/** Who the person is in one account; undefined when they are no member of it. */
export const memberProfile = async (db: Db, accountId: string, userId: string): Promise<MemberProfile | undefined> =>
  (
    await db
      .select({ title: accountMembers.title, department: accountMembers.department, phone: accountMembers.phone })
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
      .limit(1)
  )[0];

export const updateMemberProfile = (db: Db, accountId: string, userId: string, patch: MemberProfilePatch) =>
  db
    .update(accountMembers)
    .set({ ...patch, updatedAt: new Date() })
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)));

/** How a user can sign in (fix8): the login identities' providers; `credential` only when it holds a password. */
export const signInProvidersOf = async (db: Db, userId: string) =>
  (
    await db
      .select({ provider: authIdentities.providerId, password: authIdentities.password })
      .from(authIdentities)
      .where(eq(authIdentities.userId, userId))
  )
    .filter((r) => r.provider !== 'credential' || !!r.password)
    .map((r) => r.provider);

/** Unused password-reset links of a user (Better Auth verification rows `reset-password:<token>` → user id). */
export const deleteResetTokensOf = (db: Db, userId: string) =>
  db
    .delete(authVerifications)
    .where(and(like(authVerifications.identifier, 'reset-password:%'), eq(authVerifications.value, userId)));

export const hasPassword = async (db: Db, userId: string) =>
  (
    await db
      .select({ id: authIdentities.id })
      .from(authIdentities)
      .where(
        and(
          eq(authIdentities.userId, userId),
          eq(authIdentities.providerId, 'credential'),
          isNotNull(authIdentities.password),
        ),
      )
      .limit(1)
  ).length > 0;
