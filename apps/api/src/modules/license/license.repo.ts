// SPDX-License-Identifier: AGPL-3.0-only
import {
  and,
  countDistinct,
  count,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { newId, type InstallationsQuery } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  accountMembers,
  accounts,
  boards,
  issuedLicenses,
  items,
  licenseInstallations,
  licensePaymentEvents,
  licenseReminders,
  platformSettings,
  users,
} from '../../db/schema';

/** Licensing data access: platform_settings rows, installation-wide counts, the license server's two tables. */

// ---------------------------------------------------------------- platform_settings rows

export const readSettingsRow = async (db: Db, id: string): Promise<Record<string, unknown> | null> => {
  const row = (await db.select().from(platformSettings).where(eq(platformSettings.id, id)).limit(1))[0];
  return (row?.settings as Record<string, unknown> | undefined) ?? null;
};

export const writeSettingsRow = async (
  db: Db,
  id: string,
  settings: Record<string, unknown>,
  userId: string | null,
) => {
  await db
    .insert(platformSettings)
    .values({ id, settings: settings as never, updatedBy: userId })
    .onConflictDoUpdate({
      target: platformSettings.id,
      set: { settings: settings as never, updatedBy: userId, updatedAt: new Date() },
    });
};

/** Inserts the row only if it is not there (first boot); returns what is stored afterwards. */
export const insertSettingsRowIfMissing = async (db: Db, id: string, settings: Record<string, unknown>) => {
  await db
    .insert(platformSettings)
    .values({ id, settings: settings as never })
    .onConflictDoNothing({ target: platformSettings.id });
  return readSettingsRow(db, id);
};

// ---------------------------------------------------------------- installation-wide counts

/**
 * Active users of the installation (a license's seats): people (not service identities) with an active, non-guest
 * membership in an account that is not deleted — each counted once.
 */
export const countActiveUsers = async (db: Db) =>
  Number(
    (
      await db
        .select({ n: countDistinct(accountMembers.userId) })
        .from(accountMembers)
        .innerJoin(users, eq(users.id, accountMembers.userId))
        .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
        .where(
          and(
            eq(accountMembers.status, 'active'),
            ne(accountMembers.role, 'guest'),
            eq(users.isService, false),
            isNull(accounts.deletedAt),
          ),
        )
    )[0]?.n ?? 0,
  );

/** People with an active guest membership in a live account (each counted once). */
export const countActiveGuests = async (db: Db) =>
  Number(
    (
      await db
        .select({ n: countDistinct(accountMembers.userId) })
        .from(accountMembers)
        .innerJoin(users, eq(users.id, accountMembers.userId))
        .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
        .where(
          and(
            eq(accountMembers.status, 'active'),
            eq(accountMembers.role, 'guest'),
            eq(users.isService, false),
            isNull(accounts.deletedAt),
          ),
        )
    )[0]?.n ?? 0,
  );

/** Is this person counted among the active users (an active, non-guest membership in a live account)? */
export const isActiveUser = async (db: Db, userId: string) =>
  (
    await db
      .select({ id: accountMembers.id })
      .from(accountMembers)
      .innerJoin(users, eq(users.id, accountMembers.userId))
      .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
      .where(
        and(
          eq(accountMembers.userId, userId),
          eq(accountMembers.status, 'active'),
          ne(accountMembers.role, 'guest'),
          eq(users.isService, false),
          isNull(accounts.deletedAt),
        ),
      )
      .limit(1)
  ).length > 0;

/**
 * Item rows of the installation — items and subitems of every account, archived and trashed too (edition limits:
 * they count until the purge). `cap` stops counting there (a cheap check on a large table): the answer is then
 * min(rows, cap).
 */
export const countAllItems = async (db: Db, cap?: number) => {
  const rows = db.select({ one: sql<number>`1`.as('one') }).from(items);
  const sub = (cap === undefined ? rows : rows.limit(cap)).as('t');
  return Number((await db.select({ n: count() }).from(sub))[0]?.n ?? 0);
};

