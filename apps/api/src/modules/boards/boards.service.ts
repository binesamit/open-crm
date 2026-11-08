// SPDX-License-Identifier: AGPL-3.0-only
import { effectiveDepthMax } from '@bines/shared';
import {
  accountDefaultsOf,
  accountSettingsSchema,
  itemCardSettingsSchema,
  mainTableColumnOrderSchema,
  type AnyColumnTypeDef,
  AppError,
  canBoard,
  COLUMN_KEY_RE,
  columnTypes,
  type createBoardSchema,
  type createColumnSchema,
  type createFolderSchema,
  type createGroupSchema,
  type createWorkspaceSchema,
  deriveValues,
  newId,
  nextGroupColor,
  rankBetween,
  reconcileLabels,
  statusLabelsFromDefaults,
  type updateBoardSchema,
  type updateColumnSchema,
  type updateFolderSchema,
  type updateGroupSchema,
  type updateWorkspaceSchema,
  validateFormula,
  withNewColumnDefaults,
} from '@bines/shared';
import { assertFeature } from '../billing/entitlements';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { AccountContext, AppDeps, RequestMeta, TokenAuth, Actor as BaseActor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { assertMayChangeSecretSettings, auditSecretSettings, changedSecretSettings } from '../secrets/step-up';
import { secretColumnHasValues, syncSecretMarkers } from '../secrets/secrets.service';
import { columnCells, softDeleteItemsInGroup, updateCellKeys } from '../items/items.repo';
import { dropLinksToBoards, unpairTwoWay, withoutTwoWay } from '../items/relations.service';
import { checkChoiceSettings } from '../items/relation-filter.service';
import { assertRelationTargets, dropUnreadableRelationTargets } from './relation-targets';
import { prepareWorkflowSettings, recordWorkflowVersion } from './workflow-versions';
import {
  type BoardAccess,
  assertBoard,
  capabilitiesOf,
  columnAllowed,
  loadBoardAccess,
  permissionContext,
  positionAmong,
  workspaceVisibleTo,
  withinLimit,
} from './boards.access';
import {
  type BoardRow,
  boardMembershipsOf,
  type ColumnRow,
  findColumnByKey,
  findFolder,
  findGroup,
  findSubBoard,
  findTemplate,
  findWorkspace,
  type FolderRow,
  type GroupRow,
  insertBoard,
  insertBoardMember,
  insertColumns,
  insertFolder,
  insertGroups,
  insertWorkspace,
  lastWorkspacePosition,
  listBoardsInWorkspace,
  listBuiltinTemplates,
  listTemplateDrafts,
  templateEditOf,
  listColumns,
  listFolders,
  listGroups,
  listWorkspaces,
  boardsInFolders,
  moveBoardsOfFolders,
  moveBoardsToRoot,
  countBoardsInWorkspace,
  updateWorkspaceRow,
  updateBoardRow,
  updateColumnRow,
  updateFolderRow,
  updateGroupRow,
  type WorkspaceRow,
  workspaceIdsWithMember,
  listBoardsInWorkspaces,
} from './boards.repo';
import { mirrorSources } from './mirror-sources';
import { accountLocale, st } from '../../lib/i18n';
import { insertWorkspaceMember } from './workspace-members.repo';
import { syncItemIdColumn } from './item-keys.service';
import { resyncDateTriggersOfColumn } from '../automations/engine/schedules';
import { liveSubtreesOf, setItemsDeleted } from '../trash/trash.repo';
import { trashObject, trashObjects } from '../trash/trash.service';
import { getAccountSettings, upsertAccountSettings } from '../accounts/accounts.repo';
import { findAccountTemplate, insertTemplate, listAccountTemplates, updateTemplateRow } from './board-copy.repo';
import { instantiateTemplate, templateSnapshotSchema } from './templates';
import { folderSiblings, lastEntityPosition, newFolderPosition, workspaceDocEntities } from '../docs/docs.service';
import { countDocsInWorkspace, listDocsInWorkspace, moveDocsOfFolders, moveDocsToRoot } from '../docs/docs.repo';
import { workspaceDashboardEntities } from '../dashboards/dashboards.service';
import { renormalizeColumn } from '../phone/phone.service';
import {
  countDashboardsInWorkspace,
  dashboardsInFolders,
  moveDashboardsOfFolders,
  moveDashboardsToRoot,
} from '../dashboards/dashboards.repo';
import { assertNotNameSource, checkNameSourceSettings, startNameRecompute } from '../items/names.service';
import { assertDeleteCode } from './delete-guard';

/**
 * `sessionId` / `token` / `meta`: set by the REST routes; a secret column's settings change needs them (the two-factor
 * step-up). Callers without them (AI, agents, MCP) can never change those settings.
 */
type Actor = BaseActor & { sessionId?: string | null; token?: TokenAuth | null; meta?: RequestMeta };
const canCreateStructure = (ctx: AccountContext) => ctx.role === 'admin' || ctx.role === 'member';

// ---- DTOs ----
const workspaceDto = (w: WorkspaceRow) => ({
  id: w.id,
  name: w.name,
  kind: w.kind,
  position: w.position,
  description: w.description ?? null,
});
const folderDto = (f: FolderRow) => ({
  id: f.id,
  workspace_id: f.workspaceId,
  parent_folder_id: f.parentFolderId,
  name: f.name,
  color: f.color,
  position: f.position,
});
export const boardSummaryDto = (b: BoardRow) => ({
  id: b.id,
  name: b.name,
  kind: b.kind,
  workspace_id: b.workspaceId,
  folder_id: b.folderId,
  position: b.position,
  item_terminology: b.itemTerminology,
});
export const groupDto = (g: GroupRow) => ({ id: g.id, title: g.title, color: g.color, position: g.position });
/** `restricted_edit`: whether this viewer may not edit it (with `access`), else whether it is restricted at all. */
export const columnDto = (c: ColumnRow, access?: BoardAccess) => ({
  id: c.key,
  type: c.type,
  title: c.title,
  description: c.description,
  settings: c.settings,
  width: c.width,
  position: c.position,
  read_only: columnTypes.get(c.type)?.readOnly ?? true,
  restricted_edit: access ? !columnAllowed(access, c.restrictedEdit) : !!c.restrictedEdit,
  // D28: the background conversion running on it (the header shows its progress; edits wait).
  converting: c.convertingId ?? null,
});

// ---- workspaces & tree ----
export const listVisibleWorkspaces = async (db: Db, { ctx, user }: Actor) => {
  const memberOf = await workspaceIdsWithMember(db, ctx.accountId, user.id);
  const all = await listWorkspaces(db, ctx.accountId);
  if (ctx.role !== 'guest') return all.filter((w) => workspaceVisibleTo(w, ctx, memberOf)).map(workspaceDto);
  // Guests (D22.7, the same sidebar): only the workspaces that hold a board shared with them.
  const out = [];
  for (const w of all)
    if (
      (await guestTreeBoards(db, { ctx, user }, w.id)).length ||
      (await workspaceDocEntities(db, { ctx, user }, w.id)).length || // a doc shared with them (M8)
      (await workspaceDashboardEntities(db, { ctx, user }, w.id)).length // a dashboard shared with them
    )
      out.push(workspaceDto(w));
  return out;
};

/**
 * Every top-level board I may open, from every workspace I see — what the sidebar's trees show, with one query
 * instead of a tree per workspace (GET /boards, the pickers across workspaces). The same checks as the tree: a
 * visible workspace, then the board's own read right (and a token's board limit).
 */
export const listReadableBoards = async (
  db: Db,
  a: Actor,
  workspaces?: Awaited<ReturnType<typeof listVisibleWorkspaces>>,
) => {
  workspaces ??= await listVisibleWorkspaces(db, a);
  const [boards, memberships] = await Promise.all([
    listBoardsInWorkspaces(
      db,
      a.ctx.accountId,
      workspaces.map((w) => w.id),
    ),
    boardMembershipsOf(db, a.ctx.accountId, a.user.id),
  ]);
  const membershipOf = new Map(memberships.map((m) => [m.boardId, m]));
  return boards
    .filter(
      (b) =>
        canBoard(permissionContext(a.ctx, b, true, membershipOf.get(b.id) ?? null), 'board.read').ok &&
        withinLimit(a.ctx, b),
    )
    .map(boardSummaryDto);
};

/** The boards of a workspace a guest may read (shareable + subscribed, 05 §4). */
const guestTreeBoards = async (db: Db, a: Actor, workspaceId: string) => {
  const [boards, memberships] = await Promise.all([
    listBoardsInWorkspace(db, a.ctx.accountId, workspaceId),
    boardMembershipsOf(db, a.ctx.accountId, a.user.id),
  ]);
  const membershipOf = new Map(memberships.map((m) => [m.boardId, m]));
  return boards.filter(
    (b) =>
      canBoard(permissionContext(a.ctx, b, true, membershipOf.get(b.id) ?? null), 'board.read').ok &&
      withinLimit(a.ctx, b),
  );
};

export const createWorkspace = async (db: Db, a: Actor, input: z.infer<typeof createWorkspaceSchema>) => {
  if (!canCreateStructure(a.ctx)) throw new AppError('forbidden', 'cannot_create_workspace');
  const id = newId();
  await db.transaction(async (tx) => {
    await insertWorkspace(tx, {
      id,
      accountId: a.ctx.accountId,
      name: input.name,
      kind: input.kind,
      position: rankBetween(await lastWorkspacePosition(tx, a.ctx.accountId), null),
      createdBy: a.user.id,
    });
    // The creator is its first member (owner): a closed workspace stays in their sight (fix6-server 3b).
    await insertWorkspaceMember(tx, {
      id: newId(),
      accountId: a.ctx.accountId,
      workspaceId: id,
      userId: a.user.id,
      role: 'owner',
      addedBy: a.user.id,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'workspace.created',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id, name: input.name, kind: input.kind },
    });
  });
  return workspaceDto((await findWorkspace(db, a.ctx.accountId, id))!);
};

