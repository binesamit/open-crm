// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { type BoardRole, looserRole } from '@bines/shared';
import type { Db } from '../../db/client';
import { assertWithinLimit } from '../billing/entitlements';
import {
  accountMembers,
  boardMembers,
  boardTeamMembers,
  boards,
  columns,
  folders,
  groups,
  itemKeys,
  teamMembers,
  teams,
  templates,
  users,
  workspaceMembers,
  workspaces,
} from '../../db/schema';
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type BoardRow = typeof boards.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type ColumnRow = typeof columns.$inferSelect;

const live = <T extends { deletedAt: unknown }>(t: T) => isNull(t.deletedAt as never);

/** A template's working board (fix3): `settings.template_edit` — hidden from every list. */
export type TemplateEditMark = { key: string; name: string; user_id: string; with_items: boolean };
export const templateEditOf = (b: { settings: unknown }): TemplateEditMark | null => {
  const v = (b.settings as { template_edit?: TemplateEditMark } | null)?.template_edit;
  return v && typeof v.key === 'string' ? v : null;
};
const notDraft = sql`not (${boards.settings} ? 'template_edit')`;

// ---- workspaces ----
export const listWorkspaces = (db: Db, accountId: string) =>
  db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.accountId, accountId), live(workspaces)))
    .orderBy(asc(workspaces.position));

export const findWorkspace = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(workspaces)
      .where(and(eq(workspaces.accountId, accountId), eq(workspaces.id, id), live(workspaces)))
      .limit(1)
  )[0];

export const lastWorkspacePosition = async (db: Db, accountId: string) =>
  (
    await db
      .select({ p: workspaces.position })
      .from(workspaces)
      .where(and(eq(workspaces.accountId, accountId), live(workspaces)))
      .orderBy(desc(workspaces.position))
      .limit(1)
  )[0]?.p ?? null;

export const insertWorkspace = (db: Db, row: typeof workspaces.$inferInsert) => db.insert(workspaces).values(row);
export const updateWorkspaceRow = (db: Db, id: string, patch: Partial<typeof workspaces.$inferInsert>) =>
  db
    .update(workspaces)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(workspaces.id, id));

export const workspaceIdsWithMember = async (db: Db, accountId: string, userId: string) =>
  (
    await db
      .select({ id: workspaceMembers.workspaceId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.accountId, accountId), eq(workspaceMembers.userId, userId)))
  ).map((r) => r.id);

// ---- folders ----
export const listFolders = (db: Db, accountId: string, workspaceId: string) =>
  db
    .select()
    .from(folders)
    .where(and(eq(folders.accountId, accountId), eq(folders.workspaceId, workspaceId), live(folders)))
    .orderBy(asc(folders.position));

export const findFolder = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(folders)
      .where(and(eq(folders.accountId, accountId), eq(folders.id, id), live(folders)))
      .limit(1)
  )[0];

export const lastFolderPosition = async (db: Db, workspaceId: string, parentId: string | null) =>
  (
    await db
      .select({ p: folders.position })
      .from(folders)
      .where(
        and(
          eq(folders.workspaceId, workspaceId),
          parentId ? eq(folders.parentFolderId, parentId) : isNull(folders.parentFolderId),
          live(folders),
        ),
      )
      .orderBy(desc(folders.position))
      .limit(1)
  )[0]?.p ?? null;

export const insertFolder = (db: Db, row: typeof folders.$inferInsert) => db.insert(folders).values(row);
export const updateFolderRow = (db: Db, id: string, patch: Partial<typeof folders.$inferInsert>) =>
  db
    .update(folders)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(folders.id, id));

// ---- boards ----
export const listBoardsInWorkspace = (db: Db, accountId: string, workspaceId: string) =>
  db
    .select()
    .from(boards)
    .where(
      and(
        eq(boards.accountId, accountId),
        eq(boards.workspaceId, workspaceId),
        live(boards),
        isNull(boards.archivedAt),
        isNull(boards.parentBoardId), // sub-boards are reached through their parent (D14)
        notDraft, // a template's working board opens from the templates page only (fix3)
      ),
    )
    .orderBy(asc(boards.position));

/** The top-level boards of several workspaces, as the sidebar lists them (full rows, for the access checks). */
export const listBoardsInWorkspaces = (db: Db, accountId: string, workspaceIds: string[]) =>
  workspaceIds.length
    ? db
        .select()
        .from(boards)
        .where(
          and(
            eq(boards.accountId, accountId),
            inArray(boards.workspaceId, workspaceIds),
            live(boards),
            isNull(boards.archivedAt),
            isNull(boards.parentBoardId),
            notDraft,
          ),
        )
        .orderBy(asc(boards.position))
    : Promise.resolve([]);

