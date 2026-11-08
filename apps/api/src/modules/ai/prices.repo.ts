// SPDX-License-Identifier: AGPL-3.0-only
import { asc, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { aiPrices } from '../../db/schema';

export type AiPriceDbRow = typeof aiPrices.$inferSelect;

export const listPriceRows = (db: Db) =>
  db.select().from(aiPrices).orderBy(asc(aiPrices.provider), asc(aiPrices.model));

export const findPriceRow = async (db: Db, id: string) =>
  (await db.select().from(aiPrices).where(eq(aiPrices.id, id)).limit(1))[0];

export const insertPriceRow = (db: Db, row: typeof aiPrices.$inferInsert) =>
  db.insert(aiPrices).values(row).onConflictDoNothing().returning();

export const updatePriceRow = (db: Db, id: string, patch: Partial<typeof aiPrices.$inferInsert>) =>
  db
    .update(aiPrices)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(aiPrices.id, id))
    .returning();

export const deletePriceRow = (db: Db, id: string) => db.delete(aiPrices).where(eq(aiPrices.id, id)).returning();
