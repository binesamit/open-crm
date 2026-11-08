// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { teamMembers, teams } from '../../db/schema';

export type TeamRow = typeof teams.$inferSelect;

export const listTeamRows = (db: Db, accountId: string) =>
  db
    .select()
    .from(teams)
    .where(and(eq(teams.accountId, accountId), isNull(teams.deletedAt)))
    .orderBy(asc(teams.name));

export const teamMemberRows = (db: Db, accountId: string) =>
  db.select().from(teamMembers).where(eq(teamMembers.accountId, accountId));

export const findTeam = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(teams)
      .where(and(eq(teams.accountId, accountId), eq(teams.id, id), isNull(teams.deletedAt)))
      .limit(1)
  )[0];

export const findTeamByName = async (db: Db, accountId: string, name: string) =>
  (await listTeamRows(db, accountId)).find((t) => t.name.trim().toLowerCase() === name.trim().toLowerCase());

export const insertTeam = (db: Db, row: typeof teams.$inferInsert) => db.insert(teams).values(row);

export const updateTeamRow = (db: Db, id: string, patch: Partial<typeof teams.$inferInsert>) =>
  db
    .update(teams)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(teams.id, id));

/** Replaces a team's members. */
export const setTeamMembers = async (db: Db, accountId: string, teamId: string, userIds: string[]) => {
  await db.delete(teamMembers).where(eq(teamMembers.teamId, teamId));
  if (userIds.length) await db.insert(teamMembers).values(userIds.map((userId) => ({ teamId, userId, accountId })));
};
