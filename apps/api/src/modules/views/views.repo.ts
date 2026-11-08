// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { userBoardPrefs, userViewPrefs, views } from '../../db/schema';

export type ViewRow = typeof views.$inferSelect;

/** Views of a board that a user can see: every shared view plus their own private ones (15 §3). */
export const listBoardViews = (db: Db, boardId: string, userId: string) =>
  db
    .select()
    .from(views)
    .where(
      and(
        eq(views.boardId, boardId),
        isNull(views.deletedAt),
        or(eq(views.visibility, 'shared'), eq(views.createdBy, userId)),
      ),
    )
    .orderBy(asc(views.position));

export const findView = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(views)
      .where(and(eq(views.accountId, accountId), eq(views.id, id), isNull(views.deletedAt)))
      .limit(1)
  )[0];

export const insertView = (db: Db, row: typeof views.$inferInsert) =>
  db.insert(views).values(row).onConflictDoNothing();

export const updateViewRow = (db: Db, id: string, patch: Partial<typeof views.$inferInsert>) =>
  db
    .update(views)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(views.id, id));

/** Saves settings only if the revision still matches (If-Match, 15 §7); returns false on a conflict. */
export const saveViewSettings = async (
  db: Db,
  id: string,
  settings: Record<string, unknown>,
  revision: number | null,
): Promise<boolean> => {
  const rows = await db
    .update(views)
    .set({ settings, revision: sql`${views.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(views.id, id), revision === null ? undefined : eq(views.revision, revision)))
    .returning({ id: views.id });
  return rows.length > 0;
};

export const clearDefault = (db: Db, boardId: string, exceptId: string) =>
  db
    .update(views)
    .set({ isDefault: false })
    .where(and(eq(views.boardId, boardId), ne(views.id, exceptId), eq(views.isDefault, true)));

export const countSharedViews = async (db: Db, boardId: string) =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(views)
      .where(and(eq(views.boardId, boardId), isNull(views.deletedAt), eq(views.visibility, 'shared')))
  )[0]?.n ?? 0;

// ---- personal prefs ----
export const prefsForViews = async (db: Db, userId: string, viewIds: string[]) => {
  if (!viewIds.length) return new Map<string, Record<string, unknown>>();
  const rows = await db
    .select()
    .from(userViewPrefs)
    .where(and(eq(userViewPrefs.userId, userId), inArray(userViewPrefs.viewId, viewIds)));
  return new Map(rows.map((r) => [r.viewId, r.settings]));
};

export const upsertViewPrefs = (
  db: Db,
  row: { userId: string; viewId: string; accountId: string; settings: Record<string, unknown> },
) =>
  db
    .insert(userViewPrefs)
    .values(row)
    .onConflictDoUpdate({
      target: [userViewPrefs.userId, userViewPrefs.viewId],
      set: { settings: row.settings, updatedAt: new Date() },
    });

export const deleteViewPrefs = (db: Db, userId: string, viewId: string) =>
  db.delete(userViewPrefs).where(and(eq(userViewPrefs.userId, userId), eq(userViewPrefs.viewId, viewId)));

export const setLastView = (db: Db, row: { userId: string; boardId: string; accountId: string; viewId: string }) =>
  db
    .insert(userBoardPrefs)
    .values({ userId: row.userId, boardId: row.boardId, accountId: row.accountId, lastViewId: row.viewId })
    .onConflictDoUpdate({
      target: [userBoardPrefs.userId, userBoardPrefs.boardId],
      set: { lastViewId: row.viewId, updatedAt: new Date() },
    });

/** My board prefs row (last view, tab layout). */
export const boardPrefsOf = async (db: Db, userId: string, boardId: string) =>
  (
    await db
      .select()
      .from(userBoardPrefs)
      .where(and(eq(userBoardPrefs.userId, userId), eq(userBoardPrefs.boardId, boardId)))
      .limit(1)
  )[0];

export const saveBoardPrefsSettings = (
  db: Db,
  row: { userId: string; boardId: string; accountId: string; settings: Record<string, unknown> },
) =>
  db
    .insert(userBoardPrefs)
    .values(row)
    .onConflictDoUpdate({
      target: [userBoardPrefs.userId, userBoardPrefs.boardId],
      set: { settings: row.settings, updatedAt: new Date() },
    });
