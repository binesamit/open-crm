// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, count, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountMembers, boards, formSubmissions, forms, users, views } from '../../db/schema';

export type FormRow = typeof forms.$inferSelect;

export const findFormByView = async (db: Db, accountId: string, viewId: string) =>
  (
    await db
      .select()
      .from(forms)
      .where(and(eq(forms.accountId, accountId), eq(forms.viewId, viewId)))
      .limit(1)
  )[0];

/**
 * A form by its public token, only while its view and board are live (not deleted, the board not archived).
 * The token is global (unique); the row carries its account — every later query filters by it.
 */
export const findLiveFormByToken = async (db: Db, token: string) =>
  (
    await db
      .select({ form: forms, boardName: boards.name })
      .from(forms)
      .innerJoin(views, eq(views.id, forms.viewId))
      .innerJoin(boards, eq(boards.id, forms.boardId))
      .where(
        and(
          eq(forms.slug, token),
          eq(views.accountId, forms.accountId),
          eq(boards.accountId, forms.accountId),
          isNull(views.deletedAt),
          eq(views.type, 'form'),
          isNull(boards.deletedAt),
          isNull(boards.archivedAt),
        ),
      )
      .limit(1)
  )[0];

export const insertForm = (db: Db, row: typeof forms.$inferInsert) =>
  db.insert(forms).values(row).onConflictDoNothing().returning();

/** Saves only over the expected revision (null = any); returns the row, or undefined on a conflict. */
export const updateFormRow = async (
  db: Db,
  id: string,
  patch: Partial<typeof forms.$inferInsert>,
  revision: number | null,
) =>
  (
    await db
      .update(forms)
      .set({ ...patch, revision: sql`${forms.revision} + 1`, updatedAt: new Date() })
      .where(revision === null ? eq(forms.id, id) : and(eq(forms.id, id), eq(forms.revision, revision)))
      .returning()
  )[0];

export const countSubmissions = async (db: Db, formId: string) =>
  Number((await db.select({ n: count() }).from(formSubmissions).where(eq(formSubmissions.formId, formId)))[0]?.n ?? 0);

export const insertSubmission = (db: Db, row: typeof formSubmissions.$inferInsert) =>
  db.insert(formSubmissions).values(row);

/** Whether the form allows embedding (the /f/* page's frame-ancestors), by token. */
export const embedAllowedByToken = async (db: Db, token: string) => {
  const row = (
    await db
      .select({ settings: forms.settings, active: forms.isActive })
      .from(forms)
      .where(eq(forms.slug, token))
      .limit(1)
  )[0];
  return !!row?.active && (row.settings as { allow_embed?: unknown }).allow_embed === true;
};

/** The account's active people (a people question on a members-only form lists them). */
export const activeMemberNames = (db: Db, accountId: string) =>
  db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(accountMembers)
    .innerJoin(users, eq(users.id, accountMembers.userId))
    .where(and(eq(accountMembers.accountId, accountId), eq(accountMembers.status, 'active')))
    .orderBy(asc(users.name))
    .limit(1000);