/** Admins and the creator may rename a workspace; only admins delete one (14 §8). */
const assertWorkspaceEditor = (a: Actor, workspace: WorkspaceRow) => {
  if (a.ctx.role !== 'admin' && workspace.createdBy !== a.user.id) {
    throw new AppError('forbidden', 'workspace_owner_only');
  }
};

/** The workspace page edits the description too (a workspace's own page). */
export type UpdateWorkspaceInput = z.infer<typeof updateWorkspaceSchema> & { description?: string | null };

export const updateWorkspace = async (db: Db, a: Actor, id: string, input: UpdateWorkspaceInput) => {
  const workspace = await findWorkspace(db, a.ctx.accountId, id);
  if (!workspace || a.ctx.role === 'guest') throw new AppError('not_found', 'Workspace not found');
  assertWorkspaceEditor(a, workspace);
  await db.transaction(async (tx) => {
    await updateWorkspaceRow(tx, id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
    });
    // Closing it keeps the one who closes it (and its creator) inside: they become owners (fix6-server 3b).
    if (input.kind === 'closed' && workspace.kind !== 'closed')
      for (const userId of new Set([a.user.id, ...(workspace.createdBy ? [workspace.createdBy] : [])]))
        await insertWorkspaceMember(tx, {
          id: newId(),
          accountId: a.ctx.accountId,
          workspaceId: id,
          userId,
          role: 'owner',
          addedBy: a.user.id,
        });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'workspace.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id, name: workspace.name, kind: workspace.kind, description: workspace.description },
      after: input,
    });
  });
  return workspaceDto((await findWorkspace(db, a.ctx.accountId, id))!);
};

/**
 * Deletes an empty workspace (its folders go with it). Boards must be moved or deleted first, and the
 * account always keeps one workspace — nothing reachable is ever lost by this action.
 */
export const deleteWorkspace = async (db: Db, a: Actor, id: string) => {
  const workspace = await findWorkspace(db, a.ctx.accountId, id);
  if (!workspace || a.ctx.role === 'guest') throw new AppError('not_found', 'Workspace not found');
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'workspace_admin_only');
  if ((await listWorkspaces(db, a.ctx.accountId)).length <= 1) {
    throw new AppError('last_workspace', 'An account keeps at least one workspace');
  }
  if (
    (await countBoardsInWorkspace(db, id)) > 0 ||
    (await countDocsInWorkspace(db, id)) > 0 ||
    (await countDashboardsInWorkspace(db, id)) > 0
  ) {
    throw new AppError('workspace_not_empty', 'Move or delete the boards first');
  }
  const folders = await listFolders(db, a.ctx.accountId, id);
  return db.transaction(async (tx) => {
    const now = new Date();
    for (const f of folders) await updateFolderRow(tx, f.id, { deletedAt: now });
    await updateWorkspaceRow(tx, id, { deletedAt: now });
    const folderIds = folders.map((f) => f.id);
    const entryId = await trashObject(tx, a, {
      type: 'workspace',
      id,
      name: workspace.name,
      payload: { folder_ids: folderIds },
    });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'workspace.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id, name: workspace.name, folder_ids: folderIds },
      meta: { trash_entry_id: entryId },
    });
  });
};

/** Sidebar payload (06 §2.4 `/workspaces/:id/tree`): folders + the boards this actor may see. */
export const workspaceTree = async (db: Db, a: Actor, workspaceId: string) => {
  const workspace = await findWorkspace(db, a.ctx.accountId, workspaceId);
  const memberOf = await workspaceIdsWithMember(db, a.ctx.accountId, a.user.id);
  const guest = a.ctx.role === 'guest';
  if (!workspace || !workspaceVisibleTo(workspace, a.ctx, memberOf)) {
    throw new AppError('not_found', 'Workspace not found');
  }
  if (
    guest &&
    !(await guestTreeBoards(db, a, workspaceId)).length &&
    !(await workspaceDocEntities(db, a, workspaceId)).length &&
    !(await workspaceDashboardEntities(db, a, workspaceId)).length
  )
    throw new AppError('not_found', 'Workspace not found');
  const [allFolders, boards, memberships, docEntities, dashboardEntities] = await Promise.all([
    listFolders(db, a.ctx.accountId, workspaceId),
    listBoardsInWorkspace(db, a.ctx.accountId, workspaceId),
    boardMembershipsOf(db, a.ctx.accountId, a.user.id),
    // Docs and dashboards next to the boards (M8 ד0/ד1/ד4).
    workspaceDocEntities(db, a, workspaceId),
    workspaceDashboardEntities(db, a, workspaceId),
  ]);
  const entities = [...docEntities, ...dashboardEntities];
  const membershipOf = new Map(memberships.map((m) => [m.boardId, m]));
  const contextOf = (b: BoardRow) => permissionContext(a.ctx, b, true, membershipOf.get(b.id) ?? null);
  const isAdmin = a.ctx.role === 'admin';
  const visible = boards.filter((b) => canBoard(contextOf(b), 'board.read').ok && withinLimit(a.ctx, b));
  // A guest sees only the folders on the way to their boards — not the rest of the structure.
  let folders = allFolders;
  if (guest) {
    const byId = new Map(allFolders.map((f) => [f.id, f]));
    const keep = new Set<string>();
    for (const b of [...visible, ...entities.map((e) => ({ folderId: e.folder_id }))]) {
      let f = b.folderId ? byId.get(b.folderId) : undefined;
      while (f && !keep.has(f.id)) {
        keep.add(f.id);
        f = f.parentFolderId ? byId.get(f.parentFolderId) : undefined;
      }
    }
    folders = allFolders.filter((f) => keep.has(f.id));
  }
  return {
    workspace: {
      ...workspaceDto(workspace),
      can_edit: isAdmin || workspace.createdBy === a.user.id,
      can_delete: isAdmin,
      can_create: canCreateStructure(a.ctx),
    },
    folders: folders.map((f) => ({ ...folderDto(f), can_edit: isAdmin || f.createdBy === a.user.id })),
    boards: visible.map((b) => ({
      ...boardSummaryDto(b),
      can_update: canBoard(contextOf(b), 'board.update').ok,
      can_delete: canBoard(contextOf(b), 'board.delete').ok,
    })),
    entities,
  };
};

