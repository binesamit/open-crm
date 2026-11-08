// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  accountMembers,
  accounts,
  accountSubscriptions,
  costEntries,
  costFxRates,
  costPrices,
  costSources,
  type CostSourceRow,
  planVersions,
  plans,
  users,
} from '../../db/schema';
import type { CostRecord } from './adapters';

/** Database access of the costs module. Platform-wide tables: no account filter applies. */

// ---------------------------------------------------------------- sources

export const listSourceRows = (db: Db) =>
  db.select().from(costSources).where(isNull(costSources.deletedAt)).orderBy(asc(costSources.createdAt));

export const findSourceRow = async (db: Db, id: string) =>
  (
    await db
      .select()
      .from(costSources)
      .where(and(eq(costSources.id, id), isNull(costSources.deletedAt)))
      .limit(1)
  )[0];

export const insertSourceRow = async (db: Db, row: typeof costSources.$inferInsert) =>
  (await db.insert(costSources).values(row).returning())[0]!;

export const updateSourceRow = async (db: Db, id: string, patch: Partial<typeof costSources.$inferInsert>) =>
  (
    await db
      .update(costSources)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(costSources.id, id))
      .returning()
  )[0];

// ---------------------------------------------------------------- entries

/** Replaces a source's rows for [from, to] with what it read. */
export const replaceEntries = (db: Db, sourceId: string, from: string, to: string, records: CostRecord[]) =>
  db.transaction(async (tx) => {
    await tx
      .delete(costEntries)
      .where(and(eq(costEntries.sourceId, sourceId), gte(costEntries.day, from), lte(costEntries.day, to)));
    const now = new Date();
    for (let i = 0; i < records.length; i += 1000)
      await tx.insert(costEntries).values(
        records.slice(i, i + 1000).map((r) => ({
          sourceId,
          day: r.day,
          metric: r.metric,
          service: r.service,
          accountRef: r.accountRef ?? '',
          quantity: r.quantity,
          unit: r.unit,
          amount: r.amount ?? null,
          cost: r.amount ?? null,
          currency: r.amount !== undefined ? (r.currency ?? null) : null,
          syncedAt: now,
        })),
      );
  });

/** A source's money on the days of a month before `day` (a month-to-date source's earlier days). */
export const amountBefore = async (db: Db, sourceId: string, monthStart: string, day: string) =>
  Number(
    (
      await db
        .select({ v: sql<number>`coalesce(sum(${costEntries.amount}), 0)::float8` })
        .from(costEntries)
        .where(and(eq(costEntries.sourceId, sourceId), gte(costEntries.day, monthStart), lt(costEntries.day, day)))
    )[0]?.v ?? 0,
  );

/** The priced rows (quantities) of [from, to], every source — what a price change recomputes. */
export const quantityRows = (db: Db, from: string, to: string, metrics?: string[]) =>
  db
    .select({
      sourceId: costEntries.sourceId,
      day: sql<string>`${costEntries.day}::text`,
      metric: costEntries.metric,
      service: costEntries.service,
      accountRef: costEntries.accountRef,
      quantity: costEntries.quantity,
    })
    .from(costEntries)
    .where(
      and(
        isNull(costEntries.amount),
        gte(costEntries.day, from),
        lte(costEntries.day, to),
        metrics?.length ? inArray(costEntries.metric, metrics) : undefined,
      ),
    );

/** Writes the computed cost of many rows at once (a JSON recordset, one statement). */
export const writeCosts = async (
  db: Db,
  rows: {
    source_id: string;
    day: string;
    metric: string;
    service: string;
    account_ref: string;
    cost: number | null;
    currency: string | null;
  }[],
) => {
  for (let i = 0; i < rows.length; i += 2000) {
    const chunk = JSON.stringify(rows.slice(i, i + 2000));
    await db.execute(sql`
      update cost_entries e set cost = v.cost, currency = v.currency
      from jsonb_to_recordset(${chunk}::jsonb)
        as v(source_id text, day date, metric text, service text, account_ref text, cost float8, currency text)
      where e.source_id = v.source_id and e.day = v.day and e.metric = v.metric and e.service = v.service
        and e.account_ref = v.account_ref and e.amount is null`);
  }
};

/** The months that hold rows of these metrics (what a price change reprices). */
export const monthsWithMetric = async (db: Db, metric: string) =>
  (
    await db
      .selectDistinct({ m: sql<string>`to_char(${costEntries.day}, 'YYYY-MM')` })
      .from(costEntries)
      .where(and(eq(costEntries.metric, metric), isNull(costEntries.amount)))
  ).map((r) => r.m);

