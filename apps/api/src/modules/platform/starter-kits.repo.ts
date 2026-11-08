// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { catalogVersions, folders, users } from '../../db/schema';

/** Starter kits as data (M11 stage 3): the saved versions of a catalog entry, newest first. */
export const listKitVersions = (db: Db, key: string) =>
  db
    .select({
      id: catalogVersions.id,
      version: catalogVersions.version,
      note: catalogVersions.note,
      createdAt: catalogVersions.createdAt,
      createdBy: users.name,
      createdByEmail: users.email,
    })
    .from(catalogVersions)
    .leftJoin(users, eq(users.id, catalogVersions.createdBy))
    .where(eq(catalogVersions.key, key))
    .orderBy(desc(catalogVersions.createdAt), desc(catalogVersions.id));

export const findKitVersion = async (db: Db, key: string, id: string) =>
  (
    await db
      .select()
      .from(catalogVersions)
      .where(and(eq(catalogVersions.key, key), eq(catalogVersions.id, id)))
      .limit(1)
  )[0];

export const insertKitVersion = (db: Db, row: typeof catalogVersions.$inferInsert) =>
  db.insert(catalogVersions).values(row);

/** Live folders of an account by id, in sidebar order (a kit keeps its boards' folders). */
export const foldersByIds = (db: Db, accountId: string, ids: string[]) =>
  ids.length
    ? db
        .select({ id: folders.id, name: folders.name, position: folders.position })
        .from(folders)
        .where(and(eq(folders.accountId, accountId), inArray(folders.id, ids), isNull(folders.deletedAt)))
        .orderBy(asc(folders.position))
    : Promise.resolve([]);
