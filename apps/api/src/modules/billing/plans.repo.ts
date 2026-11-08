// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, desc, eq, gt, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  accountInvitations,
  accountMembers,
  accounts,
  accountSubscriptions,
  accountUsageCounters,
  assets,
  boards,
  items,
  plans,
  planVersions,
  users,
} from '../../db/schema';

/** Plans: the owner's plans and versions, subscriptions, usage counts and counters. */

export type PlanRow = typeof plans.$inferSelect;
export type PlanVersionRow = typeof planVersions.$inferSelect;
export type SubscriptionRow = typeof accountSubscriptions.$inferSelect;
export type SubscriptionWithPlan = SubscriptionRow & { version: PlanVersionRow; plan: PlanRow };

const n = (v: unknown) => Number(v ?? 0);

// ---- plans & versions ----

export const listPlanRows = (db: Db) => db.select().from(plans).orderBy(asc(plans.sort), asc(plans.createdAt));
export const findPlanRow = async (db: Db, id: string) =>
  (await db.select().from(plans).where(eq(plans.id, id)).limit(1))[0];
export const insertPlanRow = (db: Db, row: typeof plans.$inferInsert) => db.insert(plans).values(row);
export const updatePlanRow = (db: Db, id: string, patch: Partial<typeof plans.$inferInsert>) =>
  db
    .update(plans)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(plans.id, id));
export const deletePlanRow = (db: Db, id: string) => db.delete(plans).where(eq(plans.id, id));

export const listVersionRows = (db: Db) =>
  db.select().from(planVersions).orderBy(asc(planVersions.planId), asc(planVersions.version));
export const findVersionRow = async (db: Db, id: string) =>
  (await db.select().from(planVersions).where(eq(planVersions.id, id)).limit(1))[0];
export const insertVersionRow = (db: Db, row: typeof planVersions.$inferInsert) => db.insert(planVersions).values(row);
export const updateVersionRow = (db: Db, id: string, patch: Partial<typeof planVersions.$inferInsert>) =>
  db.update(planVersions).set(patch).where(eq(planVersions.id, id));
export const nextVersionNumber = async (db: Db, planId: string) =>
  n(
    (
      await db
        .select({ v: sql<number>`coalesce(max(${planVersions.version}), 0)` })
        .from(planVersions)
        .where(eq(planVersions.planId, planId))
    )[0]?.v,
  ) + 1;

/** Per version: subscriptions on it now, and whether any subscription (ever) used it. */
export const versionUseCounts = async (db: Db) => {
  const rows = await db
    .select({
      versionId: accountSubscriptions.planVersionId,
      current: sql<number>`count(*) filter (where ${accountSubscriptions.endedAt} is null)`,
      ever: count(),
    })
    .from(accountSubscriptions)
    .groupBy(accountSubscriptions.planVersionId);
  return new Map(rows.map((r) => [r.versionId, { current: n(r.current), ever: n(r.ever) }]));
};
export const versionEverUsed = async (db: Db, versionId: string) =>
  (
    await db
      .select({ id: accountSubscriptions.id })
      .from(accountSubscriptions)
      .where(eq(accountSubscriptions.planVersionId, versionId))
      .limit(1)
  ).length > 0;
export const planEverUsed = async (db: Db, planId: string) =>
  (
    await db
      .select({ id: accountSubscriptions.id })
      .from(accountSubscriptions)
      .innerJoin(planVersions, eq(planVersions.id, accountSubscriptions.planVersionId))
      .where(eq(planVersions.planId, planId))
      .limit(1)
  ).length > 0;

// ---- subscriptions ----

const withPlan = (db: Db) =>
  db
    .select({ s: accountSubscriptions, version: planVersions, plan: plans })
    .from(accountSubscriptions)
    .innerJoin(planVersions, eq(planVersions.id, accountSubscriptions.planVersionId))
    .innerJoin(plans, eq(plans.id, planVersions.planId));