/** Rows of [from, to] of live sources, summed per day × source × service × metric × account × currency. */
export const entriesBetween = (db: Db, from: string, to: string) =>
  db
    .select({
      day: sql<string>`${costEntries.day}::text`,
      sourceId: costEntries.sourceId,
      service: costEntries.service,
      metric: costEntries.metric,
      unit: costEntries.unit,
      accountRef: costEntries.accountRef,
      currency: costEntries.currency,
      quantity: sql<number>`sum(${costEntries.quantity})::float8`,
      cost: sql<number>`coalesce(sum(${costEntries.cost}), 0)::float8`,
      unpriced: sql<boolean>`bool_or(${costEntries.cost} is null)`,
    })
    .from(costEntries)
    .innerJoin(costSources, eq(costSources.id, costEntries.sourceId))
    .where(and(isNull(costSources.deletedAt), gte(costEntries.day, from), lte(costEntries.day, to)))
    .groupBy(
      costEntries.day,
      costEntries.sourceId,
      costEntries.service,
      costEntries.metric,
      costEntries.unit,
      costEntries.accountRef,
      costEntries.currency,
    );

/** Currencies the rows and prices are in (what the exchange rates must cover). */
export const currenciesInUse = async (db: Db) => {
  const a = await db
    .selectDistinct({ c: costEntries.currency })
    .from(costEntries)
    .where(sql`${costEntries.currency} is not null`);
  const b = await db.selectDistinct({ c: costPrices.currency }).from(costPrices);
  return [...new Set([...a, ...b].map((r) => r.c).filter((c): c is string => !!c))];
};

// ---------------------------------------------------------------- prices

export const listPriceRows = (db: Db) =>
  db.select().from(costPrices).orderBy(asc(costPrices.metric), asc(costPrices.service), asc(costPrices.effectiveFrom));

export const findPriceRow = async (db: Db, id: string) =>
  (await db.select().from(costPrices).where(eq(costPrices.id, id)).limit(1))[0];

export const insertPriceRow = (db: Db, row: typeof costPrices.$inferInsert) =>
  db.insert(costPrices).values(row).onConflictDoNothing().returning();

export const updatePriceRow = (db: Db, id: string, patch: Partial<typeof costPrices.$inferInsert>) =>
  db
    .update(costPrices)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(costPrices.id, id))
    .returning();

export const deletePriceRow = (db: Db, id: string) => db.delete(costPrices).where(eq(costPrices.id, id)).returning();

// ---------------------------------------------------------------- exchange rates

export const ratesFor = (db: Db, quote: string) =>
  db
    .select({ day: sql<string>`${costFxRates.day}::text`, currency: costFxRates.currency, rate: costFxRates.rate })
    .from(costFxRates)
    .where(eq(costFxRates.quote, quote))
    .orderBy(asc(costFxRates.day));

export const saveRates = async (db: Db, day: string, quote: string, source: string, rates: Record<string, number>) => {
  const rows = Object.entries(rates).map(([currency, rate]) => ({ day, currency, quote, rate, source }));
  if (!rows.length) return;
  await db
    .insert(costFxRates)
    .values(rows)
    .onConflictDoUpdate({
      target: [costFxRates.day, costFxRates.currency, costFxRates.quote],
      set: { rate: sql`excluded.rate`, source: sql`excluded.source` },
    });
};

// ---------------------------------------------------------------- accounts (the per-account report)

/** Live accounts with their active member count and current plan's price. */
export const accountsWithPlans = async (db: Db) => {
  const rows = await db
    .select({
      id: accounts.id,
      name: accounts.name,
      seats: sql<number>`(select count(*)::int from ${accountMembers} m where m.account_id = ${accounts.id} and m.status = 'active')`,
      status: accountSubscriptions.status,
      interval: accountSubscriptions.interval,
      subSeats: accountSubscriptions.seats,
      planName: plans.name,
      monthly: planVersions.priceMonthlyMinor,
      yearly: planVersions.priceYearlyMinor,
      currency: planVersions.currency,
      pricing: planVersions.pricing,
    })
    .from(accounts)
    .leftJoin(
      accountSubscriptions,
      and(eq(accountSubscriptions.accountId, accounts.id), isNull(accountSubscriptions.endedAt)),
    )
    .leftJoin(planVersions, eq(planVersions.id, accountSubscriptions.planVersionId))
    .leftJoin(plans, eq(plans.id, planVersions.planId))
    .where(isNull(accounts.deletedAt))
    .orderBy(asc(accounts.name));
  return rows;
};

/** Platform owners' addresses (the alert emails). */
export const ownerEmails = (db: Db) =>
  db
    .select({ email: users.email, locale: users.locale })
    .from(users)
    .where(and(eq(users.isPlatformOwner, true), eq(users.isService, false)));

export type { CostSourceRow };