/** Every top-level board of the account (names and places only) — for pickers across workspaces. */
export const listAccountBoards = (db: Db, accountId: string) =>
  db
    .select({
      id: boards.id,
      name: boards.name,
      workspaceId: boards.workspaceId,
      parentBoardId: boards.parentBoardId,
      settings: boards.settings,
    })
    .from(boards)
    .where(
      and(
        eq(boards.accountId, accountId),
        live(boards),
        isNull(boards.archivedAt),
        isNull(boards.parentBoardId),
        notDraft,
      ),
    )
    .orderBy(asc(boards.position));

/** Marks a board as a template's working board (fix3); its other settings stay. */
export const markTemplateDraft = (db: Db, id: string, mark: TemplateEditMark) =>
  db
    .update(boards)
    .set({ settings: sql`${boards.settings} || ${JSON.stringify({ template_edit: mark })}::jsonb` })
    .where(eq(boards.id, id));

/** My open template working boards (fix3), one per template. */
export const listTemplateDrafts = (db: Db, accountId: string, userId: string) =>
  db
    .select()
    .from(boards)
    .where(
      and(
        eq(boards.accountId, accountId),
        live(boards),
        isNull(boards.parentBoardId),
        sql`${boards.settings}->'template_edit'->>'user_id' = ${userId}`,
      ),
    )
    .orderBy(asc(boards.createdAt));

/** The sub-board of a board (D14), if it has one. */
export const findSubBoard = async (db: Db, parentBoardId: string) =>
  (
    await db
      .select()
      .from(boards)
      .where(and(eq(boards.parentBoardId, parentBoardId), live(boards)))
      .limit(1)
  )[0];

export const findBoard = async (db: Db, accountId: string, id: string) =>
  (
    await db
      .select()
      .from(boards)
      .where(and(eq(boards.accountId, accountId), eq(boards.id, id), live(boards)))
      .limit(1)
  )[0];

export const countBoards = async (db: Db, accountId: string) =>
  Number(
    (
      await db
        .select({ n: sql<number>`count(*)` })
        .from(boards)
        .where(and(eq(boards.accountId, accountId), live(boards), isNull(boards.parentBoardId)))
    )[0]?.n ?? 0,
  );

export const lastBoardPosition = async (db: Db, workspaceId: string, folderId: string | null) =>
  (
    await db
      .select({ p: boards.position })
      .from(boards)
      .where(
        and(
          eq(boards.workspaceId, workspaceId),
          folderId ? eq(boards.folderId, folderId) : isNull(boards.folderId),
          live(boards),
        ),
      )
      .orderBy(desc(boards.position))
      .limit(1)
  )[0]?.p ?? null;

/** Every new board passes the plan's board limit here; a sub-board (D14) is part of its board. */
export const insertBoard = async (db: Db, row: typeof boards.$inferInsert) => {
  if (!row.parentBoardId) await assertWithinLimit(db, row.accountId, 'boards', 1);
  return db.insert(boards).values(row);
};
export const updateBoardRow = (db: Db, id: string, patch: Partial<typeof boards.$inferInsert>) =>
  db
    .update(boards)
    .set({ ...patch, updatedAt: new Date(), revision: sql`${boards.revision} + 1` })
    .where(eq(boards.id, id));

/** Boards of deleted folders land in the workspace root (14 §7) — never in trash with the folder. */
export const moveBoardsToRoot = (db: Db, folderIds: string[]) =>
  folderIds.length
    ? db
        .update(boards)
        .set({ folderId: null, updatedAt: new Date() })
        .where(and(inArray(boards.folderId, folderIds), live(boards)))
        .returning({ id: boards.id })
    : Promise.resolve([]);

/** Every board in these folders — archived ones and sub-boards included (a folder moving workspace, fix8). */
export const boardsInFolders = async (db: Db, accountId: string, folderIds: string[]) => {
  if (!folderIds.length) return [];
  const top = await db
    .select()
    .from(boards)
    .where(and(eq(boards.accountId, accountId), inArray(boards.folderId, folderIds), live(boards)));
  const subs = top.length
    ? await db
        .select()
        .from(boards)
        .where(
          and(
            inArray(
              boards.parentBoardId,
              top.map((b) => b.id),
            ),
            live(boards),
          ),
        )
    : [];
  return [...top, ...subs];
};

