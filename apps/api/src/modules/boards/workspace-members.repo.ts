// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accountMembers, users, workspaceMembers } from '../../db/schema';

/** Workspace members (05 §3): who sees a closed workspace. People only (the `team_id` rows are not used yet). */
export const listWorkspaceMembers = (db: Db, accountId: string, workspaceId: string) =>
  db
    .select({
      userId: workspaceMembers.userId,
      role: workspaceMembers.role,
      name: users.name,
      email: users.email,
      accountRole: accountMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .innerJoin(
      accountMembers,
      and(eq(accountMembers.userId, workspaceMembers.userId), eq(accountMembers.accountId, accountId)),
    )
    .where(
      and(
        eq(workspaceMembers.accountId, accountId),
        eq(workspaceMembers.workspaceId, workspaceId),
        isNotNull(workspaceMembers.userId),
      ),
    )
    .orderBy(asc(users.name));

export const findWorkspaceMember = async (db: Db, accountId: string, workspaceId: string, userId: string) =>
  (
    await db
      .select()
      .from(workspaceMembers)
      .where(
        and(
          eq(workspaceMembers.accountId, accountId),
          eq(workspaceMembers.workspaceId, workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .limit(1)
  )[0];

/** Adds a person (no-op when already a member). Returns whether a row was added. */
export const insertWorkspaceMember = async (db: Db, row: typeof workspaceMembers.$inferInsert) =>
  (await db.insert(workspaceMembers).values(row).onConflictDoNothing().returning({ id: workspaceMembers.id })).length >
  0;

export const deleteWorkspaceMember = (db: Db, accountId: string, workspaceId: string, userId: string) =>
  db
    .delete(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.accountId, accountId),
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    );
