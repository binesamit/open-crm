// SPDX-License-Identifier: AGPL-3.0-only
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accounts, tidyRuns, users } from '../../db/schema';

/**
 * Scheduled cleaning (M8 ד13): the SQL behind each rule. Every rule has a `find` (what it would touch — counts and
 * samples for the dry run) and an apply step. Content rules work in bounded pages so a run never holds a huge lock.
 */
type Rows<T> = { rows: T[] };
const rows = async <T>(db: Db, q: ReturnType<typeof sql>) => ((await db.execute(q)) as unknown as Rows<T>).rows;
const count = async (db: Db, q: ReturnType<typeof sql>) => Number((await rows<{ n: number }>(db, q))[0]?.n ?? 0);

const excluded = (ids: string[]) =>
  ids.length
    ? sql`and b.workspace_id not in (${sql.join(
        ids.map((i) => sql`${i}`),
        sql`, `,
      )})`
    : sql``;

// ---- archive_done_items: top-level items whose status is a "done" label, unchanged that long ----
const doneItemsWhere = (accountId: string, before: Date, exclude: string[]) => sql`
  from items i
  join boards b on b.id = i.board_id
  where i.account_id = ${accountId}
    and i.depth = 0 and i.archived_at is null and i.deleted_at is null
    and b.deleted_at is null and b.archived_at is null and b.parent_board_id is null
    ${excluded(exclude)}
    and exists (
      select 1 from cells c join columns col on col.id = c.column_id
      where c.item_id = i.id and col.type = 'status' and col.deleted_at is null
        and c.updated_at < ${before.toISOString()}::timestamptz
        and exists (
          select 1 from jsonb_array_elements(coalesce(col.settings -> 'labels', '[]'::jsonb)) l
          where (l ->> 'is_done')::boolean is true and (l ->> 'id') = (c.value ->> 'index')
        )
    )`;

export const countDoneItems = (db: Db, accountId: string, before: Date, exclude: string[]) =>
  count(db, sql`select count(*)::int as n ${doneItemsWhere(accountId, before, exclude)}`);

export const doneItems = (db: Db, accountId: string, before: Date, exclude: string[], limit: number) =>
  rows<{ id: string; name: string; board_id: string; group_id: string | null }>(
    db,
    sql`select i.id, i.name, i.board_id, i.group_id ${doneItemsWhere(accountId, before, exclude)}
        order by i.id limit ${limit}`,
  );

export const archiveItemsNow = (db: Db, ids: string[], by: string | null) =>
  db.execute(sql`update items set archived_at = now(), archived_by = ${by}, updated_at = now()
    where id in (${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )}) and archived_at is null and deleted_at is null`);

// ---- archive_idle_boards: nothing changed on the board or its items that long ----
const idleBoardsWhere = (accountId: string, before: Date, exclude: string[]) => sql`
  from boards b
  where b.account_id = ${accountId}
    and b.deleted_at is null and b.archived_at is null and b.parent_board_id is null
    ${excluded(exclude)}
    and b.updated_at < ${before.toISOString()}::timestamptz
    and not exists (
      select 1 from items i where i.board_id = b.id and i.updated_at >= ${before.toISOString()}::timestamptz
    )`;

export const idleBoards = (db: Db, accountId: string, before: Date, exclude: string[], limit: number) =>
  rows<{ id: string; name: string }>(
    db,
    sql`select b.id, b.name ${idleBoardsWhere(accountId, before, exclude)} order by b.id limit ${limit}`,
  );

export const archiveBoardNow = (db: Db, id: string, by: string | null) =>
  db.execute(sql`update boards set archived_at = now(), archived_by = ${by}, updated_at = now()
    where id = ${id} and archived_at is null`);

// ---- empty_trash: entries deleted that long ago become due now (the hourly trash.purge removes them) ----
const trashWhere = (accountId: string, before: Date) => sql`
  from trash_entries t
  where t.account_id = ${accountId} and t.restored_at is null and t.purged_at is null
    and t.parent_entry_id is null
    and t.deleted_at < ${before.toISOString()}::timestamptz and t.purge_after > now()`;

export const countTrash = (db: Db, accountId: string, before: Date) =>
  count(db, sql`select count(*)::int as n ${trashWhere(accountId, before)}`);

export const trashSample = (db: Db, accountId: string, before: Date, limit: number) =>
  rows<{ id: string; name: string; type: string }>(
    db,
    sql`select t.id, t.object_name as name, t.object_type::text as type ${trashWhere(accountId, before)}
        order by t.deleted_at limit ${limit}`,
  );

export const makeTrashDue = async (db: Db, accountId: string, before: Date) =>
  (
    await rows<{ id: string; name: string; type: string }>(
      db,
      sql`update trash_entries t set purge_after = now()
          where t.id in (select t.id ${trashWhere(accountId, before)})
          returning t.id, t.object_name as name, t.object_type::text as type`,
    )
  ).length;

// ---- notifications / activity: plain retention ----
export const countNotifications = (db: Db, accountId: string, before: Date) =>
  count(
    db,
    sql`select count(*)::int as n from notifications
        where account_id = ${accountId} and created_at < ${before.toISOString()}::timestamptz`,
  );