const flat = (r: { s: SubscriptionRow; version: PlanVersionRow; plan: PlanRow }): SubscriptionWithPlan => ({
  ...r.s,
  version: r.version,
  plan: r.plan,
});

export const currentSubscription = async (db: Db, accountId: string) => {
  const r = (
    await withPlan(db)
      .where(and(eq(accountSubscriptions.accountId, accountId), isNull(accountSubscriptions.endedAt)))
      .limit(1)
  )[0];
  return r ? flat(r) : undefined;
};
/** The current subscription row (no plan) of each of these accounts — or of every account when none are given. */
export const currentSubscriptionRows = (db: Db, accountIds?: string[]) =>
  db
    .select()
    .from(accountSubscriptions)
    .where(
      and(
        isNull(accountSubscriptions.endedAt),
        accountIds ? inArray(accountSubscriptions.accountId, accountIds) : undefined,
      ),
    );
/** The feature list of each account's current plan version (accounts with no subscription are absent). */
export const currentFeatureLists = async (db: Db, accountIds: string[]) => {
  if (!accountIds.length) return new Map<string, string[]>();
  const rows = await db
    .select({ accountId: accountSubscriptions.accountId, features: planVersions.features })
    .from(accountSubscriptions)
    .innerJoin(planVersions, eq(planVersions.id, accountSubscriptions.planVersionId))
    .where(and(isNull(accountSubscriptions.endedAt), inArray(accountSubscriptions.accountId, accountIds)));
  return new Map(rows.map((r) => [r.accountId, Array.isArray(r.features) ? (r.features as string[]) : []]));
};
export const subscriptionHistory = async (db: Db, accountId: string) =>
  (
    await withPlan(db)
      .where(eq(accountSubscriptions.accountId, accountId))
      .orderBy(desc(accountSubscriptions.createdAt), desc(accountSubscriptions.id))
      .limit(100)
  ).map(flat);
/** The current subscription a provider knows by its reference (webhooks). */
export const subscriptionByProviderRef = async (db: Db, provider: string, externalId: string) =>
  (
    await db
      .select()
      .from(accountSubscriptions)
      .where(
        and(
          eq(accountSubscriptions.provider, provider),
          eq(accountSubscriptions.externalId, externalId),
          isNull(accountSubscriptions.endedAt),
        ),
      )
      .limit(1)
  )[0];
export const allCurrentSubscriptions = async (db: Db) =>
  (await withPlan(db).where(isNull(accountSubscriptions.endedAt))).map(flat);

export const insertSubscription = (db: Db, row: typeof accountSubscriptions.$inferInsert) =>
  db.insert(accountSubscriptions).values(row);
export const updateSubscription = (db: Db, id: string, patch: Partial<typeof accountSubscriptions.$inferInsert>) =>
  db
    .update(accountSubscriptions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(accountSubscriptions.id, id));

// ---- usage (stock) ----

/**
 * Seats: active and invited people of the account (not guests — they are free viewers — and not service
 * identities: tokens, agents, extensions) + pending invitations of non-guests to addresses not in it yet.
 */
export const seatsUsed = async (db: Db, accountId: string) => {
  const members = n(
    (
      await db
        .select({ n: count() })
        .from(accountMembers)
        .innerJoin(users, eq(users.id, accountMembers.userId))
        .where(
          and(
            eq(accountMembers.accountId, accountId),
            inArray(accountMembers.status, ['active', 'invited']),
            ne(accountMembers.role, 'guest'),
            eq(users.isService, false),
          ),
        )
    )[0]?.n,
  );
  const memberEmails = db
    .select({ email: sql`lower(${users.email})` })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(eq(accountMembers.accountId, accountId));
  const pending = n(
    (
      await db
        .select({ n: count() })
        .from(accountInvitations)
        .where(
          and(
            eq(accountInvitations.accountId, accountId),
            isNull(accountInvitations.acceptedAt),
            isNull(accountInvitations.revokedAt),
            gt(accountInvitations.expiresAt, new Date()),
            ne(accountInvitations.role, 'guest'),
            notInArray(sql`lower(${accountInvitations.email})`, memberEmails),
          ),
        )
    )[0]?.n,
  );
  return members + pending;
};

