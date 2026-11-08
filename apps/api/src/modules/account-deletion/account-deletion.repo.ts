// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import { newId } from '@bines/shared';
import type { Db } from '../../db/client';
import {
  accountExports,
  accountMembers,
  accounts,
  assets,
  boards,
  cellFiles,
  docs,
  items,
  platformAuditLog,
  updateFiles,
  updates,
  users,
  type JsonObject,
} from '../../db/schema';
import { latestVersions } from '../files/files.repo';

/** Account export and deletion: every query of the module. */

export type ExportRow = typeof accountExports.$inferSelect;

// ---- exports ----

export const insertExport = (db: Db, row: typeof accountExports.$inferInsert) => db.insert(accountExports).values(row);

export const findExport = async (db: Db, id: string): Promise<ExportRow | undefined> =>
  (await db.select().from(accountExports).where(eq(accountExports.id, id)).limit(1))[0];

export const updateExport = (db: Db, id: string, patch: Partial<typeof accountExports.$inferInsert>) =>
  db.update(accountExports).set(patch).where(eq(accountExports.id, id));

export const listExports = (db: Db, accountId: string, limit = 10) =>
  db
    .select({ row: accountExports, requesterName: users.name })
    .from(accountExports)
    .leftJoin(users, eq(users.id, accountExports.requestedBy))
    .where(eq(accountExports.accountId, accountId))
    .orderBy(desc(accountExports.createdAt), desc(accountExports.id))
    .limit(limit);

/** An export being built now (pending / running) — one at a time per account. */
export const runningExport = async (db: Db, accountId: string) =>
  (
    await db
      .select()
      .from(accountExports)
      .where(and(eq(accountExports.accountId, accountId), inArray(accountExports.status, ['pending', 'running'])))
      .limit(1)
  )[0];

/** Ready exports whose time is up (their file leaves storage). */
export const expiredExports = (db: Db, now: Date, limit = 200) =>
  db
    .select()
    .from(accountExports)
    .where(and(eq(accountExports.status, 'ready'), lte(accountExports.expiresAt, now)))
    .limit(limit);

// ---- what an export holds ----

/** The account's boards (not sub-boards, not deleted; archived ones included — they are data too). */
export const exportableBoards = (db: Db, accountId: string) =>
  db
    .select({ id: boards.id, name: boards.name })
    .from(boards)
    .where(and(eq(boards.accountId, accountId), isNull(boards.parentBoardId), isNull(boards.deletedAt)))
    .orderBy(asc(boards.name), asc(boards.id));

export const exportableDocs = (db: Db, accountId: string) =>
  db
    .select({ id: docs.id, name: docs.name })
    .from(docs)
    .where(and(eq(docs.accountId, accountId), isNull(docs.deletedAt)))
    .orderBy(asc(docs.name), asc(docs.id));

/** The updates (and replies) of these boards' items, oldest first, with their authors' names. */
export const boardUpdates = (db: Db, accountId: string, boardIds: string[]) =>
  db
    .select({
      id: updates.id,
      itemId: updates.itemId,
      parentUpdateId: updates.parentUpdateId,
      bodyText: updates.bodyText,
      isSecret: updates.isSecret,
      createdAt: updates.createdAt,
      editedAt: updates.editedAt,
      author: users.name,
    })
    .from(updates)
    .leftJoin(users, eq(users.id, updates.createdBy))
    .where(and(eq(updates.accountId, accountId), inArray(updates.boardId, boardIds), isNull(updates.deletedAt)))
    .orderBy(asc(updates.createdAt), asc(updates.id));

/** Item names by id (the files' folders, the updates' sheet). */
export const itemNamesOf = async (db: Db, accountId: string, boardIds: string[]) =>
  new Map(
    (
      await db
        .select({ id: items.id, name: items.name, parentItemId: items.parentItemId })
        .from(items)
        .where(and(eq(items.accountId, accountId), inArray(items.boardId, boardIds), isNull(items.deletedAt)))
    ).map((r) => [r.id, r]),
  );