// ---- folders ----
const MAX_FOLDER_DEPTH = 2; // ≤3 levels (0..2), 02 §3

export const createFolder = async (db: Db, a: Actor, input: z.infer<typeof createFolderSchema>) => {
  if (!canCreateStructure(a.ctx)) throw new AppError('forbidden', 'cannot_create_folder');
  const workspace = await findWorkspace(db, a.ctx.accountId, input.workspace_id);
  if (!workspace) throw new AppError('not_found', 'Workspace not found');
  const parent = input.parent_folder_id ? await findFolder(db, a.ctx.accountId, input.parent_folder_id) : undefined;
  if (input.parent_folder_id && (!parent || parent.workspaceId !== workspace.id)) {
    throw new AppError('not_found', 'Parent folder not found');
  }
  const depth = parent ? parent.depth + 1 : 0;
  if (depth > MAX_FOLDER_DEPTH) throw new AppError('depth_exceeded', 'Folders nest at most 3 levels');
  const id = newId();
  await db.transaction(async (tx) => {
    await insertFolder(tx, {
      id,
      accountId: a.ctx.accountId,
      workspaceId: workspace.id,
      parentFolderId: parent?.id ?? null,
      depth,
      name: input.name,
      color: input.color ?? null,
      position: await newFolderPosition(tx, a.ctx.accountId, workspace.id, parent?.id ?? null),
      createdBy: a.user.id,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'folder.created',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id, name: input.name, workspace_id: workspace.id },
    });
  });
  return folderDto((await findFolder(db, a.ctx.accountId, id))!);
};

const assertFolderEditor = (a: Actor, folder: FolderRow) => {
  if (a.ctx.role !== 'admin' && folder.createdBy !== a.user.id) throw new AppError('forbidden', 'folder_owner_only');
};

/**
 * PATCH /folders/:id with `workspace_id` (fix8): the folder, its sub-folders and every board in them (archived
 * ones too, so nothing is left pointing across workspaces) go to the other workspace's root, last there. The
 * actor must manage each live board in it; the boards keep their own permissions.
 */
const moveFolderToWorkspace = async (db: Db, a: Actor, folder: FolderRow, workspaceId: string) => {
  const target = await loadMoveTarget(db, a, workspaceId);
  const all = await listFolders(db, a.ctx.accountId, folder.workspaceId);
  const ids = [folder.id];
  for (let i = 0; i < ids.length; i++) ids.push(...all.filter((f) => f.parentFolderId === ids[i]).map((f) => f.id));
  const inside = await boardsInFolders(db, a.ctx.accountId, ids);
  const top = inside.filter((x) => !x.parentBoardId);
  for (const b of top.filter((x) => !x.archivedAt)) {
    const access = await loadBoardAccess(db, a.ctx, a.user, b.id).catch(() => null);
    if (!access || !canBoard(access.perm, 'board.manage_permissions').ok)
      throw new AppError('forbidden', 'folder_has_unmanaged_boards');
  }
  await db.transaction(async (tx) => {
    const position = await newFolderPosition(tx, a.ctx.accountId, target.id, null);
    await updateFolderRow(tx, folder.id, { workspaceId: target.id, parentFolderId: null, depth: 0, position });
    for (const f of all.filter((x) => ids.includes(x.id) && x.id !== folder.id))
      await updateFolderRow(tx, f.id, { workspaceId: target.id, depth: f.depth - folder.depth });
    await moveBoardsOfFolders(tx, a.ctx.accountId, ids, target.id);
    await moveDocsOfFolders(tx, a.ctx.accountId, ids, target.id);
    await moveDashboardsOfFolders(tx, a.ctx.accountId, ids, target.id);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'folder.moved',
      actorId: a.user.id,
      requestId: a.requestId,
      before: {
        id: folder.id,
        name: folder.name,
        workspace_id: folder.workspaceId,
        parent_folder_id: folder.parentFolderId,
      },
      after: { workspace_id: target.id, parent_folder_id: null },
      meta: { folder_ids: ids, board_ids: top.map((x) => x.id) },
    });
    // Each board's own feed and live channel hear about it too (an open board refreshes the sidebar).
    for (const b of top)
      await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'board.moved',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: b.id,
        before: { workspace_id: b.workspaceId, folder_id: b.folderId },
        after: { workspace_id: target.id, folder_id: b.folderId },
        meta: { with_folder: folder.id },
      });
  });
};

/**
 * PATCH /folders/:id with `parent_folder_id` and / or `position` (product owner: "drag folders like everything
 * else, and put one between boards — not always at the top"): the folder, with all that is in it, goes into another
 * folder of the same workspace (or the root) and / or to a place among its boards, docs, dashboards and folders.
 * Never into itself or a folder inside it, and never deeper than three levels (with its own sub-folders).
 */
const moveFolderWithin = async (
  db: Db,
  a: Actor,
  folder: FolderRow,
  input: Pick<z.infer<typeof updateFolderSchema>, 'parent_folder_id' | 'position'>,
) => {
  const parentId = input.parent_folder_id !== undefined ? input.parent_folder_id : folder.parentFolderId;
  const all = await listFolders(db, a.ctx.accountId, folder.workspaceId);
  // The folder and every folder inside it (it may not go into one of them).
  const inside = [folder.id];
  for (let i = 0; i < inside.length; i++)
    inside.push(...all.filter((f) => f.parentFolderId === inside[i]).map((f) => f.id));
  let depth = 0;
  if (parentId) {
    const parent = all.find((f) => f.id === parentId);
    if (!parent) throw new AppError('not_found', 'Folder not found');
    if (inside.includes(parent.id)) throw new AppError('bad_request', 'A folder cannot go into itself');
    depth = parent.depth + 1;
  }
  const below = Math.max(...all.filter((f) => inside.includes(f.id)).map((f) => f.depth)) - folder.depth;
  if (depth + below > MAX_FOLDER_DEPTH) throw new AppError('depth_exceeded', 'Folders nest at most 3 levels');
  const siblings = (await folderSiblings(db, a.ctx.accountId, folder.workspaceId, parentId)).filter(
    (x) => x.id !== folder.id,
  );
  // A place among them, or — moved without one — where a new folder would go.
  const position = input.position
    ? positionAmong(siblings, input.position)
    : parentId === folder.parentFolderId
      ? folder.position
      : await newFolderPosition(db, a.ctx.accountId, folder.workspaceId, parentId);
  await db.transaction(async (tx) => {
    await updateFolderRow(tx, folder.id, { parentFolderId: parentId, depth, position });
    if (depth !== folder.depth)
      for (const f of all.filter((x) => inside.includes(x.id) && x.id !== folder.id))
        await updateFolderRow(tx, f.id, { depth: f.depth - folder.depth + depth });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'folder.moved',
      actorId: a.user.id,
      requestId: a.requestId,
      before: {
        id: folder.id,
        name: folder.name,
        workspace_id: folder.workspaceId,
        parent_folder_id: folder.parentFolderId,
        position: folder.position,
      },
      after: { workspace_id: folder.workspaceId, parent_folder_id: parentId, position },
    });
  });
};

export const updateFolder = async (db: Db, a: Actor, id: string, input: z.infer<typeof updateFolderSchema>) => {
  const folder = await findFolder(db, a.ctx.accountId, id);
  if (!folder) throw new AppError('not_found', 'Folder not found');
  assertFolderEditor(a, folder);
  if (input.workspace_id && input.workspace_id !== folder.workspaceId)
    await moveFolderToWorkspace(db, a, folder, input.workspace_id);
  else if (input.parent_folder_id !== undefined || input.position) await moveFolderWithin(db, a, folder, input);
  if (input.name === undefined && input.color === undefined)
    return folderDto((await findFolder(db, a.ctx.accountId, id))!);
  await db.transaction(async (tx) => {
    await updateFolderRow(tx, id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'folder.renamed',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { name: folder.name, color: folder.color },
      after: input,
    });
  });
  return folderDto((await findFolder(db, a.ctx.accountId, id))!);
};