/** The boards of these folders (and their sub-boards) move to another workspace; their folder stays theirs. */
export const moveBoardsOfFolders = async (db: Db, accountId: string, folderIds: string[], workspaceId: string) => {
  const list = await boardsInFolders(db, accountId, folderIds);
  if (!list.length) return;
  await db
    .update(boards)
    .set({ workspaceId, updatedAt: new Date(), revision: sql`${boards.revision} + 1` })
    .where(
      inArray(
        boards.id,
        list.map((b) => b.id),
      ),
    );
};

export const countBoardsInWorkspace = async (db: Db, workspaceId: string) =>
  (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(boards)
      .where(and(eq(boards.workspaceId, workspaceId), live(boards), isNull(boards.parentBoardId)))
  )[0]?.n ?? 0;

// ---- board members ----
export type BoardMembership = { boardId: string; role: 'owner' | 'subscriber'; level: BoardRole | null };

/**
 * A user's subscriptions (05 §4): their own, and those of teams they are in. Per board: owner if any of them is;
 * the explicit role is their own when they are subscribed themselves, else the most generous of their teams'.
 */
export const boardMembershipsOf = async (
  db: Db,
  accountId: string,
  userId: string,
  boardId?: string,
): Promise<BoardMembership[]> => {
  const [own, viaTeams] = await Promise.all([
    db
      .select({ boardId: boardMembers.boardId, role: boardMembers.role, level: boardMembers.level })
      .from(boardMembers)
      .where(
        and(
          eq(boardMembers.accountId, accountId),
          eq(boardMembers.userId, userId),
          boardId ? eq(boardMembers.boardId, boardId) : undefined,
        ),
      ),
    db
      .select({ boardId: boardTeamMembers.boardId, role: boardTeamMembers.role, level: boardTeamMembers.level })
      .from(boardTeamMembers)
      .innerJoin(teamMembers, eq(teamMembers.teamId, boardTeamMembers.teamId))
      .innerJoin(teams, and(eq(teams.id, boardTeamMembers.teamId), isNull(teams.deletedAt)))
      .where(
        and(
          eq(boardTeamMembers.accountId, accountId),
          eq(teamMembers.userId, userId),
          boardId ? eq(boardTeamMembers.boardId, boardId) : undefined,
        ),
      ),
  ]);
  const out = new Map<string, BoardMembership & { personal: boolean }>();
  for (const m of own) out.set(m.boardId, { ...m, personal: true });
  for (const m of viaTeams) {
    const cur = out.get(m.boardId);
    if (!cur) out.set(m.boardId, { ...m, personal: false });
    else {
      if (m.role === 'owner') cur.role = 'owner';
      if (!cur.personal) cur.level = looserRole(cur.level, m.level);
    }
  }
  return [...out.values()].map(({ personal: _, ...m }) => m);
};

/** The live teams a user is in (column restrictions, `edit_assigned`). */
export const userTeamIds = async (db: Db, accountId: string, userId: string) =>
  (
    await db
      .select({ id: teamMembers.teamId })
      .from(teamMembers)
      .innerJoin(teams, and(eq(teams.id, teamMembers.teamId), isNull(teams.deletedAt)))
      .where(and(eq(teamMembers.accountId, accountId), eq(teamMembers.userId, userId)))
  ).map((r) => r.id);

export const findBoardMembership = async (db: Db, accountId: string, boardId: string, userId: string) =>
  (await boardMembershipsOf(db, accountId, userId, boardId))[0];

export const insertBoardMember = (db: Db, row: typeof boardMembers.$inferInsert) =>
  db.insert(boardMembers).values(row).onConflictDoNothing();

// ---- groups ----
export const listGroups = (db: Db, boardId: string) =>
  db
    .select()
    .from(groups)
    .where(and(eq(groups.boardId, boardId), live(groups), isNull(groups.archivedAt)))
    .orderBy(asc(groups.position));

export const findGroup = async (db: Db, boardId: string, id: string) =>
  (
    await db
      .select()
      .from(groups)
      .where(and(eq(groups.boardId, boardId), eq(groups.id, id), live(groups)))
      .limit(1)
  )[0];

export const insertGroups = (db: Db, rows: (typeof groups.$inferInsert)[]) =>
  rows.length ? db.insert(groups).values(rows) : Promise.resolve();
export const updateGroupRow = (db: Db, id: string, patch: Partial<typeof groups.$inferInsert>) =>
  db
    .update(groups)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(groups.id, id));

// ---- columns ----
export const listColumns = (db: Db, boardId: string) =>
  db
    .select()
    .from(columns)
    .where(and(eq(columns.boardId, boardId), live(columns), isNull(columns.archivedAt)))
    .orderBy(asc(columns.position));