/** The uploaded files of these boards' items: in their file columns and attached to their updates. */
export const boardFiles = async (db: Db, accountId: string, boardIds: string[]) => {
  const uploaded = and(eq(assets.uploadStatus, 'uploaded'), isNotNull(assets.storageKey), isNull(assets.deletedAt));
  const cellRows = await db
    .select({
      assetId: assets.id,
      itemId: cellFiles.itemId,
      fileName: assets.fileName,
      mime: assets.mime,
      storageKey: assets.storageKey,
    })
    .from(cellFiles)
    .innerJoin(assets, eq(assets.id, cellFiles.assetId))
    .innerJoin(items, eq(items.id, cellFiles.itemId))
    .where(
      and(eq(cellFiles.accountId, accountId), inArray(items.boardId, boardIds), isNull(items.deletedAt), uploaded),
    );
  // A file in a cell is exported at its current version.
  const latest = await latestVersions(
    db,
    cellRows.map((f) => f.assetId),
  );
  const inCells = cellRows.map((f) => {
    const v = latest.get(f.assetId);
    return v?.storageKey ? { ...f, fileName: v.fileName, mime: v.mime, storageKey: v.storageKey } : f;
  });
  const inUpdates = await db
    .select({
      assetId: assets.id,
      itemId: updates.itemId,
      fileName: assets.fileName,
      mime: assets.mime,
      storageKey: assets.storageKey,
    })
    .from(updateFiles)
    .innerJoin(assets, eq(assets.id, updateFiles.assetId))
    .innerJoin(updates, eq(updates.id, updateFiles.updateId))
    .where(
      and(
        eq(updateFiles.accountId, accountId),
        inArray(updates.boardId, boardIds),
        isNull(updates.deletedAt),
        uploaded,
      ),
    );
  const seen = new Set<string>();
  return [...inCells, ...inUpdates].filter((f) => {
    const k = `${f.itemId}:${f.assetId}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** A person as a background actor (the export reads as its requester). */
export const findUserForActor = async (db: Db, id: string) =>
  (
    await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        emailVerified: users.emailVerified,
        isPlatformOwner: users.isPlatformOwner,
        locale: users.locale,
        timezone: users.timezone,
        twoFactorEnabled: users.twoFactorEnabled,
      })
      .from(users)
      .where(eq(users.id, id))
      .limit(1)
  )[0];

// ---- the schedule ----

export const setDeletionSchedule = (
  db: Db,
  accountId: string,
  v: { scheduledAt: Date | null; dueAt: Date | null; requestedBy: string | null; state: JsonObject },
) =>
  db
    .update(accounts)
    .set({
      deletionScheduledAt: v.scheduledAt,
      deletionDueAt: v.dueAt,
      deletionRequestedBy: v.requestedBy,
      deletionState: v.state,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, accountId));

export const setDeletionState = (db: Db, accountId: string, state: JsonObject) =>
  db.update(accounts).set({ deletionState: state }).where(eq(accounts.id, accountId));

/** Any account row, deleted or not (the purge also finishes accounts the owner console soft-deleted). */
export const findAnyAccount = async (db: Db, id: string) =>
  (await db.select().from(accounts).where(eq(accounts.id, id)).limit(1))[0];

/** Accounts scheduled for deletion (the owner console's list, the reminders), soonest first. */
export const scheduledDeletions = (db: Db) =>
  db
    .select({ account: accounts, requester: { id: users.id, name: users.name, email: users.email } })
    .from(accounts)
    .leftJoin(users, eq(users.id, accounts.deletionRequestedBy))
    .where(isNotNull(accounts.deletionDueAt))
    .orderBy(asc(accounts.deletionDueAt), asc(accounts.id));

/**
 * Due for the purge: scheduled and past their date — and, only when `purgeConsoleDeleted` (the owner's
 * `account_deletion.purge_console_deleted`, off by default), soft-deleted by the owner console longer than `graceDays`.
 */
export const dueForPurge = (db: Db, now: Date, opts: { graceDays: number; purgeConsoleDeleted: boolean }, limit = 10) =>
  db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      opts.purgeConsoleDeleted
        ? or(
            lte(accounts.deletionDueAt, now),
            lte(accounts.deletedAt, new Date(now.getTime() - opts.graceDays * 86_400_000)),
          )
        : lte(accounts.deletionDueAt, now),
    )
    .orderBy(asc(accounts.id))
    .limit(limit);

/** The account's active admins with what an email needs. */
export const adminRecipients = (db: Db, accountId: string) =>
  db
    .select({ id: users.id, email: users.email, name: users.name, locale: users.locale, timezone: users.timezone })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(accountMembers.status, 'active'),
        eq(accountMembers.role, 'admin'),
        eq(users.isService, false),
      ),
    );

/**
 * The people of the account who belong to no other live account (any membership status) — after the purge they
 * keep an empty profile and get an email. Service identities and platform owners are left out.
 */
export const usersOnlyHere = async (db: Db, accountId: string) =>
  db
    .select({ id: users.id, email: users.email, name: users.name, locale: users.locale })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(
      and(
        eq(accountMembers.accountId, accountId),
        eq(users.isService, false),
        eq(users.isPlatformOwner, false),
        sql`not exists (select 1 from account_members m2 join accounts a2 on a2.id = m2.account_id
          where m2.user_id = ${users.id} and m2.account_id <> ${accountId} and a2.deleted_at is null)`,
      ),
    );

// ---- the purge ----

/**
 * A batch of the account's stored files (storage first, then the rows). File versions come first
 * deleting a file's root row cascades its versions' rows, which must not go before their objects did.
 */
export const storedAssetsBatch = (db: Db, accountId: string, limit: number) =>
  db
    .select({ id: assets.id, storageKey: assets.storageKey })
    .from(assets)
    .where(eq(assets.accountId, accountId))
    .orderBy(sql`${assets.parentAssetId} is null`, asc(assets.id))
    .limit(limit);

export const deleteAssetRows = (db: Db, ids: string[]) =>
  ids.length ? db.delete(assets).where(inArray(assets.id, ids)) : Promise.resolve();

export const exportFilesOf = (db: Db, accountId: string) =>
  db
    .select({ id: accountExports.id, storageKey: accountExports.storageKey })
    .from(accountExports)
    .where(and(eq(accountExports.accountId, accountId), isNotNull(accountExports.storageKey)));

/** Every table of the schema with an `account_id` column (the purge empties each, in batches). */
export const accountTables = async (db: Db): Promise<string[]> => {
  const res = (await db.execute(sql`
    select table_name from information_schema.columns
    where column_name = 'account_id' and table_schema = current_schema()
      and table_name in (select table_name from information_schema.tables
                         where table_schema = current_schema() and table_type = 'BASE TABLE')
    order by table_name`)) as unknown as { rows: { table_name: string }[] };
  return res.rows.map((r) => r.table_name).filter((t) => t !== 'accounts');
};

/** Deletes up to `limit` rows of the account from one table; returns how many went. */
export const deleteBatch = async (db: Db, table: string, accountId: string, limit: number): Promise<number> => {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('invalid_table');
  const res = (await db.execute(
    sql`delete from ${sql.identifier(table)} where ctid in (select ctid from ${sql.identifier(table)} where account_id = ${accountId} limit ${limit})`,
  )) as unknown as { rowCount?: number | null; affectedRows?: number };
  return Number(res.rowCount ?? res.affectedRows ?? 0);
};

export const countRows = async (db: Db, table: string, accountId: string): Promise<number> => {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('invalid_table');
  const res = (await db.execute(
    sql`select count(*)::int as n from ${sql.identifier(table)} where account_id = ${accountId}`,
  )) as unknown as { rows: { n: number }[] };
  return Number(res.rows[0]?.n ?? 0);
};

/** Items first (the biggest tree; their cells, updates and links go with them), in batches. */
export const deleteItemsBatch = async (db: Db, accountId: string, limit: number) => {
  const ids = (await db.select({ id: items.id }).from(items).where(eq(items.accountId, accountId)).limit(limit)).map(
    (r) => r.id,
  );
  if (ids.length) await db.delete(items).where(inArray(items.id, ids));
  return ids.length;
};

export const deleteAccountRow = (db: Db, accountId: string) => db.delete(accounts).where(eq(accounts.id, accountId));

// ---- the platform's audit ----

export const insertPlatformAudit = (db: Db, row: Omit<typeof platformAuditLog.$inferInsert, 'id'>) =>
  db
    .insert(platformAuditLog)
    .values({ id: newId(), ...row })
    .onConflictDoNothing();

export const findPurgeAudit = async (db: Db, accountId: string) =>
  (
    await db
      .select()
      .from(platformAuditLog)
      .where(and(eq(platformAuditLog.action, 'account.purged'), eq(platformAuditLog.targetId, accountId)))
      .limit(1)
  )[0];