export const deleteNotifications = async (db: Db, accountId: string, before: Date) =>
  (
    await rows<{ id: string }>(
      db,
      sql`delete from notifications
          where account_id = ${accountId} and created_at < ${before.toISOString()}::timestamptz returning id`,
    )
  ).length;

export const countActivity = (db: Db, accountId: string, before: Date) =>
  count(
    db,
    sql`select count(*)::int as n from activity_log
        where account_id = ${accountId} and created_at < ${before.toISOString()}::timestamptz`,
  );

/** One page of old events (the table is partitioned by created_at; the key is (id, created_at)). */
export const deleteActivityPage = async (db: Db, accountId: string, before: Date, limit: number) =>
  (
    await rows<{ id: string }>(
      db,
      sql`delete from activity_log where (id, created_at) in (
            select id, created_at from activity_log
            where account_id = ${accountId} and created_at < ${before.toISOString()}::timestamptz
            limit ${limit})
          returning id`,
    )
  ).length;

// ---- doc_auto_versions (the purge itself is docs.repo `purgeAutoVersions`) ----
export const countAutoVersions = (db: Db, accountId: string, before: Date) =>
  count(
    db,
    sql`select count(*)::int as n from doc_versions
        where account_id = ${accountId} and auto = true and created_at < ${before.toISOString()}::timestamptz`,
  );

// ---- agent_run_logs: the steps of runs that finished that long ago (the run's summary row stays) ----
const oldStepsWhere = (accountId: string, before: Date) => sql`
  from agent_run_steps s
  where s.account_id = ${accountId}
    and s.run_id in (select r.id from agent_runs r
                     where r.account_id = ${accountId} and r.finished_at < ${before.toISOString()}::timestamptz)`;

export const countAgentSteps = (db: Db, accountId: string, before: Date) =>
  count(db, sql`select count(*)::int as n ${oldStepsWhere(accountId, before)}`);

export const deleteAgentSteps = async (db: Db, accountId: string, before: Date) =>
  (
    await rows<{ id: string }>(
      db,
      sql`delete from agent_run_steps where id in (select s.id ${oldStepsWhere(accountId, before)}) returning id`,
    )
  ).length;

// ---- expired_oauth: codes / grants and tokens past their expiry (or revoked) that long ago ----
const oldTokens = (accountId: string, before: Date) => sql`
  from oauth_tokens where account_id = ${accountId}
    and (expires_at < ${before.toISOString()}::timestamptz or revoked_at < ${before.toISOString()}::timestamptz)`;
const oldGrants = (accountId: string, before: Date) => sql`
  from oauth_grants where account_id = ${accountId} and expires_at < ${before.toISOString()}::timestamptz`;

export const countExpiredOauth = async (db: Db, accountId: string, before: Date) =>
  (await count(db, sql`select count(*)::int as n ${oldTokens(accountId, before)}`)) +
  (await count(db, sql`select count(*)::int as n ${oldGrants(accountId, before)}`));

export const deleteExpiredOauth = async (db: Db, accountId: string, before: Date) =>
  (await rows<{ id: string }>(db, sql`delete ${oldTokens(accountId, before)} returning id`)).length +
  (await rows<{ id: string }>(db, sql`delete ${oldGrants(accountId, before)} returning id`)).length;

/**
 * Not any account's: abandoned OAuth requests (never tied to an account) and expired Better Auth verification
 * values (magic links, 2FA challenges, trusted devices, reset links) a day after they expired.
 */
export const purgeGlobalExpired = async (db: Db, before: Date) => ({
  oauth_requests: (
    await rows<{ id: string }>(
      db,
      sql`delete from oauth_grants where account_id is null
          and expires_at < ${before.toISOString()}::timestamptz returning id`,
    )
  ).length,
  verifications: (
    await rows<{ id: string }>(
      db,
      sql`delete from auth_verifications where expires_at < ${before.toISOString()}::timestamptz returning id`,
    )
  ).length,
});

// ---- runs ----
export const insertRun = (db: Db, row: typeof tidyRuns.$inferInsert) => db.insert(tidyRuns).values(row);

export const listRuns = (db: Db, accountId: string, limit: number) =>
  db
    .select({ run: tidyRuns, actorName: users.name })
    .from(tidyRuns)
    .leftJoin(users, eq(users.id, tidyRuns.actorId))
    .where(eq(tidyRuns.accountId, accountId))
    .orderBy(desc(tidyRuns.createdAt))
    .limit(limit);

export const findRun = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select({ run: tidyRuns, actorName: users.name })
      .from(tidyRuns)
      .leftJoin(users, eq(users.id, tidyRuns.actorId))
      .where(and(eq(tidyRuns.accountId, accountId), eq(tidyRuns.id, id)))
      .limit(1)
  )[0];

/** Accounts the daily job visits. */
export const activeAccountIds = async (db: Db) =>
  (
    await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.status, 'active'), sql`${accounts.deletedAt} is null`))
  ).map((r) => r.id);
