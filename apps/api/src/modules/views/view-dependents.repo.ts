// SPDX-License-Identifier: AGPL-3.0-only
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountMembers, boardMembers, boardTeamMembers, boards, columns, teamMembers, teams } from '../../db/schema';

/**
 * Relation columns (live, on live boards) whose choice filter for `boardId` is "by the view `viewId`"
 * (r19relfilter) — the columns a deleted / private view leaves without their filter.
 */
export const relationColumnsUsingView = (db: Db, accountId: string, boardId: string, viewId: string) =>
  db
    .select({
      id: columns.id,
      key: columns.key,
      title: columns.title,
      boardId: columns.boardId,
      parentBoardId: boards.parentBoardId,
    })
    .from(columns)
    .innerJoin(boards, and(eq(boards.id, columns.boardId), isNull(boards.deletedAt)))
    .where(
      and(
        eq(columns.accountId, accountId),
        eq(columns.type, 'board_relation'),
        isNull(columns.deletedAt),
        sql`${columns.settings} -> 'choice_filter' -> ${boardId}::text ->> 'mode' = 'view'`,
        sql`${columns.settings} -> 'choice_filter' -> ${boardId}::text ->> 'view_id' = ${viewId}::text`,
      ),
    );

/** The active members who own a board: in person, or through an owning team (05 §4). */
export const activeBoardOwnerIds = async (db: Db, accountId: string, boardId: string) => {
  const active = and(eq(accountMembers.accountId, accountId), eq(accountMembers.status, 'active'));
  const people = await db
    .select({ id: boardMembers.userId })
    .from(boardMembers)
    .innerJoin(accountMembers, and(eq(accountMembers.userId, boardMembers.userId), active))
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.role, 'owner')));
  const viaTeams = await db
    .select({ id: teamMembers.userId })
    .from(boardTeamMembers)
    .innerJoin(teams, and(eq(teams.id, boardTeamMembers.teamId), isNull(teams.deletedAt)))
    .innerJoin(teamMembers, eq(teamMembers.teamId, boardTeamMembers.teamId))
    .innerJoin(accountMembers, and(eq(accountMembers.userId, teamMembers.userId), active))
    .where(and(eq(boardTeamMembers.boardId, boardId), eq(boardTeamMembers.role, 'owner')));
  return [...new Set([...people, ...viaTeams].map((r) => r.id))];
};