/**
 * Folder + nested folders go to trash (14 §7). Their boards move to the workspace root — or, when the person chose
 * so, go to trash with the folder: each board its own trash entry (restorable alone, purged as a
 * board), the folder's entry listing them so restoring the folder brings them back into it. Docs and dashboards
 * move to the root either way. Trashing boards needs the right to delete each one.
 */
export const deleteFolder = async (db: Db, a: Actor, id: string, opts: { boards?: 'root' | 'trash' } = {}) => {
  const folder = await findFolder(db, a.ctx.accountId, id);
  if (!folder) throw new AppError('not_found', 'Folder not found');
  assertFolderEditor(a, folder);
  const all = await listFolders(db, a.ctx.accountId, folder.workspaceId);
  const ids = [folder.id];
  for (let i = 0; i < ids.length; i++) ids.push(...all.filter((f) => f.parentFolderId === ids[i]).map((f) => f.id));
  const inFolders = (await listBoardsInWorkspace(db, a.ctx.accountId, folder.workspaceId)).filter(
    (b) => b.folderId && ids.includes(b.folderId),
  );
  const docsIn = (await listDocsInWorkspace(db, a.ctx.accountId, folder.workspaceId)).filter(
    (d) => d.folderId && ids.includes(d.folderId),
  );
  const dashboardsIn = await dashboardsInFolders(db, ids);
  const trashBoards = opts.boards === 'trash';
  if (trashBoards)
    for (const b of inFolders) assertBoard(await loadBoardAccess(db, a.ctx, a.user, b.id), 'board.delete');
  return db.transaction(async (tx) => {
    const now = new Date();
    for (const fid of ids) await updateFolderRow(tx, fid, { deletedAt: now });
    let moved: { id: string }[] = [];
    let boardEntries: string[] = [];
    if (trashBoards) {
      for (const b of inFolders) await updateBoardRow(tx, b.id, { deletedAt: now });
      boardEntries = await trashObjects(
        tx,
        a,
        inFolders.map((b) => ({ type: 'board' as const, id: b.id, name: b.name, boardId: b.id })),
      );
    } else moved = await moveBoardsToRoot(tx, ids);
    await moveDocsToRoot(tx, ids);
    await moveDashboardsToRoot(tx, ids);
    const entryId = await trashObject(tx, a, {
      type: 'folder',
      id: folder.id,
      name: folder.name,
      payload: {
        folder_ids: ids,
        boards: trashBoards ? [] : inFolders.map((b) => ({ id: b.id, folder_id: b.folderId! })),
        board_entries: boardEntries,
        docs: docsIn.map((d) => ({ id: d.id, folder_id: d.folderId! })),
        dashboards: dashboardsIn.map((d) => ({ id: d.id, folder_id: d.folderId! })),
      },
    });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'folder.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      before: {
        id: folder.id,
        name: folder.name,
        folder_ids: ids,
        board_ids: moved.map((b) => b.id),
        ...(trashBoards ? { trashed_board_ids: inFolders.map((b) => b.id) } : {}),
      },
      meta: { trash_entry_id: entryId },
    });
  });
};

// ---- boards ----
/** Built-in templates, then this account's own (saved from boards, 07 §4.3). */
const hiddenTemplates = async (db: Db, accountId: string) =>
  new Set(accountSettingsSchema.parse(await getAccountSettings(db, accountId)).hidden_templates);

const hideTemplate = async (db: Db, a: Actor, key: string) => {
  const settings = accountSettingsSchema.parse(await getAccountSettings(db, a.ctx.accountId));
  if (settings.hidden_templates.includes(key)) return;
  await upsertAccountSettings(
    db,
    a.ctx.accountId,
    { ...settings, hidden_templates: [...settings.hidden_templates, key] },
    a.user.id,
  );
};

/**
 * Built-in templates (less the ones an admin removed from this account), then the account's own (07 §4.3). The
 * account's: its creator or an admin renames / deletes; built-in: admins (a removal hides it for the account, an
 * edit makes an account copy in its place).
 */
export const listTemplates = async (db: Db, a: Actor) => {
  const hidden = await hiddenTemplates(db, a.ctx.accountId);
  // My open working boards ("טיוטה פתוחה", fix3), by template key.
  const drafts = new Map<string, string>();
  for (const b of await listTemplateDrafts(db, a.ctx.accountId, a.user.id)) {
    const mark = templateEditOf(b);
    if (mark && !drafts.has(mark.key)) drafts.set(mark.key, b.id);
  }
  return [
    ...(await listBuiltinTemplates(db)).filter((t) => !hidden.has(t.key)),
    ...(await listAccountTemplates(db, a.ctx.accountId)),
  ].map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    folder: t.category,
    account: !!t.accountId,
    can_edit: a.ctx.role === 'admin' || (!!t.accountId && t.createdBy === a.user.id),
    item_count: ((t.snapshot as { items?: unknown[] }).items ?? []).length,
    draft_board_id: drafts.get(t.key) ?? null,
  }));
};

/**
 * The account template to change for `key`: its own, or — for a built-in one (admins) — a copy made in the
 * account in its place, the built-in hidden from now on.
 */
const editableTemplate = async (db: Db, a: Actor, key: string) => {
  const own = await findAccountTemplate(db, a.ctx.accountId, key);
  if (own) {
    if (a.ctx.role !== 'admin' && own.createdBy !== a.user.id) throw new AppError('forbidden', 'not_your_template');
    return own;
  }
  const builtin = (await listBuiltinTemplates(db)).find((t) => t.key === key);
  if (!builtin || (await hiddenTemplates(db, a.ctx.accountId)).has(key)) {
    throw new AppError('not_found', 'Template not found');
  }
  if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
  const copyKey = `acct_${newId().toLowerCase()}`;
  await insertTemplate(db, {
    id: newId(),
    accountId: a.ctx.accountId,
    kind: builtin.kind,
    key: copyKey,
    name: builtin.name,
    description: builtin.description,
    category: builtin.category,
    snapshot: { ...(builtin.snapshot as Record<string, unknown>), key: copyKey },
    isBuiltin: false,
    createdBy: a.user.id,
  });
  await hideTemplate(db, a, key);
  return (await findAccountTemplate(db, a.ctx.accountId, copyKey))!;
};

/** PATCH /templates/:key — name / description (the board it makes keeps its own name). */
export const updateTemplate = async (
  db: Db,
  a: Actor,
  key: string,
  input: { name?: string; description?: string | null },
) => {
  const tpl = await editableTemplate(db, a, key);
  key = tpl.key; // a built-in one now lives on as the account's copy
  const snapshot = { ...(tpl.snapshot as Record<string, unknown>) };
  if (input.name) snapshot.name = input.name;
  if (input.description !== undefined) snapshot.description = input.description;
  await db.transaction(async (tx) => {
    await updateTemplateRow(tx, tpl.id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      snapshot,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'template.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { key, name: tpl.name, description: tpl.description },
      after: { key, ...input },
    });
  });
  return (await listTemplates(db, a)).find((t) => t.key === key)!;
};

/** DELETE /templates/:key — boards made from it stay as they are; a built-in one is hidden for the account. */
export const deleteTemplate = async (db: Db, a: Actor, key: string) => {
  const own = await findAccountTemplate(db, a.ctx.accountId, key);
  if (!own) {
    const builtin = (await listBuiltinTemplates(db)).find((t) => t.key === key);
    if (!builtin || (await hiddenTemplates(db, a.ctx.accountId)).has(key)) {
      throw new AppError('not_found', 'Template not found');
    }
    if (a.ctx.role !== 'admin') throw new AppError('forbidden', 'admin_only');
    await hideTemplate(db, a, key);
    return;
  }
  const tpl = await editableTemplate(db, a, key);
  await db.transaction(async (tx) => {
    await updateTemplateRow(tx, tpl.id, { deletedAt: new Date() });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'template.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { key, name: tpl.name },
    });
  });
};

/** The template a board is saved over (save as template → "replace"): see editableTemplate. */
export const templateToReplace = editableTemplate;

