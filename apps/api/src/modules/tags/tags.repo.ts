// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { tags } from '../../db/schema';

export type TagRow = typeof tags.$inferSelect;

/** Account-wide tags (board-scoped ones are not used yet). */
const live = (accountId: string) => and(eq(tags.accountId, accountId), isNull(tags.boardId), isNull(tags.deletedAt));

export const listTagRows = (db: Db, accountId: string) =>
  db.select().from(tags).where(live(accountId)).orderBy(asc(tags.name));

export const tagsByIds = (db: Db, accountId: string, ids: string[]) =>
  ids.length
    ? db
        .select()
        .from(tags)
        .where(and(live(accountId), inArray(tags.id, ids)))
    : Promise.resolve([]);

/** Case-insensitive lookup by name. */
export const tagsByNames = (db: Db, accountId: string, names: string[]) =>
  names.length
    ? db
        .select()
        .from(tags)
        .where(
          and(
            live(accountId),
            inArray(
              sql`lower(${tags.name})`,
              names.map((n) => n.toLowerCase()),
            ),
          ),
        )
    : Promise.resolve([]);

export const insertTag = (db: Db, row: typeof tags.$inferInsert) => db.insert(tags).values(row);
