// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import {
  idocDocs,
  idocEvents,
  idocSignatures,
  idocTemplates,
  type IdocDocRow,
  type IdocEventRow,
  type IdocSignatureRow,
  type IdocTemplateRow,
} from '../../db/schema';

export type { IdocDocRow, IdocEventRow, IdocSignatureRow, IdocTemplateRow };

// ——— templates ———

/** The account's templates a board may use: account-wide ones and the board's own (all of them without a board). */
export const listTemplates = (db: Db, accountId: string, boardId?: string | null) =>
  db
    .select()
    .from(idocTemplates)
    .where(
      and(
        eq(idocTemplates.accountId, accountId),
        boardId ? or(isNull(idocTemplates.boardId), eq(idocTemplates.boardId, boardId)) : undefined,
      ),
    )
    .orderBy(asc(idocTemplates.name));

export const findTemplate = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(idocTemplates)
      .where(and(eq(idocTemplates.accountId, accountId), eq(idocTemplates.id, id)))
      .limit(1)
  )[0];

export const insertTemplate = async (db: Db, row: typeof idocTemplates.$inferInsert) =>
  (await db.insert(idocTemplates).values(row).returning())[0]!;

export const updateTemplateRow = async (db: Db, id: string, patch: Partial<typeof idocTemplates.$inferInsert>) =>
  (
    await db
      .update(idocTemplates)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(idocTemplates.id, id))
      .returning()
  )[0]!;

export const deleteTemplateRow = (db: Db, id: string) => db.delete(idocTemplates).where(eq(idocTemplates.id, id));

// ——— documents ———

export const listItemDocs = (db: Db, accountId: string, itemId: string) =>
  db
    .select()
    .from(idocDocs)
    .where(and(eq(idocDocs.accountId, accountId), eq(idocDocs.itemId, itemId)))
    .orderBy(desc(idocDocs.createdAt));

export const findDoc = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(idocDocs)
      .where(and(eq(idocDocs.accountId, accountId), eq(idocDocs.id, id)))
      .limit(1)
  )[0];

export const findDocByToken = async (db: Db, token: string) =>
  (await db.select().from(idocDocs).where(eq(idocDocs.token, token)).limit(1))[0];

export const insertDoc = async (db: Db, row: typeof idocDocs.$inferInsert) =>
  (await db.insert(idocDocs).values(row).returning())[0]!;

export const updateDocRow = async (db: Db, id: string, patch: Partial<typeof idocDocs.$inferInsert>) =>
  (
    await db
      .update(idocDocs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(idocDocs.id, id))
      .returning()
  )[0]!;

/** One more view (first / last seen); no `updated_at` bump — viewing is not editing. */
export const countView = async (db: Db, id: string, now: Date) =>
  (
    await db
      .update(idocDocs)
      .set({
        viewCount: sql`${idocDocs.viewCount} + 1`,
        lastViewedAt: now,
        firstViewedAt: sql`coalesce(${idocDocs.firstViewedAt}, ${now})`,
      })
      .where(eq(idocDocs.id, id))
      .returning()
  )[0]!;

export const deleteDocRow = (db: Db, id: string) => db.delete(idocDocs).where(eq(idocDocs.id, id));

// ——— events ———

export const insertEvent = (db: Db, row: typeof idocEvents.$inferInsert) => db.insert(idocEvents).values(row);

export const listEvents = (db: Db, docId: string, limit = 500) =>
  db.select().from(idocEvents).where(eq(idocEvents.docId, docId)).orderBy(asc(idocEvents.createdAt)).limit(limit);

/** The client's last "opened" of this document (one is logged per visit, not per refresh). */
export const lastOpened = async (db: Db, docId: string) =>
  (
    await db
      .select({ at: idocEvents.createdAt })
      .from(idocEvents)
      .where(and(eq(idocEvents.docId, docId), eq(idocEvents.kind, 'opened')))
      .orderBy(desc(idocEvents.createdAt))
      .limit(1)
  )[0]?.at ?? null;

// ——— signatures ———

export const insertSignature = async (db: Db, row: typeof idocSignatures.$inferInsert) =>
  (await db.insert(idocSignatures).values(row).returning())[0]!;

export const findSignature = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(idocSignatures)
      .where(and(eq(idocSignatures.accountId, accountId), eq(idocSignatures.id, id)))
      .limit(1)
  )[0];

export const setSignatureFile = (db: Db, id: string, fileAssetId: string) =>
  db.update(idocSignatures).set({ fileAssetId }).where(eq(idocSignatures.id, id));