export const boardDetail = async (db: Db, access: BoardAccess, viewer: Pick<Actor, 'ctx' | 'user'>) => {
  const [columns, groups, sub] = await Promise.all([
    listColumns(db, access.board.id),
    listGroups(db, access.board.id),
    access.board.parentBoardId ? undefined : findSubBoard(db, access.board.id),
  ]);
  const b = access.board;
  const visible = columns.filter((c) => columnAllowed(access, c.restrictedView));
  const sources = await mirrorSources(db, viewer, visible);
  return {
    ...boardSummaryDto(b),
    description: b.description,
    permission_set: b.permissionSet,
    hierarchy_depth_max: effectiveDepthMax(b.hierarchyDepthMax),
    revision: b.revision,
    // Columns hidden by restrict_column_view are dropped for whoever is not allowed (05 §6.1). A mirror carries its
    // source's type for its footer summaries.
    columns: visible.map((c) => ({
      ...columnDto(c, access),
      ...(sources.has(c.id) ? { mirror_source: sources.get(c.id) } : {}),
    })),
    groups: groups.map(groupDto),
    capabilities: capabilitiesOf(access),
    created_at: b.createdAt.toISOString(),
    parent_board_id: b.parentBoardId,
    subitems_board_id: sub?.id ?? null,
    archived_at: b.archivedAt?.toISOString() ?? null,
    card: itemCardSettingsSchema.catch({ tabs: [] }).parse((b.settings as { card?: unknown }).card ?? {}),
    main_table_column_order: mainTableColumnOrderSchema
      .catch('shared')
      .parse((b.settings as { main_table_column_order?: unknown }).main_table_column_order ?? 'shared'),
    template_edit: (() => {
      const mark = templateEditOf(b);
      return mark ? { key: mark.key, name: mark.name, with_items: !!mark.with_items } : null;
    })(),
  };
};

/** A sub-board is managed through its parent (D14): no renaming, moving or deleting it on its own. */
const assertNotSubBoard = (access: BoardAccess) => {
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
};

export const getBoard = async (db: Db, a: Actor, boardId: string) =>
  boardDetail(db, await loadBoardAccess(db, a.ctx, a.user, boardId), a);

/** What new boards, groups and columns start with in this account (account settings → כללי, A3). */
const accountDefaults = async (db: Db, accountId: string) => accountDefaultsOf(await getAccountSettings(db, accountId));

export const createBoard = async (db: Db, a: Actor, input: z.infer<typeof createBoardSchema>) => {
  if (!canCreateStructure(a.ctx)) throw new AppError('forbidden', 'cannot_create_board');
  const workspace = await findWorkspace(db, a.ctx.accountId, input.workspace_id);
  if (!workspace) throw new AppError('not_found', 'Workspace not found');
  const folder = input.folder_id ? await findFolder(db, a.ctx.accountId, input.folder_id) : undefined;
  if (input.folder_id && (!folder || folder.workspaceId !== workspace.id))
    throw new AppError('not_found', 'Folder not found');

  const boardId = await db.transaction(async (tx) => {
    let id: string;
    let skipped: unknown[] = [];
    if (input.template_key) {
      const template = await findTemplate(tx, a.ctx.accountId, input.template_key);
      if (!template) throw new AppError('not_found', 'Template not found');
      const res = await instantiateTemplate(tx, {
        accountId: a.ctx.accountId,
        workspaceId: workspace.id,
        folderId: folder?.id ?? null,
        createdBy: a.user.id,
        snapshot: templateSnapshotSchema.parse(template.snapshot),
        templateId: template.id,
        name: input.name,
        kind: input.kind,
      });
      id = res.boardId;
      skipped = res.skipped;
      // the template's connect-boards columns keep only boards the actor reads.
      const sub = await findSubBoard(tx, id);
      await dropUnreadableRelationTargets(tx, a, [id, ...(sub ? [sub.id] : [])]);
    } else {
      id = newId();
      const defaults = await accountDefaults(tx, a.ctx.accountId);
      const lang = await accountLocale(tx, a.ctx.accountId);
      await insertBoard(tx, {
        id,
        accountId: a.ctx.accountId,
        workspaceId: workspace.id,
        folderId: folder?.id ?? null,
        name: input.name ?? st('server.newBoard', undefined, lang),
        kind: input.kind,
        itemTerminology: defaults.item_terminology,
        position: rankBetween(await lastEntityPosition(tx, workspace.id, folder?.id ?? null), null),
        hierarchyDepthMax: 2,
        createdBy: a.user.id,
      });
      await insertBoardMember(tx, {
        boardId: id,
        userId: a.user.id,
        accountId: a.ctx.accountId,
        role: 'owner',
        addedBy: a.user.id,
      });
      await insertGroups(tx, [
        {
          id: newId(),
          accountId: a.ctx.accountId,
          boardId: id,
          title: st('server.newGroup', undefined, lang),
          color: nextGroupColor([], defaults.group_colors),
          position: rankBetween(null, null),
          createdBy: a.user.id,
        },
      ]);
      await insertColumns(tx, [
        {
          id: newId(),
          accountId: a.ctx.accountId,
          boardId: id,
          key: 'name',
          type: 'name',
          title: st('server.nameColumn', undefined, lang),
          position: rankBetween(null, null),
          width: 280,
          createdBy: a.user.id,
        },
      ]);
    }
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.created',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: id,
      after: { name: input.name, template_key: input.template_key ?? null, kind: input.kind },
      meta: skipped.length ? { skipped_columns: skipped } : undefined,
    });
    return id;
  });
  return getBoard(db, a, boardId);
};

/** The workspace a board or folder may move into (fix8): one I see, where I may create boards — or 404 / 403. */
const loadMoveTarget = async (db: Db, a: Actor, workspaceId: string) => {
  const target = await findWorkspace(db, a.ctx.accountId, workspaceId);
  const memberOf = await workspaceIdsWithMember(db, a.ctx.accountId, a.user.id);
  if (!target || !workspaceVisibleTo(target, a.ctx, memberOf)) throw new AppError('not_found', 'Workspace not found');
  if (!canCreateStructure(a.ctx)) throw new AppError('forbidden', 'cannot_create_board');
  return target;
};

/**
 * PATCH /boards/:id with `workspace_id` (fix8): to another workspace's root or one of its folders, last there.
 * Owner / admin of the board only; the board keeps its own kind, permissions and subscribers (a board from a
 * closed workspace moved to an open one is as private as it was). Its sub-board goes along.
 */
const moveBoardToWorkspace = async (
  db: Db,
  a: Actor,
  access: BoardAccess,
  input: z.infer<typeof updateBoardSchema>,
) => {
  const b = access.board;
  assertBoard(access, 'board.manage_permissions');
  const target = await loadMoveTarget(db, a, input.workspace_id!);
  const folderId = input.folder_id ?? null;
  if (folderId) {
    const folder = await findFolder(db, a.ctx.accountId, folderId);
    if (!folder || folder.workspaceId !== target.id) throw new AppError('not_found', 'Folder not found');
  }
  await db.transaction(async (tx) => {
    const position = rankBetween(await lastEntityPosition(tx, target.id, folderId), null);
    await updateBoardRow(tx, b.id, { workspaceId: target.id, folderId, position });
    const sub = await findSubBoard(tx, b.id);
    if (sub) await updateBoardRow(tx, sub.id, { workspaceId: target.id });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.moved',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: b.id,
      before: { workspace_id: b.workspaceId, folder_id: b.folderId },
      after: { workspace_id: target.id, folder_id: folderId },
      meta: { from_workspace: access.workspace.name, to_workspace: target.name },
    });
  });
};

