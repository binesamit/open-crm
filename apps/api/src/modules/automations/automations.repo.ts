// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, gte, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountMembers, activityLog, automationRuns, automations } from '../../db/schema';

export type AutomationRow = typeof automations.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;

/** Active automations listening on these boards (a board and its parent, for sub-board events). */
export const activeAutomationsOn = (db: Db, accountId: string, boardIds: string[]) =>
  boardIds.length
    ? db
        .select()
        .from(automations)
        .where(
          and(
            eq(automations.accountId, accountId),
            inArray(automations.boardId, boardIds),
            eq(automations.isActive, true),
            isNull(automations.deletedAt),
          ),
        )
    : Promise.resolve([] as AutomationRow[]);

export const findAutomation = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(automations)
      .where(and(eq(automations.accountId, accountId), eq(automations.id, id), isNull(automations.deletedAt)))
      .limit(1)
  )[0];

/** One activity row by id (the dispatcher's input). */
export const findActivity = async (db: Db, id: string) =>
  (await db.select().from(activityLog).where(eq(activityLog.id, id)).limit(1))[0];

/** Idempotent (04 §5.5): one run per (automation, event); a redelivered dispatch inserts nothing. */
export const insertRun = async (db: Db, row: typeof automationRuns.$inferInsert) =>
  (await db.insert(automationRuns).values(row).onConflictDoNothing().returning({ id: automationRuns.id }))[0]?.id ??
  null;

export const findRun = async (db: Db, id: string) =>
  (await db.select().from(automationRuns).where(eq(automationRuns.id, id)).limit(1))[0];

/** pending → running, once: a second worker (or a retried job) gets null and leaves the run alone. */
export const claimRun = async (db: Db, id: string) =>
  (
    await db
      .update(automationRuns)
      .set({ status: 'running', startedAt: new Date() })
      .where(and(eq(automationRuns.id, id), eq(automationRuns.status, 'pending')))
      .returning()
  )[0] ?? null;

export const finishRun = (
  db: Db,
  id: string,
  set: Pick<AutomationRunRow, 'status'> & Partial<Pick<AutomationRunRow, 'error' | 'actionsLog' | 'skipReason'>>,
) =>
  db
    .update(automationRuns)
    .set({ ...set, finishedAt: new Date() })
    .where(eq(automationRuns.id, id));

/** A run stays `running` this long before the tick gives up on it (a process that died mid-run). */
export const STALE_RUN_MS = 15 * 60_000;

/**
 * Runs claimed before `since` and never finished — the worker died mid-run — end as failed (`error: stale`), so
 * nothing shows as running forever and the retried job (which finds no `pending` row) is not the only hope
 * (audit 2026-10-10, automations #3). The schedule tick calls it every minute.
 */
export const failStaleRuns = (db: Db, since: Date) =>
  db
    .update(automationRuns)
    .set({ status: 'failed', error: 'stale', finishedAt: new Date() })
    .where(and(eq(automationRuns.status, 'running'), lt(automationRuns.startedAt, since)))
    .returning({ id: automationRuns.id, automationId: automationRuns.automationId });

/** The same automation ran on this item since `since` (self re-trigger guard, 04 §5.4). */
export const ranRecently = async (db: Db, automationId: string, itemId: string, since: Date, exceptRunId: string) =>
  !!(
    await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.itemId, itemId),
          gte(automationRuns.createdAt, since),
          ne(automationRuns.id, exceptRunId),
          inArray(automationRuns.status, ['running', 'succeeded', 'partial', 'failed']),
        ),
      )
      .limit(1)
  )[0];

/** How many runs of the automation on this item were made since `since` (the per-minute brake). */
export const runsSince = async (db: Db, automationId: string, itemId: string, since: Date, exceptRunId: string) =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.automationId, automationId),
          eq(automationRuns.itemId, itemId),
          gte(automationRuns.createdAt, since),
          ne(automationRuns.id, exceptRunId),
          inArray(automationRuns.status, ['running', 'succeeded', 'partial', 'failed']),
        ),
      )
  )[0]?.n ?? 0;

export const MAX_CONSECUTIVE_ERRORS = 20;

/** Denormalized stats (04 §1.3) and the auto-deactivation after 20 errored runs in a row (04 §5.7). */
export const recordRunOutcome = async (db: Db, id: string, outcome: 'ok' | 'error') => {
  const now = new Date();
  if (outcome === 'ok') {
    await db
      .update(automations)
      .set({ runCount: sql`${automations.runCount} + 1`, lastRunAt: now, consecutiveErrors: 0 })
      .where(eq(automations.id, id));
    return { deactivated: false };
  }
  const row = (
    await db
      .update(automations)
      .set({
        runCount: sql`${automations.runCount} + 1`,
        lastRunAt: now,
        lastErrorAt: now,
        consecutiveErrors: sql`${automations.consecutiveErrors} + 1`,
      })
      .where(eq(automations.id, id))
      .returning({ errors: automations.consecutiveErrors })
  )[0];
  if (row && row.errors >= MAX_CONSECUTIVE_ERRORS) {
    await deactivateAutomation(db, id, 'too_many_errors');
    return { deactivated: true };
  }
  return { deactivated: false };
};

export const deactivateAutomation = (db: Db, id: string, reason: string) =>
  db
    .update(automations)
    .set({ isActive: false, deactivatedReason: reason.slice(0, 160), updatedAt: new Date() })
    .where(eq(automations.id, id));

export const runsOf = (db: Db, automationId: string, limit = 50) =>
  db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(limit);

/**
 * Emails this account's automations sent since `since` (the recipients of `send_email` actions that ran ok, from
 * the runs' logs) — the daily budget of audit 2026-10-10 #1. Approximate by design: a run in progress is not counted.
 */
export const automationEmailsSentSince = async (db: Db, accountId: string, since: Date) => {
  const [row] = await db
    .select({
      n: sql<number>`coalesce(sum((
        select coalesce(sum((e->'output'->>'recipients')::int), 0) from jsonb_array_elements(${automationRuns.actionsLog}) e
        where e->>'type' = 'send_email' and e->>'status' = 'ok'
      )), 0)::int`,
    })
    .from(automationRuns)
    .where(and(eq(automationRuns.accountId, accountId), gte(automationRuns.createdAt, since)));
  return row?.n ?? 0;
};

/** Of these user ids, those that are active members of the account (an automation mails / notifies no one else). */
export const activeMemberIds = async (db: Db, accountId: string, userIds: string[]) => {
  if (!userIds.length) return new Set<string>();
  const rows = await db
    .select({ id: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.status, 'active'),
        inArray(accountMembers.userId, userIds),
      ),
    );
  return new Set(rows.map((r) => r.id));
};
