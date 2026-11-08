// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, gte, ilike, inArray, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { type ErrorSeverity, type ErrorSource, type ErrorStatus, newId } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  accountMembers,
  accounts,
  agentRunSteps,
  automationRuns,
  errorAlerts,
  errorEventHours,
  errorEvents,
  supportTickets,
  users,
} from '../../db/schema';

/** Errors hub: every query of `error_events`, its hourly counts and the fired alerts. */
export type ErrorEventRow = typeof errorEvents.$inferSelect;
export type ErrorAlertRow = typeof errorAlerts.$inferSelect;

/** One distinct error of a flush, already redacted and fingerprinted, with its occurrences per hour. */
export type PendingError = {
  fingerprint: string;
  accountId: string | null;
  source: ErrorSource;
  code: string;
  severity: ErrorSeverity;
  message: string;
  links: Record<string, string>;
  count: number;
  firstAt: Date;
  lastAt: Date;
  hours: Map<number, number>;
};

const SEVERITY_ORDER = sql`array['info','warning','error','critical']::text[]`;

/**
 * One flush: an upsert per distinct error (count += n, last seen moves, the highest severity stays, the newest
 * message and links win; a resolved row that happens again reopens), then the hourly counts.
 */
export const writeErrorBatch = async (db: Db, batch: PendingError[]) => {
  if (!batch.length) return [];
  const now = new Date();
  const rows = await db
    .insert(errorEvents)
    .values(
      batch.map((e) => ({
        id: newId(),
        fingerprint: e.fingerprint,
        accountId: e.accountId,
        source: e.source,
        code: e.code.slice(0, 80),
        severity: e.severity,
        message: e.message,
        links: e.links,
        count: e.count,
        firstSeenAt: e.firstAt,
        lastSeenAt: e.lastAt,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoUpdate({
      target: errorEvents.fingerprint,
      set: {
        count: sql`${errorEvents.count} + excluded.count`,
        lastSeenAt: sql`greatest(${errorEvents.lastSeenAt}, excluded.last_seen_at)`,
        severity: sql`case when array_position(${SEVERITY_ORDER}, excluded.severity::text) > array_position(${SEVERITY_ORDER}, ${errorEvents.severity}::text) then excluded.severity else ${errorEvents.severity} end`,
        message: sql`excluded.message`,
        links: sql`${errorEvents.links} || excluded.links`,
        status: sql`case when ${errorEvents.status} = 'resolved' then 'new' else ${errorEvents.status} end`,
        reopenedCount: sql`${errorEvents.reopenedCount} + case when ${errorEvents.status} = 'resolved' then 1 else 0 end`,
        resolvedAt: sql`case when ${errorEvents.status} = 'resolved' then null else ${errorEvents.resolvedAt} end`,
        resolvedBy: sql`case when ${errorEvents.status} = 'resolved' then null else ${errorEvents.resolvedBy} end`,
        updatedAt: now,
      },
    })
    .returning({ id: errorEvents.id, fingerprint: errorEvents.fingerprint });
  const idOf = new Map(rows.map((r) => [r.fingerprint, r.id]));
  const hours = batch.flatMap((e) =>
    [...e.hours].map(([hour, count]) => ({ eventId: idOf.get(e.fingerprint)!, hour: new Date(hour), count })),
  );
  if (hours.length)
    await db
      .insert(errorEventHours)
      .values(hours)
      .onConflictDoUpdate({
        target: [errorEventHours.eventId, errorEventHours.hour],
        set: { count: sql`${errorEventHours.count} + excluded.count` },
      });
  return rows;
};

// ---- reading ----

const lastHourSql = (since: Date) =>
  sql<number>`coalesce((select sum(h.count) from ${errorEventHours} h where h.event_id = ${errorEvents.id} and h.hour >= ${since.toISOString()}::timestamptz), 0)::int`;

export type ErrorQuery = {
  sources?: string[];
  severities?: string[];
  statuses?: string[];
  accountId?: string | null;
  /** A user id, or `none`. */
  assignee?: string;
  q?: string;
  view: 'all' | 'recurring' | 'spikes';
  spike?: { factor: number; minCount: number };
  limit: number;
  offset: number;
  now: Date;
};

const hourStart = (d: Date) => new Date(Math.floor(d.getTime() / 3_600_000) * 3_600_000);

const whereOf = (f: ErrorQuery): SQL | undefined => {
  const parts: (SQL | undefined)[] = [];
  if (f.sources?.length) parts.push(inArray(errorEvents.source, f.sources));
  if (f.severities?.length) parts.push(inArray(errorEvents.severity, f.severities));
  if (f.statuses?.length) parts.push(inArray(errorEvents.status, f.statuses));
  if (f.accountId) parts.push(eq(errorEvents.accountId, f.accountId));
  if (f.assignee === 'none') parts.push(isNull(errorEvents.assigneeId));
  else if (f.assignee) parts.push(eq(errorEvents.assigneeId, f.assignee));
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_\\]/g, '\\$&')}%`;
    parts.push(or(ilike(errorEvents.message, like), ilike(errorEvents.code, like)));
  }
  return parts.length ? and(...parts) : undefined;
};

/** The console's list: newest first, the most frequent ("recurring"), or what jumped in the last hour ("spikes"). */
export const queryErrors = async (db: Db, f: ErrorQuery) => {
  const since = hourStart(new Date(f.now.getTime() - 3_600_000));
  const lastHour = lastHourSql(since);
  const dayBefore = new Date(since.getTime() - 24 * 3_600_000);
  const dayAvg = sql<number>`coalesce((select sum(h.count) from ${errorEventHours} h where h.event_id = ${errorEvents.id} and h.hour >= ${dayBefore.toISOString()}::timestamptz and h.hour < ${since.toISOString()}::timestamptz), 0)::float / 24`;
  const extra =
    f.view === 'spikes' && f.spike
      ? sql`${lastHour} >= ${f.spike.minCount} and ${lastHour} >= ${f.spike.factor} * ${dayAvg}`
      : undefined;
  const where = and(whereOf(f), extra);
  const order =
    f.view === 'recurring' ? [desc(errorEvents.count), desc(errorEvents.lastSeenAt)] : [desc(errorEvents.lastSeenAt)];
  const rows = await db
    .select({
      e: errorEvents,
      lastHour,
      accountName: accounts.name,
      accountSlug: accounts.slug,
      assigneeName: users.name,
      assigneeEmail: users.email,
      ticketNumber: supportTickets.number,
    })
    .from(errorEvents)
    .leftJoin(accounts, eq(accounts.id, errorEvents.accountId))
    .leftJoin(users, eq(users.id, errorEvents.assigneeId))
    .leftJoin(supportTickets, eq(supportTickets.id, errorEvents.ticketId))
    .where(where)
    .orderBy(...(f.view === 'spikes' ? [desc(lastHour), desc(errorEvents.lastSeenAt)] : order))
    .limit(f.limit)
    .offset(f.offset);
  const [{ total }] = (await db
    .select({ total: sql<number>`count(*)::int` })
    .from(errorEvents)
    .where(where)) as [{ total: number }];
  return { rows, total };
};
export type ErrorListRow = Awaited<ReturnType<typeof queryErrors>>['rows'][number];

export const findErrorRow = async (db: Db, id: string, now: Date) =>
  (
    await db
      .select({
        e: errorEvents,
        lastHour: lastHourSql(hourStart(new Date(now.getTime() - 3_600_000))),
        accountName: accounts.name,
        accountSlug: accounts.slug,
        assigneeName: users.name,
        assigneeEmail: users.email,
        ticketNumber: supportTickets.number,
      })
      .from(errorEvents)
      .leftJoin(accounts, eq(accounts.id, errorEvents.accountId))
      .leftJoin(users, eq(users.id, errorEvents.assigneeId))
      .leftJoin(supportTickets, eq(supportTickets.id, errorEvents.ticketId))
      .where(eq(errorEvents.id, id))
      .limit(1)
  )[0];

export const findErrorEvent = async (db: Db, id: string) =>
  (await db.select().from(errorEvents).where(eq(errorEvents.id, id)).limit(1))[0];

/** Occurrences per hour since `since` (oldest first). */
export const hourlyOf = (db: Db, eventId: string, since: Date) =>
  db
    .select({ hour: errorEventHours.hour, count: errorEventHours.count })
    .from(errorEventHours)
    .where(and(eq(errorEventHours.eventId, eventId), gte(errorEventHours.hour, since)))
    .orderBy(asc(errorEventHours.hour));

/** Per account: open errors, critical open ones, occurrences in the last 24 hours, last seen. */
export const errorsByAccount = (db: Db, now: Date) => {
  const day = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  return db
    .select({
      accountId: errorEvents.accountId,
      accountName: accounts.name,
      accountSlug: accounts.slug,
      open: sql<number>`count(*) filter (where ${errorEvents.status} in ('new','acknowledged'))::int`,
      critical: sql<number>`count(*) filter (where ${errorEvents.status} in ('new','acknowledged') and ${errorEvents.severity} = 'critical')::int`,
      day: sql<number>`coalesce(sum((select sum(h.count) from ${errorEventHours} h where h.event_id = ${errorEvents.id} and h.hour >= ${day}::timestamptz)), 0)::int`,
      lastSeen: sql<Date | null>`max(${errorEvents.lastSeenAt})`,
    })
    .from(errorEvents)
    .leftJoin(accounts, eq(accounts.id, errorEvents.accountId))
    .groupBy(errorEvents.accountId, accounts.name, accounts.slug)
    .orderBy(
      desc(sql`count(*) filter (where ${errorEvents.status} in ('new','acknowledged'))`),
      desc(sql`max(${errorEvents.lastSeenAt})`),
    );
};

export const updateErrorRow = (db: Db, id: string, patch: Partial<typeof errorEvents.$inferInsert>) =>
  db
    .update(errorEvents)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(errorEvents.id, id));

/** The account's own errors (its Health page), visible sources only. */
export const accountErrors = (
  db: Db,
  accountId: string,
  f: { sources: string[]; statuses?: string[]; limit: number },
) =>
  db
    .select()
    .from(errorEvents)
    .where(
      and(
        eq(errorEvents.accountId, accountId),
        inArray(errorEvents.source, f.sources.length ? f.sources : ['-']),
        f.statuses ? inArray(errorEvents.status, f.statuses) : sql`${errorEvents.status} <> 'ignored'`,
      ),
    )
    .orderBy(desc(errorEvents.lastSeenAt))
    .limit(f.limit);

export const accountOccurrencesSince = async (db: Db, accountId: string, sources: string[], since: Date) =>
  (
    (await db
      .select({ n: sql<number>`coalesce(sum(${errorEventHours.count}), 0)::int` })
      .from(errorEventHours)
      .innerJoin(errorEvents, eq(errorEvents.id, errorEventHours.eventId))
      .where(
        and(
          eq(errorEvents.accountId, accountId),
          inArray(errorEvents.source, sources.length ? sources : ['-']),
          sql`${errorEvents.status} <> 'ignored'`,
          gte(errorEventHours.hour, since),
        ),
      )) as [{ n: number }]
  )[0].n;

// ---- the trace of a run (types, statuses, codes — never values) ----

export const automationRunLog = async (db: Db, accountId: string, runId: string) =>
  (
    await db
      .select({ log: automationRuns.actionsLog, status: automationRuns.status, skipReason: automationRuns.skipReason })
      .from(automationRuns)
      .where(and(eq(automationRuns.id, runId), eq(automationRuns.accountId, accountId)))
      .limit(1)
  )[0];

export const agentRunTrace = (db: Db, runId: string) =>
  db
    .select({
      index: agentRunSteps.seq,
      kind: agentRunSteps.kind,
      tool: agentRunSteps.tool,
      outcome: agentRunSteps.outcome,
      isError: agentRunSteps.isError,
    })
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(asc(agentRunSteps.seq))
    .limit(100);

// ---- maintenance ----

/** Open errors quiet for `hours` resolve themselves (`resolved_by` null). */
export const autoResolveQuiet = async (db: Db, now: Date, hours: number) => {
  if (hours <= 0) return 0;
  const rows = await db
    .update(errorEvents)
    .set({ status: 'resolved', resolvedAt: now, resolvedBy: null, updatedAt: now })
    .where(
      and(
        inArray(errorEvents.status, ['new', 'acknowledged']),
        lt(errorEvents.lastSeenAt, new Date(now.getTime() - hours * 3_600_000)),
      ),
    )
    .returning({ id: errorEvents.id });
  return rows.length;
};

/** Rows not seen for their severity's retention go; hourly counts older than the longest window too. */
export const purgeExpired = async (db: Db, now: Date, days: Record<ErrorSeverity, number>, keepHoursDays: number) => {
  let purged = 0;
  for (const [severity, d] of Object.entries(days))
    purged += (
      await db
        .delete(errorEvents)
        .where(
          and(eq(errorEvents.severity, severity), lt(errorEvents.lastSeenAt, new Date(now.getTime() - d * 86_400_000))),
        )
        .returning({ id: errorEvents.id })
    ).length;
  await db
    .delete(errorEventHours)
    .where(lt(errorEventHours.hour, new Date(now.getTime() - keepHoursDays * 86_400_000)));
  const longest = Math.max(...Object.values(days));
  await db.delete(errorAlerts).where(lt(errorAlerts.createdAt, new Date(now.getTime() - longest * 86_400_000)));
  return purged;
};

// ---- alerts ----

/** Open, unmuted errors with at least `threshold` occurrences since `since` (rule filters applied). */
export const errorsOverThreshold = (
  db: Db,
  f: {
    since: Date;
    threshold: number;
    sources: string[];
    severities: string[];
    accountId: string | null;
    statuses: ErrorStatus[];
    now: Date;
  },
) => {
  const occurrences = sql<number>`coalesce((select sum(h.count) from ${errorEventHours} h where h.event_id = ${errorEvents.id} and h.hour >= ${f.since.toISOString()}::timestamptz), 0)::int`;
  return db
    .select({ e: errorEvents, occurrences, accountName: accounts.name })
    .from(errorEvents)
    .leftJoin(accounts, eq(accounts.id, errorEvents.accountId))
    .where(
      and(
        inArray(errorEvents.status, f.statuses),
        f.sources.length ? inArray(errorEvents.source, f.sources) : undefined,
        inArray(errorEvents.severity, f.severities),
        f.accountId ? eq(errorEvents.accountId, f.accountId) : undefined,
        or(isNull(errorEvents.mutedUntil), lt(errorEvents.mutedUntil, f.now)),
        sql`${occurrences} >= ${f.threshold}`,
      ),
    )
    .orderBy(desc(occurrences))
    .limit(200);
};

/** Was this rule already fired for this event (or this key) since `since`? */
export const alertedSince = async (db: Db, key: string, since: Date) =>
  !!(
    await db
      .select({ id: errorAlerts.id })
      .from(errorAlerts)
      .where(and(eq(errorAlerts.dedupeKey, key), gte(errorAlerts.createdAt, since)))
      .limit(1)
  )[0];

export const insertAlert = async (db: Db, row: Omit<typeof errorAlerts.$inferInsert, 'id'>) => {
  const id = newId();
  await db.insert(errorAlerts).values({ ...row, id });
  return id;
};

/** The console's bell: alerts sent to me, newest first. */
export const alertsFor = (db: Db, userId: string, limit: number) =>
  db
    .select()
    .from(errorAlerts)
    .where(sql`${errorAlerts.recipients} @> ${JSON.stringify([userId])}::jsonb`)
    .orderBy(desc(errorAlerts.createdAt))
    .limit(limit);

export const unreadAlertCount = async (db: Db, userId: string) =>
  (
    (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(errorAlerts)
      .where(
        and(
          sql`${errorAlerts.recipients} @> ${JSON.stringify([userId])}::jsonb`,
          sql`not (${errorAlerts.readBy} @> ${JSON.stringify([userId])}::jsonb)`,
        ),
      )) as [{ n: number }]
  )[0].n;

export const markAlertsRead = (db: Db, userId: string) =>
  db
    .update(errorAlerts)
    .set({ readBy: sql`${errorAlerts.readBy} || ${JSON.stringify([userId])}::jsonb` })
    .where(
      and(
        sql`${errorAlerts.recipients} @> ${JSON.stringify([userId])}::jsonb`,
        sql`not (${errorAlerts.readBy} @> ${JSON.stringify([userId])}::jsonb)`,
      ),
    );

export const eventsByIds = (db: Db, ids: string[]) =>
  ids.length
    ? db
        .select({ e: errorEvents, accountName: accounts.name })
        .from(errorEvents)
        .leftJoin(accounts, eq(accounts.id, errorEvents.accountId))
        .where(inArray(errorEvents.id, ids))
    : Promise.resolve([]);

export const platformOwners = (db: Db) =>
  db
    .select({ id: users.id, name: users.name, email: users.email, locale: users.locale })
    .from(users)
    .where(eq(users.isPlatformOwner, true));

export const accountList = (db: Db) =>
  db.select({ id: accounts.id, name: accounts.name, slug: accounts.slug }).from(accounts).orderBy(asc(accounts.name));

export const activeAdminIds = async (db: Db, accountId: string) =>
  (
    await db
      .select({ id: accountMembers.userId })
      .from(accountMembers)
      .innerJoin(users, eq(users.id, accountMembers.userId))
      .where(
        and(
          eq(accountMembers.accountId, accountId),
          eq(accountMembers.role, 'admin'),
          eq(accountMembers.status, 'active'),
          eq(users.isService, false),
        ),
      )
  ).map((r) => r.id);

export const findTicketByNumber = async (db: Db, number: number) =>
  (
    await db
      .select()
      .from(supportTickets)
      .where(and(eq(supportTickets.number, number), isNull(supportTickets.deletedAt)))
      .limit(1)
  )[0];
