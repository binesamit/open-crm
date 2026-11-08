// SPDX-License-Identifier: AGPL-3.0-only
import { and, count, desc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { AccountRole } from '@bines/shared';
import type { Db } from '../../db/client';
import { accountInvitations, accountMembers, accounts, accountSettings, folders, workspaces } from '../../db/schema';

export type AccountRow = typeof accounts.$inferSelect;

export const findAccountById = async (db: Db, id: string): Promise<AccountRow | undefined> =>
  (
    await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.id, id), isNull(accounts.deletedAt)))
      .limit(1)
  )[0];

export const findAccountBySlug = async (db: Db, slug: string): Promise<AccountRow | undefined> =>
  (await db.select().from(accounts).where(eq(accounts.slug, slug)).limit(1))[0];

/** Every account ever created, deleted ones included (the bootstrap seed creates one only on an empty system). */
export const countAllAccounts = async (db: Db) => Number((await db.select({ n: count() }).from(accounts))[0]?.n ?? 0);

/** The first account created that still exists — the one the bootstrap seed made, whatever it is called now. */
export const findOldestLiveAccount = async (db: Db): Promise<AccountRow | undefined> =>
  (
    await db.select().from(accounts).where(isNull(accounts.deletedAt)).orderBy(accounts.createdAt, accounts.id).limit(1)
  )[0];

export const insertAccount = (db: Db, row: typeof accounts.$inferInsert) => db.insert(accounts).values(row);

export const updateAccountRow = (db: Db, id: string, patch: Partial<typeof accounts.$inferInsert>) =>
  db
    .update(accounts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(accounts.id, id));

export const getAccountSettings = async (db: Db, accountId: string) =>
  (await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)).limit(1))[0]?.settings ?? {};

export const upsertAccountSettings = (db: Db, accountId: string, settings: Record<string, unknown>, by?: string) =>
  db
    .insert(accountSettings)
    .values({ accountId, settings, updatedBy: by })
    .onConflictDoUpdate({
      target: accountSettings.accountId,
      set: { settings, updatedBy: by, updatedAt: new Date() },
    });

export const insertWorkspace = (db: Db, row: typeof workspaces.$inferInsert) => db.insert(workspaces).values(row);
export const insertFolders = (db: Db, rows: (typeof folders.$inferInsert)[]) =>
  rows.length ? db.insert(folders).values(rows) : Promise.resolve();

// ---- memberships ----
export type MembershipRow = typeof accountMembers.$inferSelect;

export const findMembership = async (db: Db, accountId: string, userId: string): Promise<MembershipRow | undefined> =>
  (
    await db
      .select()
      .from(accountMembers)
      .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.userId, userId)))
      .limit(1)
  )[0];

export const insertMembership = (db: Db, row: typeof accountMembers.$inferInsert) =>
  db.insert(accountMembers).values(row).onConflictDoNothing();

/** Active memberships of a user in accounts that are not deleted — the account switcher list. */
export const listAccountsOfUser = (db: Db, userId: string) =>
  db
    .select({
      id: accounts.id,
      name: accounts.name,
      slug: accounts.slug,
      status: accounts.status,
      role: accountMembers.role,
      logo_asset_id: accounts.logoAssetId,
      deletionDueAt: accounts.deletionDueAt,
      origin: accounts.origin,
    })
    .from(accountMembers)
    .innerJoin(accounts, eq(accounts.id, accountMembers.accountId))
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.status, 'active'), isNull(accounts.deletedAt)))
    .orderBy(accounts.name);

// ---- owner console ----
type RoleCounts = Record<AccountRole, number>;

export const listAccountsWithStats = async (
  db: Db,
  opts: { q?: string; status?: 'active' | 'suspended'; id?: string },
) => {
  const conditions = [isNull(accounts.deletedAt)];
  if (opts.id) conditions.push(eq(accounts.id, opts.id));
  if (opts.status) conditions.push(eq(accounts.status, opts.status));
  if (opts.q) conditions.push(or(ilike(accounts.name, `%${opts.q}%`), ilike(accounts.slug, `%${opts.q}%`))!);
  const rows = await db
    .select()
    .from(accounts)
    .where(and(...conditions))
    .orderBy(desc(accounts.createdAt));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);

  const members = await db
    .select({ accountId: accountMembers.accountId, role: accountMembers.role, n: count() })
    .from(accountMembers)
    .where(and(inArray(accountMembers.accountId, ids), eq(accountMembers.status, 'active')))
    .groupBy(accountMembers.accountId, accountMembers.role);
  const invites = await db
    .select({ accountId: accountInvitations.accountId, n: count() })
    .from(accountInvitations)
    .where(
      and(
        inArray(accountInvitations.accountId, ids),
        isNull(accountInvitations.acceptedAt),
        isNull(accountInvitations.revokedAt),
        gt(accountInvitations.expiresAt, sql`now()`),
      ),
    )
    .groupBy(accountInvitations.accountId);

  return rows.map((account) => {
    const counts: RoleCounts = { admin: 0, member: 0, viewer: 0, guest: 0 };
    for (const m of members) if (m.accountId === account.id) counts[m.role] = Number(m.n);
    const pendingInvitations = Number(invites.find((i) => i.accountId === account.id)?.n ?? 0);
    return { account, ...counts, pendingInvitations };
  });
};