/** Boards of the installation (main boards, not deleted, not sub-boards). */
export const countBoards = async (db: Db) =>
  Number(
    (
      await db
        .select({ n: count() })
        .from(boards)
        .where(and(isNull(boards.deletedAt), isNull(boards.parentBoardId)))
    )[0]?.n ?? 0,
  );

// ---------------------------------------------------------------- issued licenses (license server)

export type IssuedLicenseRow = typeof issuedLicenses.$inferSelect;

export const listIssuedLicenses = (db: Db) =>
  db.select().from(issuedLicenses).orderBy(desc(issuedLicenses.createdAt)).limit(2000);

export const findIssuedLicense = async (db: Db, id: string) =>
  (await db.select().from(issuedLicenses).where(eq(issuedLicenses.id, id)).limit(1))[0] ?? null;

export const findIssuedLicenseByRef = async (db: Db, ref: string) =>
  (await db.select().from(issuedLicenses).where(eq(issuedLicenses.ref, ref)).limit(1))[0] ?? null;

/** The newest license for an installation (the online check falls back to it when the key names no id). */
export const findLatestLicenseForInstance = async (db: Db, instanceId: string) =>
  (
    await db
      .select()
      .from(issuedLicenses)
      .where(eq(issuedLicenses.instanceId, instanceId))
      .orderBy(desc(issuedLicenses.issuedAt))
      .limit(1)
  )[0] ?? null;

export const insertIssuedLicense = async (db: Db, row: Omit<typeof issuedLicenses.$inferInsert, 'id'>) =>
  (
    await db
      .insert(issuedLicenses)
      .values({ id: newId(), ...row })
      .returning()
  )[0]!;

export const updateIssuedLicense = async (
  db: Db,
  id: string,
  patch: Partial<Omit<typeof issuedLicenses.$inferInsert, 'id' | 'ref'>>,
) =>
  (
    await db
      .update(issuedLicenses)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(issuedLicenses.id, id))
      .returning()
  )[0] ?? null;

/** The license a payment provider's subscription renews. */
export const findLicenseBySubscription = async (db: Db, provider: string, subscriptionId: string) =>
  (
    await db
      .select()
      .from(issuedLicenses)
      .where(
        and(eq(issuedLicenses.paymentProvider, provider), eq(issuedLicenses.paymentSubscriptionId, subscriptionId)),
      )
      .orderBy(desc(issuedLicenses.issuedAt))
      .limit(1)
  )[0] ?? null;

// ---------------------------------------------------------------- expiry reminders (license server)

/** Licenses not revoked whose expiry is after `from` and not later than `to` (the reminder job's window). */
export const licensesExpiringBetween = (db: Db, from: Date, to: Date) =>
  db
    .select()
    .from(issuedLicenses)
    .where(and(isNull(issuedLicenses.revokedAt), gt(issuedLicenses.expires, from), lte(issuedLicenses.expires, to)))
    .limit(5000);

/**
 * Claims one reminder (license × expiry × days): true only for the caller that inserted it — two processes (or a
 * second run of the hour) never both send.
 */
export const claimReminder = async (db: Db, licenseId: string, expires: Date, days: number) =>
  (
    await db
      .insert(licenseReminders)
      .values({ id: newId(), licenseId, expires, days })
      .onConflictDoNothing()
      .returning({ id: licenseReminders.id })
  ).length > 0;

/** A claimed reminder whose email failed: freed, so the next run tries again. */
export const releaseReminder = async (db: Db, licenseId: string, expires: Date, days: number) => {
  await db
    .delete(licenseReminders)
    .where(
      and(
        eq(licenseReminders.licenseId, licenseId),
        eq(licenseReminders.expires, expires),
        eq(licenseReminders.days, days),
      ),
    );
};