/** Any column with this key, including deleted ones — keys are never reused on a board (03 §1). */
export const findColumnByKey = async (db: Db, boardId: string, key: string, includeDeleted = false) =>
  (
    await db
      .select()
      .from(columns)
      .where(and(eq(columns.boardId, boardId), eq(columns.key, key), includeDeleted ? undefined : live(columns)))
      .limit(1)
  )[0];

export const insertColumns = (db: Db, rows: (typeof columns.$inferInsert)[]) =>
  rows.length ? db.insert(columns).values(rows) : Promise.resolve();
export const updateColumnRow = (db: Db, id: string, patch: Partial<typeof columns.$inferInsert>) =>
  db
    .update(columns)
    .set({ ...patch, updatedAt: new Date(), revision: sql`${columns.revision} + 1` })
    .where(eq(columns.id, id));

export const findColumnById = async (db: Db, id: string) =>
  (
    await db
      .select()
      .from(columns)
      .where(and(eq(columns.id, id), live(columns)))
      .limit(1)
  )[0];

// ---- custom item keys ----
export const insertItemKey = (db: Db, row: typeof itemKeys.$inferInsert) =>
  db.insert(itemKeys).values(row).onConflictDoNothing();

/** An empty prefix (just the number) is never taken: any number of boards may number 1, 2, … */
export const prefixTaken = async (db: Db, accountId: string, prefix: string) =>
  prefix !== '' &&
  (
    await db
      .select({ id: itemKeys.id })
      .from(itemKeys)
      .where(and(eq(itemKeys.accountId, accountId), eq(itemKeys.prefix, prefix)))
      .limit(1)
  ).length > 0;

/** Claims the next custom-key number for a board (row lock inside the caller's transaction). */
export const nextItemKeySeq = async (db: Db, boardId: string) => {
  const row = (
    await db
      .update(itemKeys)
      .set({ nextSeq: sql`${itemKeys.nextSeq} + 1`, updatedAt: new Date() })
      .where(eq(itemKeys.boardId, boardId))
      .returning({ seq: sql<number>`${itemKeys.nextSeq} - 1`, prefix: itemKeys.prefix, padding: itemKeys.padding })
  )[0];
  return row;
};

/** `n` consecutive item keys at once (bulk insert): the first of them. */
export const reserveItemKeySeqs = async (db: Db, boardId: string, n: number) =>
  (
    await db
      .update(itemKeys)
      .set({ nextSeq: sql`${itemKeys.nextSeq} + ${n}`, updatedAt: new Date() })
      .where(eq(itemKeys.boardId, boardId))
      .returning({ first: sql<number>`${itemKeys.nextSeq} - ${n}` })
  )[0]?.first;

export const itemKeyFormat = async (db: Db, boardId: string) =>
  (
    await db
      .select({ prefix: itemKeys.prefix, padding: itemKeys.padding })
      .from(itemKeys)
      .where(eq(itemKeys.boardId, boardId))
      .limit(1)
  )[0];

// ---- templates ----
export const listBuiltinTemplates = (db: Db) =>
  db
    .select()
    .from(templates)
    .where(and(isNull(templates.accountId), eq(templates.isBuiltin, true), live(templates)))
    .orderBy(asc(templates.key));

export const findTemplate = async (db: Db, accountId: string, key: string) =>
  (
    await db
      .select()
      .from(templates)
      .where(
        and(
          eq(templates.key, key),
          or(isNull(templates.accountId), eq(templates.accountId, accountId)),
          live(templates),
        ),
      )
      .orderBy(sql`${templates.accountId} nulls last`)
      .limit(1)
  )[0];

export const upsertBuiltinTemplate = async (db: Db, row: typeof templates.$inferInsert) => {
  const existing = (
    await db
      .select({ id: templates.id })
      .from(templates)
      .where(and(isNull(templates.accountId), eq(templates.key, row.key), live(templates)))
      .limit(1)
  )[0];
  if (existing) {
    await db
      .update(templates)
      .set({
        name: row.name,
        description: row.description,
        snapshot: row.snapshot,
        category: row.category,
        updatedAt: new Date(),
      })
      .where(eq(templates.id, existing.id));
  } else {
    await db.insert(templates).values(row);
  }
};

// ---- batch lookups for cross-board reads (mirrors, relations) ----
export const boardsByIds = (db: Db, accountId: string, ids: string[]) =>
  ids.length
    ? db
        .select()
        .from(boards)
        .where(and(eq(boards.accountId, accountId), inArray(boards.id, ids), live(boards)))
    : Promise.resolve([] as BoardRow[]);