/** Boards: not deleted, not sub-boards (D14 — they belong to their board). Archived ones count. */
export const boardsUsed = async (db: Db, accountId: string) =>
  n(
    (
      await db
        .select({ n: count() })
        .from(boards)
        .where(and(eq(boards.accountId, accountId), isNull(boards.deletedAt), isNull(boards.parentBoardId)))
    )[0]?.n,
  );

/** Items (subitems too): not deleted. Archived ones count. */
export const itemsUsed = async (db: Db, accountId: string) =>
  n(
    (
      await db
        .select({ n: count() })
        .from(items)
        .where(and(eq(items.accountId, accountId), isNull(items.deletedAt)))
    )[0]?.n,
  );

/** Bytes of uploaded, not deleted files (the same sum Administration → Usage shows). */
export const storageBytesUsed = async (db: Db, accountId: string) =>
  n(
    (
      await db
        .select({ bytes: sql<number>`coalesce(sum(${assets.size}), 0)` })
        .from(assets)
        .where(and(eq(assets.accountId, accountId), isNull(assets.deletedAt), eq(assets.uploadStatus, 'uploaded')))
    )[0]?.bytes,
  );

// ---- counters & alert marks ----

export const counterValue = async (db: Db, accountId: string, period: string, kind: string) =>
  n(
    (
      await db
        .select({ v: accountUsageCounters.value })
        .from(accountUsageCounters)
        .where(
          and(
            eq(accountUsageCounters.accountId, accountId),
            eq(accountUsageCounters.period, period),
            eq(accountUsageCounters.kind, kind),
          ),
        )
        .limit(1)
    )[0]?.v,
  );

/** Adds to a consumption counter; returns the new value. */
export const bumpCounter = async (db: Db, accountId: string, period: string, kind: string, delta: number) =>
  n(
    (
      await db
        .insert(accountUsageCounters)
        .values({ accountId, period, kind, value: delta })
        .onConflictDoUpdate({
          target: [accountUsageCounters.accountId, accountUsageCounters.period, accountUsageCounters.kind],
          set: { value: sql`${accountUsageCounters.value} + ${delta}`, updatedAt: new Date() },
        })
        .returning({ v: accountUsageCounters.value })
    )[0]?.v,
  );

/** Marks the warning / reached alert of a period; true only the first time (so it goes out once). */
export const markAlert = async (db: Db, accountId: string, period: string, kind: string, level: 'warn' | 'reached') => {
  await db.insert(accountUsageCounters).values({ accountId, period, kind }).onConflictDoNothing();
  const col = level === 'warn' ? accountUsageCounters.warnedAt : accountUsageCounters.reachedAt;
  const set = level === 'warn' ? { warnedAt: new Date() } : { reachedAt: new Date() };
  const done = await db
    .update(accountUsageCounters)
    .set(set)
    .where(
      and(
        eq(accountUsageCounters.accountId, accountId),
        eq(accountUsageCounters.period, period),
        eq(accountUsageCounters.kind, kind),
        isNull(col),
      ),
    )
    .returning({ kind: accountUsageCounters.kind });
  return done.length > 0;
};

/** is the account's deletion scheduled (`accounts.deletion_due_at` set)? */
export const accountDeletionScheduled = async (db: Db, accountId: string) =>
  (await db.select({ due: accounts.deletionDueAt }).from(accounts).where(eq(accounts.id, accountId)).limit(1))[0]
    ?.due != null;

export const activeAdminIds = async (db: Db, accountId: string) =>
  (
    await db
      .select({ userId: accountMembers.userId })
      .from(accountMembers)
      .innerJoin(users, eq(users.id, accountMembers.userId))
      .where(
        and(
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.status, 'active'),
          eq(accountMembers.role, 'admin'),
          eq(users.isService, false),
        ),
      )
  ).map((r) => r.userId);