export const updateBoard = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: z.infer<typeof updateBoardSchema>,
): Promise<Awaited<ReturnType<typeof getBoard>>> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  // A subitems board follows its board in everything but its item card (a subitem's card settings).
  if (!(
    access.board.parentBoardId &&
    Object.keys(input).every((k) => k === 'card' || input[k as keyof typeof input] === undefined)
  ))
    assertNotSubBoard(access);
  if (input.workspace_id && input.workspace_id !== access.board.workspaceId) {
    await moveBoardToWorkspace(db, a, access, input);
    const { workspace_id: _ws, folder_id: _folder, position: _position, ...rest } = input;
    if (!Object.values(rest).some((v) => v !== undefined)) return getBoard(db, a, boardId);
    return updateBoard(db, a, boardId, rest);
  }
  assertBoard(access, input.permission_set || input.kind ? 'board.manage_permissions' : 'board.update');
  const b = access.board;
  if (input.folder_id) {
    const folder = await findFolder(db, a.ctx.accountId, input.folder_id);
    if (!folder || folder.workspaceId !== b.workspaceId) throw new AppError('not_found', 'Folder not found');
  }
  // Sidebar drag (fix3): a place among the boards of the folder it ends up in (its own, or the new one).
  let position: string | undefined;
  if (input.position) {
    const folderId = input.folder_id !== undefined ? input.folder_id : b.folderId;
    // Among the boards and docs of the folder: one order in the sidebar (M8 ד0).
    const siblings = (await folderSiblings(db, a.ctx.accountId, b.workspaceId, folderId)).filter((x) => x.id !== b.id);
    position = positionAmong(siblings, input.position);
  }
  // Board-level settings kept in `boards.settings` (the item card's tabs, the default table's column order).
  const settingsPatch = {
    ...(input.card ? { card: input.card } : {}),
    ...(input.main_table_column_order ? { main_table_column_order: input.main_table_column_order } : {}),
  };
  await db.transaction(async (tx) => {
    await updateBoardRow(tx, boardId, {
      ...(input.folder_id !== undefined ? { folderId: input.folder_id } : {}),
      ...(position ? { position } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.item_terminology ? { itemTerminology: input.item_terminology } : {}),
      ...(input.permission_set ? { permissionSet: input.permission_set } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(Object.keys(settingsPatch).length ? { settings: { ...(b.settings as object), ...settingsPatch } } : {}),
    });
    // The sub-board (D14) has the same type as its board.
    const sub = input.kind ? await findSubBoard(tx, boardId) : undefined;
    if (sub) await updateBoardRow(tx, sub.id, { kind: input.kind });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: {
        name: b.name,
        description: b.description,
        item_terminology: b.itemTerminology,
        permission_set: b.permissionSet,
        kind: b.kind,
        folder_id: b.folderId,
        ...(position ? { position: b.position } : {}),
        ...(input.card ? { card: (b.settings as { card?: unknown }).card ?? null } : {}),
        ...(input.main_table_column_order
          ? {
              main_table_column_order:
                (b.settings as { main_table_column_order?: unknown }).main_table_column_order ?? 'shared',
            }
          : {}),
      },
      after: position ? { ...input, position } : input,
    });
  });
  return getBoard(db, a, boardId);
};

export const deleteBoard = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertNotSubBoard(access);
  assertBoard(access, 'board.delete');
  return db.transaction(async (tx) => {
    await updateBoardRow(tx, boardId, { deletedAt: new Date() });
    const entryId = await trashObject(tx, a, { type: 'board', id: boardId, name: access.board.name, boardId });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: { name: access.board.name, folder_id: access.board.folderId },
      meta: { trash_entry_id: entryId },
    });
  });
};

// ---- groups ----
export const createGroup = async (db: Db, a: Actor, boardId: string, input: z.infer<typeof createGroupSchema>) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'group.create');
  const siblings = await listGroups(db, boardId);
  const used = new Set(siblings.map((g) => g.color));
  const color = input.color ?? nextGroupColor(used, (await accountDefaults(db, a.ctx.accountId)).group_colors);
  const id = newId();
  await db.transaction(async (tx) => {
    await insertGroups(tx, [
      {
        id,
        accountId: a.ctx.accountId,
        boardId,
        title: input.title,
        color,
        position: positionAmong(siblings, input.position ?? 'top'),
        createdBy: a.user.id,
      },
    ]);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'group.created',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      after: { id, title: input.title, color },
    });
  });
  return groupDto((await findGroup(db, boardId, id))!);
};

const loadGroup = async (db: Db, a: Actor, boardId: string, groupId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const group = await findGroup(db, boardId, groupId);
  if (!group) throw new AppError('not_found', 'Group not found');
  return { access, group };
};

export const updateGroup = async (
  db: Db,
  a: Actor,
  boardId: string,
  groupId: string,
  input: z.infer<typeof updateGroupSchema>,
) => {
  const { access, group } = await loadGroup(db, a, boardId, groupId);
  assertBoard(access, 'group.update');
  await db.transaction(async (tx) => {
    await updateGroupRow(tx, groupId, input);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'group.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: { id: group.id, title: group.title, color: group.color },
      after: input,
    });
  });
  return groupDto((await findGroup(db, boardId, groupId))!);
};

export const reorderGroup = async (
  db: Db,
  a: Actor,
  boardId: string,
  groupId: string,
  position: Parameters<typeof positionAmong>[1],
) => {
  const { access, group } = await loadGroup(db, a, boardId, groupId);
  assertBoard(access, 'group.reorder');
  const siblings = (await listGroups(db, boardId)).filter((g) => g.id !== groupId);
  const next = positionAmong(siblings, position);
  await db.transaction(async (tx) => {
    await updateGroupRow(tx, groupId, { position: next });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'group.reordered',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      before: { position: group.position },
      after: { position: next },
    });
  });
  return groupDto((await findGroup(db, boardId, groupId))!);
};

/** Items go to trash with their group; the last group cannot be deleted (06 §2.7). */
export const deleteGroup = async (db: Db, a: Actor, boardId: string, groupId: string) => {
  const { access, group } = await loadGroup(db, a, boardId, groupId);
  assertBoard(access, 'group.delete');
  if ((await listGroups(db, boardId)).length <= 1) throw new AppError('last_group', 'A board keeps at least one group');
  await assertDeleteCode(db, a, access.board);
  return db.transaction((tx) => deleteGroupTx(tx, a, boardId, group));
};

/** The group and its items to trash, inside the caller's transaction (delete, or undo of a duplicate). */
export const deleteGroupTx = async (
  tx: Db,
  a: Actor,
  boardId: string,
  group: { id: string; title: string; color: string },
  undoOf?: string,
) => {
  const groupId = group.id;
  await updateGroupRow(tx, groupId, { deletedAt: new Date() });
  const roots = (await softDeleteItemsInGroup(tx, groupId)).map((i) => i.id);
  // Their subitems have no group of their own (D14): they go with their parents, and come back with the group
  // (`item_ids` carries the whole tree) — audit 2026-10-10, C1: they used to stay live in My Work and search.
  const subIds = [...(await liveSubtreesOf(tx, roots)).values()].flat().filter((id) => !roots.includes(id));
  if (subIds.length) await setItemsDeleted(tx, subIds, new Date());
  const itemIds = [...roots, ...subIds];
  const entryId = await trashObject(tx, a, {
    type: 'group',
    id: group.id,
    name: group.title,
    boardId,
    payload: { item_ids: itemIds },
  });
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'group.deleted',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId,
    before: { id: group.id, title: group.title, color: group.color },
    meta: { trash_entry_id: entryId, item_count: roots.length, ...(undoOf ? { undo_of: undoOf } : {}) },
  });
};

// ---- columns ----
/** Formula columns must parse, use known functions and reference columns that exist on the board (03 §2.18). */
const assertFormula = (type: string, settings: Record<string, unknown>, boardColumns: ColumnRow[], ownKey?: string) => {
  if (columnTypes.get(type)?.engine !== 'formula') return;
  const src = String(settings.formula ?? '');
  if (!src.trim()) return;
  const keys = new Set(boardColumns.map((c) => c.key).filter((k) => k !== ownKey));
  const problem = validateFormula(src, keys);
  if (problem) throw new AppError('validation_failed', `Formula: ${problem}`, { formula: src });
};
const randomSuffix = () =>
  Math.random()
    .toString(36)
    .replace(/[^a-z]/g, '')
    .slice(0, 4)
    .padEnd(4, 'x');

/**
 * two columns of a board never share a title — a taken one gets the next free number ("סטטוס 2"
 * "סטטוס 3"). Compared trimmed and case-insensitive; `exceptId` is the column being renamed.
 */