export const columnsByBoardIds = (db: Db, ids: string[]) =>
  ids.length
    ? db
        .select()
        .from(columns)
        .where(and(inArray(columns.boardId, ids), live(columns), isNull(columns.archivedAt)))
        .orderBy(asc(columns.position))
    : Promise.resolve([] as ColumnRow[]);

export const itemKeyFormats = (db: Db, boardIds: string[]) =>
  boardIds.length
    ? db
        .select({ boardId: itemKeys.boardId, prefix: itemKeys.prefix, padding: itemKeys.padding })
        .from(itemKeys)
        .where(inArray(itemKeys.boardId, boardIds))
    : Promise.resolve([] as { boardId: string; prefix: string; padding: number }[]);

/** Mirror columns on template-created boards whose settings lack source_column_id (see repairTemplateColumns). */
export const listTemplateMirrorColumnsMissingSource = (db: Db) =>
  db
    .select({
      id: columns.id,
      key: columns.key,
      type: columns.type,
      settings: columns.settings,
      snapshot: templates.snapshot,
    })
    .from(columns)
    .innerJoin(boards, eq(boards.id, columns.boardId))
    .innerJoin(templates, eq(templates.id, boards.createdFromTemplateId))
    .where(
      and(eq(columns.type, 'mirror'), live(columns), sql`coalesce(${columns.settings}->>'source_column_id', '') = ''`),
    );

/** Owners and subscribers of a board, with their names (the permissions dialog). */
export const listBoardMembers = (db: Db, boardId: string) =>
  db
    .select({
      userId: boardMembers.userId,
      role: boardMembers.role,
      level: boardMembers.level,
      name: users.name,
      email: users.email,
    })
    .from(boardMembers)
    .innerJoin(users, eq(users.id, boardMembers.userId))
    .where(eq(boardMembers.boardId, boardId))
    .orderBy(asc(users.name));

export const setBoardMemberRole = (
  db: Db,
  boardId: string,
  userId: string,
  patch: { role: 'owner' | 'subscriber'; level: BoardRole | null },
) =>
  db
    .update(boardMembers)
    .set(patch)
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)));

/**
 * Whether a board has an owner who can act (05 §4): an active account member who owns it, or an owning team
 * with at least one active member. Without one, an admin may claim it.
 */
export const hasActiveOwner = async (db: Db, accountId: string, boardId: string) => {
  const active = and(eq(accountMembers.accountId, accountId), eq(accountMembers.status, 'active'));
  const [person] = await db
    .select({ id: boardMembers.userId })
    .from(boardMembers)
    .innerJoin(accountMembers, and(eq(accountMembers.userId, boardMembers.userId), active))
    .where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.role, 'owner')))
    .limit(1);
  if (person) return true;
  const [viaTeam] = await db
    .select({ id: teamMembers.userId })
    .from(boardTeamMembers)
    .innerJoin(teams, and(eq(teams.id, boardTeamMembers.teamId), isNull(teams.deletedAt)))
    .innerJoin(teamMembers, eq(teamMembers.teamId, boardTeamMembers.teamId))
    .innerJoin(accountMembers, and(eq(accountMembers.userId, teamMembers.userId), active))
    .where(and(eq(boardTeamMembers.boardId, boardId), eq(boardTeamMembers.role, 'owner')))
    .limit(1);
  return !!viaTeam;
};

/** Teams subscribed to a board (live teams only), with their names. */
export const listBoardTeams = (db: Db, boardId: string) =>
  db
    .select({
      teamId: boardTeamMembers.teamId,
      role: boardTeamMembers.role,
      level: boardTeamMembers.level,
      name: teams.name,
    })
    .from(boardTeamMembers)
    .innerJoin(teams, and(eq(teams.id, boardTeamMembers.teamId), isNull(teams.deletedAt)))
    .where(eq(boardTeamMembers.boardId, boardId))
    .orderBy(asc(teams.name));

export const upsertBoardTeam = (db: Db, row: typeof boardTeamMembers.$inferInsert) =>
  db
    .insert(boardTeamMembers)
    .values(row)
    .onConflictDoUpdate({
      target: [boardTeamMembers.boardId, boardTeamMembers.teamId],
      set: { role: row.role, level: row.level ?? null },
    });

export const deleteBoardTeam = (db: Db, boardId: string, teamId: string) =>
  db.delete(boardTeamMembers).where(and(eq(boardTeamMembers.boardId, boardId), eq(boardTeamMembers.teamId, teamId)));

export const deleteBoardMember = (db: Db, boardId: string, userId: string) =>
  db.delete(boardMembers).where(and(eq(boardMembers.boardId, boardId), eq(boardMembers.userId, userId)));
