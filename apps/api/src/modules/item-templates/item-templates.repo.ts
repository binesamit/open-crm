// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull, notInArray } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { itemTemplateAssets, itemTemplates } from '../../db/schema';

export type ItemTemplateRow = typeof itemTemplates.$inferSelect;

export const insertItemTemplate = (db: Db, row: typeof itemTemplates.$inferInsert) =>
  db.insert(itemTemplates).values(row);

export const findItemTemplate = async (db: Db, accountId: string, id: string, withDeleted = false) =>
  (
    await db
      .select()
      .from(itemTemplates)
      .where(
        and(
          eq(itemTemplates.accountId, accountId),
          eq(itemTemplates.id, id),
          withDeleted ? undefined : isNull(itemTemplates.deletedAt),
        ),
      )
      .limit(1)
  )[0];

export const boardItemTemplates = (db: Db, accountId: string, boardId: string) =>
  db
    .select()
    .from(itemTemplates)
    .where(
      and(eq(itemTemplates.accountId, accountId), eq(itemTemplates.boardId, boardId), isNull(itemTemplates.deletedAt)),
    )
    .orderBy(asc(itemTemplates.category), asc(itemTemplates.name));

export const updateItemTemplateRow = (db: Db, id: string, patch: Partial<typeof itemTemplates.$inferInsert>) =>
  db
    .update(itemTemplates)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(itemTemplates.id, id));

/** The template holds exactly these files (its own copies): new ones linked, dropped ones unlinked (the sweep then
 * deletes them). */
export const setItemTemplateAssets = async (db: Db, accountId: string, templateId: string, assetIds: string[]) => {
  const ids = [...new Set(assetIds)];
  await db
    .delete(itemTemplateAssets)
    .where(
      and(
        eq(itemTemplateAssets.templateId, templateId),
        ids.length ? notInArray(itemTemplateAssets.assetId, ids) : undefined,
      ),
    );
  if (ids.length)
    await db
      .insert(itemTemplateAssets)
      .values(ids.map((assetId) => ({ templateId, assetId, accountId })))
      .onConflictDoNothing();
};

export const itemTemplateAssetIds = async (db: Db, templateId: string) =>
  (
    await db
      .select({ id: itemTemplateAssets.assetId })
      .from(itemTemplateAssets)
      .where(eq(itemTemplateAssets.templateId, templateId))
  ).map((r) => r.id);

/** Which of these assets a template of the account holds (any template). */
export const heldByTemplates = async (db: Db, accountId: string, assetIds: string[]) =>
  assetIds.length
    ? new Set(
        (
          await db
            .select({ id: itemTemplateAssets.assetId })
            .from(itemTemplateAssets)
            .where(and(eq(itemTemplateAssets.accountId, accountId), inArray(itemTemplateAssets.assetId, assetIds)))
        ).map((r) => r.id),
      )
    : new Set<string>();