export const uniqueColumnTitle = (siblings: { id: string; title: string }[], title: string, exceptId?: string) => {
  const norm = (s: string) => s.trim().toLocaleLowerCase();
  const taken = new Set(siblings.filter((c) => c.id !== exceptId).map((c) => norm(c.title)));
  const wanted = title.trim() || title;
  if (!taken.has(norm(wanted))) return wanted;
  // "סטטוס 2" taken again counts on from its own number instead of becoming "סטטוס 2 2".
  const m = /^(.*\S)\s+(\d+)$/.exec(wanted);
  const base = m ? m[1]! : wanted;
  let n = m ? Number(m[2]) + 1 : 2;
  while (taken.has(norm(`${base} ${n}`))) n++;
  return `${base} ${n}`;
};

/** `opts.fillNewDefaults`: a creator making a column from scratch with partial settings (the AI / MCP tool). */
export const createColumn = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: z.infer<typeof createColumnSchema>,
  opts: { fillNewDefaults?: boolean } = {},
) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'column.create');
  const column = await db.transaction((tx) => createColumnTx(tx, a, boardId, input, opts));
  return columnDto(column);
};

/**
 * The create itself, inside the caller's transaction (the column API, or a bulk edit's new columns with their
 * `batchId` and `meta`). The caller checked `column.create`. Returns the new column row.
 */
export const createColumnTx = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: z.infer<typeof createColumnSchema>,
  opts: { batchId?: string; meta?: Record<string, unknown>; fillNewDefaults?: boolean } = {},
) => {
  const def = columnTypes.get(input.type);
  if (!def || def.type === 'name') throw new AppError('unknown_column_type', `Unknown column type "${input.type}"`);
  // Plans: an AI column is the plan's `ai`.
  if (def.type === 'ai') await assertFeature(db, a.ctx.accountId, 'ai');
  // A status column made without labels starts with the account's default labels (A3).
  // Two-way is set up through its own endpoint (it touches the partner board), never by plain settings.
  const given = input.settings && def.type === 'board_relation' ? withoutTwoWay(input.settings) : input.settings;
  // a column made without settings (or by a creator that fills them, `fillNewDefaults`) takes the
  // account's defaults for new columns (a numbers column's thousands separator); explicit settings win.
  const fromAccount = !given || opts.fillNewDefaults ? await accountDefaults(db, a.ctx.accountId) : null;
  const initial =
    given && !opts.fillNewDefaults
      ? given
      : def.type === 'status' && !given
        ? { labels: statusLabelsFromDefaults(fromAccount!.status_labels) }
        : withNewColumnDefaults(def, given as Record<string, unknown> | undefined, fromAccount ?? undefined);
  const settings = def.settingsSchema.safeParse(initial);
  if (!settings.success) {
    throw new AppError('validation_failed', 'Invalid column settings', { issues: settings.error.issues });
  }

  let key = input.id;
  if (key) {
    if (await findColumnByKey(db, boardId, key, true))
      throw new AppError('column_id_taken', `Column id "${key}" was used on this board`);
  } else {
    const base = def.type.slice(0, 15);
    key = (await findColumnByKey(db, boardId, base, true)) ? `${base}_${randomSuffix()}` : base;
    while (await findColumnByKey(db, boardId, key, true)) key = `${base}_${randomSuffix()}`;
  }
  if (!COLUMN_KEY_RE.test(key)) throw new AppError('validation_failed', 'Invalid column id');

  const siblings = await listColumns(db, boardId);
  assertFormula(def.type, settings.data as Record<string, unknown>, siblings);
  // r19relfilter: a relation's choice filters (views, columns of the linked boards) are checked as they are saved.
  if (def.type === 'board_relation') {
    // only boards the actor reads.
    await assertRelationTargets(db, a, boardId, settings.data as Record<string, unknown>, null);
    settings.data = await checkChoiceSettings(db, a, settings.data as Record<string, unknown>, null);
  }
  if (input.before_column_id && siblings[0]?.key === input.before_column_id) {
    throw new AppError('bad_request', 'The name column stays first');
  }
  const position = positionAmong(
    siblings.map((c) => ({ id: c.key, position: c.position })),
    input.after_column_id
      ? { after_id: input.after_column_id }
      : input.before_column_id
        ? { before_id: input.before_column_id }
        : 'bottom',
  );
  const id = newId();
  const title = uniqueColumnTitle(siblings, input.title);
  await insertColumns(db, [
    {
      id,
      accountId: a.ctx.accountId,
      boardId,
      key: key!,
      type: def.type,
      title,
      description: input.description ?? null,
      settings: settings.data as Record<string, unknown>,
      position,
      width: input.width ?? 150,
      createdBy: a.user.id,
    },
  ]);
  // An item-number column starts numbering the board's items (03 §2.19).
  if (def.type === 'item_id') {
    await syncItemIdColumn(db, { accountId: a.ctx.accountId, boardId, columnId: id, settings: settings.data });
  }
  await recordEvent(db, {
    accountId: a.ctx.accountId,
    type: 'column.created',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId,
    columnId: id,
    batchId: opts.batchId ?? null,
    after: { key, type: def.type, title },
    ...(opts.meta ? { meta: opts.meta } : {}),
  });
  return (await findColumnByKey(db, boardId, key))!;
};

const loadColumn = async (db: Db, a: Actor, boardId: string, key: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const column = await findColumnByKey(db, boardId, key);
  if (!column) throw new AppError('not_found', 'Column not found');
  return { access, column };
};

/**
 * Label columns (03 §2.5–2.6): labels still used by a cell are kept deactivated instead of deleted, and every
 * cell's text/number keys are re-derived so renamed or reordered labels show and sort correctly.
 */
const applyLabelSettings = async (
  tx: Db,
  def: AnyColumnTypeDef,
  column: { id: string; settings: Record<string, unknown> },
  settings: Record<string, unknown>,
) => {
  const stored = await columnCells(tx, column.id);
  const values = stored.flatMap((c) => {
    const v = def.valueSchema.safeParse(c.value);
    return v.success ? [{ itemId: c.itemId, value: v.data }] : [];
  });
  const used = new Set(values.flatMap((c) => def.labelIds!(c.value)));
  const prev = (column.settings.labels as { id: number }[] | undefined) ?? [];
  const merged = reconcileLabels(prev, settings.labels as { id: number }[], used);
  if (!merged.ok) throw new AppError('validation_failed', 'Duplicate label id', { error: merged.error });
  const next = { ...settings, labels: merged.labels };
  await updateCellKeys(
    tx,
    column.id,
    values.map(({ itemId, value }) => {
      const d = deriveValues(def, next, value);
      return { itemId, textValue: d.textValue, numberValue: d.numberValue };
    }),
  );
  return next;
};

/**
 * Types whose cell text comes from the value + settings alone (numbers' unit / decimals, time display…): a
 * settings change re-derives the stored text. Not people, tags or relations — their text needs names.
 */
const rederivable = (def: AnyColumnTypeDef) =>
  def.storage === 'cell' && def.engine !== 'links' && !['people', 'tags'].includes(def.type);

const rederiveCells = async (tx: Db, def: AnyColumnTypeDef, columnId: string, settings: Record<string, unknown>) => {
  const rows = (await columnCells(tx, columnId)).flatMap((c) => {
    const v = def.valueSchema.safeParse(c.value);
    if (!v.success) return [];
    const d = deriveValues(def, settings, v.data);
    return [{ itemId: c.itemId, textValue: d.textValue, numberValue: d.numberValue }];
  });
  if (rows.length) await updateCellKeys(tx, columnId, rows);
};

/**
 * The two-way pair of a relation column changes only through `setTwoWay` (it touches the partner board): plain
 * settings keep the stored pair, and while paired the column must keep linking to the partner's board alone.
 */
const keepTwoWay = (column: ColumnRow, settings: Record<string, unknown>) => {
  const stored = column.settings as { two_way?: boolean; reflection_column_id?: string; board_ids?: string[] };
  const next = withoutTwoWay(settings);
  if (!stored.two_way) return next;
  const ids = (settings.board_ids as string[] | undefined) ?? [];
  if (ids.length !== 1 || ids[0] !== stored.board_ids?.[0])
    throw new AppError('two_way_unavailable', 'A two-way column keeps its board', { reason: 'board_locked' });
  return { ...next, two_way: true, reflection_column_id: stored.reflection_column_id };
};

