// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { boardMembers, boardTeamMembers, itemKeys, itemLinks, templates, views } from '../../db/schema';

/** Shared views of a board (private views stay with their owners), in order — copied with the board. */
export const sharedViewsOf = (db: Db, boardId: string) =>
  db
    .select()
    .from(views)
    .where(and(eq(views.boardId, boardId), isNull(views.deletedAt), eq(views.visibility, 'shared')));

export const insertViews = (db: Db, rows: (typeof views.$inferInsert)[]) =>
  rows.length ? db.insert(views).values(rows) : Promise.resolve();

export const membersOf = (db: Db, boardId: string) =>
  db.select().from(boardMembers).where(eq(boardMembers.boardId, boardId));

export const teamsOf = (db: Db, boardId: string) =>
  db.select().from(boardTeamMembers).where(eq(boardTeamMembers.boardId, boardId));

export const itemKeyOf = async (db: Db, boardId: string) =>
  (await db.select().from(itemKeys).where(eq(itemKeys.boardId, boardId)).limit(1))[0];

/** Links between copied items point at the copies (07 §4.1 "links within the board"). */
export const remapLinks = async (db: Db, idMap: Map<string, string>) => {
  const fresh = [...idMap.values()];
  if (!fresh.length) return;
  const rows = await db.select().from(itemLinks).where(inArray(itemLinks.fromItemId, fresh));
  for (const l of rows) {
    const to = idMap.get(l.toItemId);
    if (to) await db.update(itemLinks).set({ toItemId: to }).where(eq(itemLinks.id, l.id));
  }
};

export const insertTemplate = (db: Db, row: typeof templates.$inferInsert) => db.insert(templates).values(row);

/** Templates an account sees: the built-in ones and its own (saved from boards). */
export const listAccountTemplates = (db: Db, accountId: string) =>
  db
    .select()
    .from(templates)
    .where(and(eq(templates.accountId, accountId), isNull(templates.deletedAt)));

export const findAccountTemplate = async (db: Db, accountId: string, key: string) =>
  (
    await db
      .select()
      .from(templates)
      .where(and(eq(templates.accountId, accountId), eq(templates.key, key), isNull(templates.deletedAt)))
      .limit(1)
  )[0];

export const updateTemplateRow = (db: Db, id: string, patch: Partial<typeof templates.$inferInsert>) =>
  db.update(templates).set(patch).where(eq(templates.id, id));