export type ReminderRow = typeof licenseReminders.$inferSelect;
export const remindersFor = (db: Db, licenseIds: string[]) =>
  licenseIds.length
    ? db.select().from(licenseReminders).where(inArray(licenseReminders.licenseId, licenseIds))
    : Promise.resolve([] as ReminderRow[]);

/** The platform owners' addresses (the reminder's second recipient). */
export const platformOwnerContacts = (db: Db) =>
  db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(and(eq(users.isPlatformOwner, true), eq(users.isService, false)));

// ---------------------------------------------------------------- payment events (license server)

/** Records a provider event once: false = it was handled already (a replay). */
export const claimPaymentEvent = async (db: Db, provider: string, eventId: string, type: string) =>
  (
    await db
      .insert(licensePaymentEvents)
      .values({ id: newId(), provider, eventId, type })
      .onConflictDoNothing()
      .returning({ id: licensePaymentEvents.id })
  ).length > 0;

export const settlePaymentEvent = async (db: Db, provider: string, eventId: string, licenseId: string | null) => {
  await db
    .update(licensePaymentEvents)
    .set({ licenseId })
    .where(and(eq(licensePaymentEvents.provider, provider), eq(licensePaymentEvents.eventId, eventId)));
};

/** Handling failed: forget the event so the provider's retry is handled. */
export const releasePaymentEvent = async (db: Db, provider: string, eventId: string) => {
  await db
    .delete(licensePaymentEvents)
    .where(and(eq(licensePaymentEvents.provider, provider), eq(licensePaymentEvents.eventId, eventId)));
};

// ---------------------------------------------------------------- installations (license server)

export type InstallationRow = typeof licenseInstallations.$inferSelect;

export const listInstallations = (db: Db, q: InstallationsQuery) => {
  const where: SQL[] = [];
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(
      or(
        ilike(licenseInstallations.company, like),
        ilike(licenseInstallations.email, like),
        ilike(licenseInstallations.role, like),
        ilike(licenseInstallations.instanceId, like),
      )!,
    );
  }
  if (q.size) where.push(eq(licenseInstallations.size, q.size));
  if (q.use_case) where.push(eq(licenseInstallations.useCase, q.use_case));
  if (q.verified === 'yes') where.push(isNotNull(licenseInstallations.verifiedAt));
  if (q.verified === 'no') where.push(isNull(licenseInstallations.verifiedAt));
  if (q.marketing) where.push(eq(licenseInstallations.marketingOptIn, q.marketing === 'yes'));
  return db
    .select()
    .from(licenseInstallations)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(licenseInstallations.createdAt))
    .limit(5000);
};

export const findInstallationByInstance = async (db: Db, instanceId: string) =>
  (await db.select().from(licenseInstallations).where(eq(licenseInstallations.instanceId, instanceId)).limit(1))[0] ??
  null;

export const findInstallation = async (db: Db, id: string) =>
  (await db.select().from(licenseInstallations).where(eq(licenseInstallations.id, id)).limit(1))[0] ?? null;

export const findInstallationByVerifyHash = async (db: Db, hash: string) =>
  (await db.select().from(licenseInstallations).where(eq(licenseInstallations.verifyTokenHash, hash)).limit(1))[0] ??
  null;

/** One row per installation: a new registration of the same `instance_id` replaces its answers. */
export const upsertInstallation = async (
  db: Db,
  row: Omit<typeof licenseInstallations.$inferInsert, 'id' | 'createdAt' | 'updatedAt'>,
) =>
  (
    await db
      .insert(licenseInstallations)
      .values({ id: newId(), ...row })
      .onConflictDoUpdate({
        target: licenseInstallations.instanceId,
        set: { ...row, updatedAt: new Date() },
      })
      .returning()
  )[0]!;

export const updateInstallation = async (
  db: Db,
  id: string,
  patch: Partial<Omit<typeof licenseInstallations.$inferInsert, 'id' | 'instanceId'>>,
) =>
  (
    await db
      .update(licenseInstallations)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(licenseInstallations.id, id))
      .returning()
  )[0] ?? null;