/** The boards a relation column's settings change takes off its list. */
const droppedBoards = (before: Record<string, unknown>, after: Record<string, unknown>) => {
  const next = new Set((after.board_ids as string[] | undefined) ?? []);
  return ((before.board_ids as string[] | undefined) ?? []).filter((id) => !next.has(id));
};

export const updateColumn = async (
  db: Db,
  a: Actor,
  boardId: string,
  key: string,
  input: z.infer<typeof updateColumnSchema>,
  /** a check box secret's markers are rewritten (decrypted) when `checkbox_visible` changes. */
  env?: AppDeps['env'],
) => {
  const { access, column } = await loadColumn(db, a, boardId, key);
  assertBoard(access, 'column.update');
  if (column.convertingId) throw new AppError('column_converting', 'The column is being converted');
  let settings: Record<string, unknown> | undefined;
  let recomputeNames = false;
  let workflowChanged = false;
  if (input.settings) {
    const def = columnTypes.get(column.type);
    const parsed = def?.settingsSchema.safeParse(input.settings);
    if (!parsed?.success)
      throw new AppError('validation_failed', 'Invalid column settings', { issues: parsed?.error.issues });
    settings = parsed.data as Record<string, unknown>;
    assertFormula(column.type, settings, await listColumns(db, boardId), column.key);
    if (column.type === 'board_relation') {
      // a board added to the column must be one the actor reads.
      await assertRelationTargets(db, a, boardId, settings, column.settings);
      settings = await checkChoiceSettings(db, a, keepTwoWay(column, settings), column.settings);
    }
    // The item name source: checked against the board's columns; a change recomputes the names.
    if (column.type === 'name')
      recomputeNames = checkNameSourceSettings(column.settings, settings, await listColumns(db, boardId));
    // a status column's workflow — kept when left out, changed by the owner or an admin only.
    const wf = await prepareWorkflowSettings(db, a, access, column, settings);
    settings = wf.settings;
    workflowChanged = wf.changed;
  }
  const def = columnTypes.get(column.type);
  // a secret column's settings guard its values — any real change takes a fresh two-factor code.
  const secretChanged = settings && def?.engine === 'secret' ? changedSecretSettings(column.settings, settings) : [];
  if (secretChanged.length) await assertMayChangeSecretSettings(db, a, column.settings);
  // the values of a column that holds some would not fit another kind (text ↔ check box).
  if (secretChanged.includes('kind') && (await secretColumnHasValues(db, column.id)))
    throw new AppError('invalid_value', 'secret_kind_has_values');
  const secretMarkers = secretChanged.includes('checkbox_visible') || secretChanged.includes('kind');
  if (secretMarkers && !env) throw new AppError('bad_request', 'secret_markers_need_env');
  const labelled = settings && def?.labelIds ? def : null;
  // a rename to a title another column has takes the next free number.
  const title = input.title ? uniqueColumnTitle(await listColumns(db, boardId), input.title, column.id) : undefined;
  await db.transaction(async (tx) => {
    if (settings && labelled) settings = await applyLabelSettings(tx, labelled, column, settings);
    else if (settings && def && rederivable(def)) await rederiveCells(tx, def, column.id, settings);
    // Derived keys that depend on settings (a phone column's default country → E.164) follow the new settings.
    if (
      settings &&
      def?.normalizeSettingsKeys?.some((k) => JSON.stringify(settings![k]) !== JSON.stringify(column.settings[k]))
    )
      await renormalizeColumn(tx, { id: column.id, type: column.type, accountId: a.ctx.accountId }, settings);
    if (settings && column.type === 'item_id') {
      await syncItemIdColumn(tx, { accountId: a.ctx.accountId, boardId, columnId: column.id, settings });
    }
    await updateColumnRow(tx, column.id, {
      ...(title ? { title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.width ? { width: input.width } : {}),
      ...(settings ? { settings } : {}),
    });
    // a board taken off a relation column takes the links to its items along (one undo for both).
    const removedBoards = settings && column.type === 'board_relation' ? droppedBoards(column.settings, settings) : [];
    const batchId = removedBoards.length ? newId() : null;
    const removedLinks = batchId
      ? await dropLinksToBoards(
          tx,
          { accountId: a.ctx.accountId, actorId: a.user.id, requestId: a.requestId },
          { ...column, settings: settings! },
          removedBoards,
          batchId,
        )
      : 0;
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: settings ? 'column.settings_changed' : 'column.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      columnId: column.id,
      before: { title: column.title, width: column.width, ...(settings ? { settings: column.settings } : {}) },
      after: title ? { ...input, title } : input,
      ...(removedLinks
        ? { batchId, meta: { removed_relation_boards: removedBoards, removed_links: removedLinks } }
        : {}),
    });
    if (secretChanged.length) await auditSecretSettings(tx, a, { ...column, boardId }, secretChanged);
    if (workflowChanged) await recordWorkflowVersion(tx, a, column, settings!.workflow);
  });
  if (secretMarkers && env)
    await syncSecretMarkers({ db, env }, a.ctx.accountId, { id: column.id, boardId, settings: settings! });
  if (recomputeNames)
    await startNameRecompute(db, { accountId: a.ctx.accountId, actorId: a.user.id, requestId: a.requestId }, boardId);
  // s4f: "date arrives" triggers that read a computed date (last updated of chosen columns) follow its settings.
  if (settings && def?.fromItem) await resyncDateTriggersOfColumn(db, a.ctx.accountId, boardId, column.key);
  return columnDto((await findColumnByKey(db, boardId, key))!);
};

export const reorderColumn = async (
  db: Db,
  a: Actor,
  boardId: string,
  key: string,
  position: Parameters<typeof positionAmong>[1],
) => {
  const { access, column } = await loadColumn(db, a, boardId, key);
  assertBoard(access, 'column.reorder');
  if (column.type === 'name') throw new AppError('bad_request', 'The name column stays first');
  const siblings = (await listColumns(db, boardId))
    .filter((c) => c.id !== column.id)
    .map((c) => ({ id: c.key, position: c.position }));
  const next = positionAmong(siblings, position);
  if (siblings[0] && next < siblings[0].position) throw new AppError('bad_request', 'The name column stays first');
  await db.transaction(async (tx) => {
    await updateColumnRow(tx, column.id, { position: next });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'column.reordered',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      columnId: column.id,
      before: { position: column.position },
      after: { position: next },
    });
  });
  return columnDto((await findColumnByKey(db, boardId, key))!);
};

/** Trash (cells kept for restore); the key stays reserved on the board (03 §1). */
export const deleteColumn = async (db: Db, a: Actor, boardId: string, key: string) => {
  const { access, column } = await loadColumn(db, a, boardId, key);
  assertBoard(access, 'column.delete');
  if (column.type === 'name') throw new AppError('bad_request', 'The name column cannot be deleted');
  if (column.convertingId) throw new AppError('column_converting', 'The column is being converted');
  assertNotNameSource(await listColumns(db, boardId), column.key);
  return db.transaction((tx) => deleteColumnTx(tx, a, column));
};

/** The delete to trash itself, inside the caller's transaction (also the undo of a bulk edit's new column). */
export const deleteColumnTx = async (tx: Db, a: Actor, column: ColumnRow, meta: Record<string, unknown> = {}) => {
  const boardId = column.boardId;
  // A two-way partner becomes one-way; this column keeps its pair settings for a restore (03 §2.16).
  await unpairTwoWay(tx, { accountId: a.ctx.accountId, actorId: a.user.id, requestId: a.requestId }, column, {
    keepOwn: true,
  });
  await updateColumnRow(tx, column.id, { deletedAt: new Date() });
  const entryId = await trashObject(tx, a, { type: 'column', id: column.id, name: column.title, boardId });
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'column.deleted',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId,
    columnId: column.id,
    before: { key: column.key, title: column.title, type: column.type },
    meta: { trash_entry_id: entryId, ...meta },
  });
};
