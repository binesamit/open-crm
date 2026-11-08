// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  canCreateDashboard,
  canDashboard,
  type createDashboardSchema,
  type createWidgetSchema,
  DASHBOARD_WIDGETS_MAX,
  dashboardCapabilities,
  type DashboardLevel,
  dashboardSettingsSchema,
  type dashboardLayoutSchema,
  getWidgetDef,
  type GridItem,
  gridRectSchema,
  newId,
  nextFreeRect,
  parseWidgetSettings,
  placeWidget,
  clampRect,
  rankBetween,
  readWidgetSettings,
  type setDashboardMembersSchema,
  type updateDashboardSchema,
  type updateWidgetSchema,
  type WorkspaceEntity,
  labelColorKey,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { findMembership } from '../accounts/accounts.repo';
import {
  assertBoard,
  loadBoardAccess,
  positionAmong,
  readableBoardIds,
  workspaceVisibleTo,
} from '../boards/boards.access';
import { visibleColumns } from '../items/items.service';
import {
  boardsByIds,
  findFolder,
  findSubBoard,
  findWorkspace,
  listAccountBoards,
  listGroups,
  workspaceIdsWithMember,
} from '../boards/boards.repo';
import { folderSiblings, lastEntityPosition } from '../docs/docs.service';
import { findTeam } from '../teams/teams.repo';
import { trashObject } from '../trash/trash.service';
import { listBoardViews } from '../views/views.repo';
import { assertDashboard, type DashboardAccess, loadDashboardAccess, readableDashboards } from './dashboards.access';
import {
  type DashboardRow,
  findWidget,
  insertDashboard,
  insertDashboardMembers,
  insertWidgets,
  listDashboardMembers,
  listDashboardsInWorkspace,
  listWidgets,
  replaceDashboardMembers,
  updateDashboardRow,
  updateWidgetRow,
  userNames,
  type WidgetRow,
} from './dashboards.repo';
import { accountLocale, st } from '../../lib/i18n';
import { auditGuestShare, auditKindChange, guestsAmong, notifyShared } from '../sharing/sharing';
import { canOpenDashboard, hiddenBoardsIn, keepHiddenBoards, scrubBoards } from './dashboards.share';

export const dashboardSettingsOf = (d: Pick<DashboardRow, 'settings'>) =>
  dashboardSettingsSchema.catch({ board_ids: [], filter: {} }).parse(d.settings ?? {});

const summaryDto = (d: DashboardRow) => ({
  id: d.id,
  name: d.name,
  icon: d.icon,
  kind: d.kind,
  /** @deprecated the same as `kind` (one release, for older clients). */
  sharing: d.kind,
  workspace_id: d.workspaceId,
  folder_id: d.folderId,
  position: d.position,
});

export const widgetDto = (w: WidgetRow) => ({
  id: w.id,
  type: w.type,
  title: w.title,
  position: gridRectSchema.catch({ x: 0, y: 0, w: 4, h: 3 }).parse(w.position),
  settings: readWidgetSettings(w.type, w.settings),
});

/** Every board a dashboard's widgets read: its sources plus any board a "board view" widget embeds. */
export const dashboardBoardIds = (d: DashboardRow, widgets: WidgetRow[]) => {
  const ids = new Set(dashboardSettingsOf(d).board_ids);
  for (const w of widgets) {
    const b = (w.settings as { board_id?: unknown }).board_id;
    if (w.type === 'board_view' && typeof b === 'string') ids.add(b);
  }
  return [...ids];
};

/**
 * The boards I may pick as sources, from every workspace, in one call — the sources dialog used to load each
 * workspace's tree (one request per workspace; an account with ~150 workspaces queued "save" behind them).
 */
export const sourceOptions = async (db: Db, a: Actor) => {
  const all = await listAccountBoards(db, a.ctx.accountId);
  const readable = await readableBoardIds(
    db,
    a.ctx,
    a.user,
    all.map((b) => b.id),
  );
  return {
    data: all.filter((b) => readable.has(b.id)).map((b) => ({ id: b.id, name: b.name, workspace_id: b.workspaceId })),
  };
};

/** The source boards, split into those the viewer reads (with names) and a count of the rest. */
export const sourceBoards = async (db: Db, a: Actor, ids: string[]) => {
  const readable = await readableBoardIds(db, a.ctx, a.user, ids);
  const rows = await boardsByIds(db, a.ctx.accountId, [...readable]);
  const byId = new Map(rows.map((b) => [b.id, b]));
  const boards = ids.flatMap((id) => {
    const b = byId.get(id);
    return b && !b.parentBoardId ? [{ id: b.id, name: b.name, workspace_id: b.workspaceId }] : [];
  });
  // A guest is not told that the dashboard reads boards they cannot see — not even how many.
  return { boards, hidden: a.ctx.role === 'guest' ? 0 : ids.length - boards.length };
};

/** Widgets as this viewer may see them: for a guest, without any trace of boards they cannot read. */
export const widgetsForViewer = async (db: Db, a: Actor, widgets: WidgetRow[]) => {
  const dtos = widgets.map(widgetDto);
  const hidden = await hiddenBoardsIn(
    db,
    a,
    dtos.map((w) => w.settings),
  );
  return dtos.map((w) => ({ ...w, settings: scrubBoards(w.settings, hidden) }));
};

const detail = async (db: Db, a: Actor, access: DashboardAccess) => {
  const d = access.dashboard;
  const widgets = await listWidgets(db, d.id);
  const saved = dashboardSettingsOf(d);
  const settings = scrubBoards(saved, await hiddenBoardsIn(db, a, [saved]));
  const src = await sourceBoards(db, a, saved.board_ids);
  const names = await userNames(db, d.createdBy ? [d.createdBy] : []);
  return {
    ...summaryDto(d),
    description: d.description,
    settings,
    boards: src.boards,
    hidden_boards: src.hidden,
    widgets: await widgetsForViewer(db, a, widgets),
    capabilities: dashboardCapabilities(access.perm),
    revision: d.revision,
    created_at: d.createdAt.toISOString(),
    created_by: d.createdBy ? { id: d.createdBy, name: names.get(d.createdBy) ?? '' } : null,
    updated_at: d.updatedAt.toISOString(),
  };
};

export const getDashboard = async (db: Db, a: Actor, id: string) =>
  detail(db, a, await loadDashboardAccess(db, a.ctx, a.user, id));

/** The dashboards of a workspace as sidebar rows (M8 ד0's `entities`), only those the actor may see. */
export const workspaceDashboardEntities = async (db: Db, a: Actor, workspaceId: string): Promise<WorkspaceEntity[]> =>
  (await readableDashboards(db, a.ctx, a.user, await listDashboardsInWorkspace(db, a.ctx.accountId, workspaceId))).map(
    ({ dashboard, perm }) => ({
      type: 'dashboard' as const,
      ...summaryDto(dashboard),
      can_update: canDashboard(perm, 'dashboard.manage').ok,
      can_delete: canDashboard(perm, 'dashboard.manage').ok,
    }),
  );

/**
 * Source boards an editor sets: top-level boards of the account that the editor reads (a board one cannot see is
 * never added by them); boards already on the dashboard stay even when this editor cannot read them.
 */
const checkBoards = async (db: Db, a: Actor, ids: string[], keep: string[] = []) => {
  const unique = [...new Set(ids)];
  const fresh = unique.filter((id) => !keep.includes(id));
  const readable = await readableBoardIds(db, a.ctx, a.user, fresh);
  const rows = new Map((await boardsByIds(db, a.ctx.accountId, fresh)).map((b) => [b.id, b]));
  for (const id of fresh)
    if (!readable.has(id) || rows.get(id)?.parentBoardId)
      throw new AppError('validation_failed', 'Board not found', { board_id: id });
  return unique;
};

const visibleWorkspace = async (db: Db, a: Actor, workspaceId: string) => {
  const workspace = await findWorkspace(db, a.ctx.accountId, workspaceId);
  const memberOf = await workspaceIdsWithMember(db, a.ctx.accountId, a.user.id);
  if (!workspace || a.ctx.role === 'guest' || !workspaceVisibleTo(workspace, a.ctx, memberOf))
    throw new AppError('not_found', 'Workspace not found');
  return workspace;
};

/** POST /workspaces/:id/dashboards — last in its folder; its creator owns it (D25: members and admins). */
export const createDashboard = async (
  db: Db,
  a: Actor,
  workspaceId: string,
  input: z.infer<typeof createDashboardSchema>,
) => {
  const workspace = await visibleWorkspace(db, a, workspaceId);
  if (!canCreateDashboard(a.ctx.role) || a.ctx.boardLimit) throw new AppError('forbidden', 'cannot_create_dashboard');
  const folderId = input.folder_id ?? null;
  if (folderId) {
    const folder = await findFolder(db, a.ctx.accountId, folderId);
    if (!folder || folder.workspaceId !== workspace.id) throw new AppError('not_found', 'Folder not found');
  }
  const boardIds = await checkBoards(db, a, input.board_ids ?? []);
  const id = newId();
  const name = input.name ?? st('server.newDashboard', undefined, await accountLocale(db, a.ctx.accountId));
  await db.transaction(async (tx) => {
    await insertDashboard(tx, {
      id,
      accountId: a.ctx.accountId,
      workspaceId: workspace.id,
      folderId,
      position: rankBetween(await lastEntityPosition(tx, workspace.id, folderId), null),
      kind: input.kind,
      name,
      settings: { board_ids: boardIds, filter: {} },
      createdBy: a.user.id,
      updatedBy: a.user.id,
    });
    await insertDashboardMembers(tx, [
      {
        id: newId(),
        dashboardId: id,
        accountId: a.ctx.accountId,
        userId: a.user.id,
        level: 'owner',
        addedBy: a.user.id,
      },
    ]);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'dashboard.created',
      actorId: a.user.id,
      requestId: a.requestId,
      after: { id, name, kind: input.kind, workspace_id: workspace.id, folder_id: folderId, board_ids: boardIds },
      meta: { dashboard_id: id },
    });
  });
  return getDashboard(db, a, id);
};

/** PATCH /dashboards/:id — name, description, icon, sources and filter (owners); kind, place, workspace too. */
export const updateDashboard = async (db: Db, a: Actor, id: string, input: z.infer<typeof updateDashboardSchema>) => {
  const access = await loadDashboardAccess(db, a.ctx, a.user, id);
  assertDashboard(access, 'dashboard.edit');
  const d = access.dashboard;
  const moving = input.kind || input.workspace_id || input.folder_id !== undefined || input.position !== undefined;
  if (moving) assertDashboard(access, 'dashboard.manage');
  let workspaceId = d.workspaceId;
  if (input.workspace_id && input.workspace_id !== d.workspaceId) {
    workspaceId = (await visibleWorkspace(db, a, input.workspace_id)).id;
    if (!canCreateDashboard(a.ctx.role)) throw new AppError('forbidden', 'cannot_create_dashboard');
  }
  const movedWorkspace = workspaceId !== d.workspaceId;
  const folderId = input.folder_id !== undefined ? input.folder_id : movedWorkspace ? null : d.folderId;
  if (folderId && (input.folder_id !== undefined || movedWorkspace)) {
    const folder = await findFolder(db, a.ctx.accountId, folderId);
    if (!folder || folder.workspaceId !== workspaceId) throw new AppError('not_found', 'Folder not found');
  }
  let position: string | undefined;
  if (input.position) {
    const siblings = (await folderSiblings(db, a.ctx.accountId, workspaceId, folderId)).filter((x) => x.id !== d.id);
    position = positionAmong(siblings, input.position);
  } else if (movedWorkspace || folderId !== d.folderId) {
    position = rankBetween(await lastEntityPosition(db, workspaceId, folderId), null);
  }
  const current = dashboardSettingsOf(d);
  // A guest editor saw the settings without boards they cannot read: those stay as they were.
  const hidden = await hiddenBoardsIn(db, a, [current]);
  const settings = input.settings
    ? {
        board_ids: input.settings.board_ids
          ? await checkBoards(
              db,
              a,
              keepHiddenBoards(input.settings.board_ids, current.board_ids, hidden),
              current.board_ids,
            )
          : current.board_ids,
        filter: input.settings.filter
          ? keepHiddenBoards(input.settings.filter, current.filter, hidden)
          : current.filter,
      }
    : undefined;
  await db.transaction(async (tx) => {
    await updateDashboardRow(tx, d.id, {
      ...(input.name ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(movedWorkspace ? { workspaceId } : {}),
      ...(folderId !== d.folderId ? { folderId } : {}),
      ...(position ? { position } : {}),
      ...(settings ? { settings } : {}),
      revision: d.revision + 1,
      updatedBy: a.user.id,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: movedWorkspace ? 'dashboard.moved' : 'dashboard.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      before: {
        id: d.id,
        name: d.name,
        description: d.description,
        icon: d.icon,
        kind: d.kind,
        workspace_id: d.workspaceId,
        folder_id: d.folderId,
        position: d.position,
        settings: current,
      },
      after: { id: d.id, ...input, ...(position ? { position } : {}) },
      meta: { dashboard_id: d.id, access_changed: !!input.kind || movedWorkspace },
    });
    if (input.kind)
      await auditKindChange(tx, {
        accountId: a.ctx.accountId,
        actorId: a.user.id,
        object: { type: 'dashboard', id: d.id, name: d.name },
        from: d.kind,
        to: input.kind,
      });
  });
  return getDashboard(db, a, id);
};

/**
 * Undo of a dashboard made (an AI's `create_dashboard` / `duplicate_dashboard` is one undoable call)
 * it goes to the trash like a delete. Returns the new event id.
 */
export const undoDashboardCreatedTx = async (tx: Db, a: Actor, ev: { id: string; payload?: unknown }) => {
  const id = String(((ev.payload ?? {}) as { meta?: { dashboard_id?: unknown } }).meta?.dashboard_id ?? '');
  const access = await loadDashboardAccess(tx, a.ctx, a.user, id);
  assertDashboard(access, 'dashboard.manage');
  const d = access.dashboard;
  await updateDashboardRow(tx, d.id, { deletedAt: new Date() });
  const entryId = await trashObject(tx, a, { type: 'dashboard', id: d.id, name: d.name });
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'dashboard.deleted',
    actorId: a.user.id,
    requestId: a.requestId,
    before: { id: d.id, name: d.name, workspace_id: d.workspaceId, folder_id: d.folderId },
    meta: { trash_entry_id: entryId, dashboard_id: d.id, undo_of: ev.id },
  });
};

type DashboardBefore = {
  name?: string;
  description?: string | null;
  icon?: string | null;
  kind?: DashboardRow['kind'];
  workspace_id?: string;
  folder_id?: string | null;
  position?: string;
  settings?: unknown;
};

/** Undo of a change / move of a dashboard: what it was (name, description, sources, filter, place, who sees it). */
export const undoDashboardUpdateTx = async (tx: Db, a: Actor, ev: { id: string; payload?: unknown }) => {
  const p = (ev.payload ?? {}) as { before?: DashboardBefore; meta?: { dashboard_id?: unknown } };
  const was = p.before ?? {};
  const access = await loadDashboardAccess(tx, a.ctx, a.user, String(p.meta?.dashboard_id ?? ''));
  assertDashboard(access, 'dashboard.edit');
  const d = access.dashboard;
  const moving = (was.kind && was.kind !== d.kind) || (was.workspace_id && was.workspace_id !== d.workspaceId);
  if (moving) assertDashboard(access, 'dashboard.manage');
  if (was.workspace_id && was.workspace_id !== d.workspaceId) await visibleWorkspace(tx, a, was.workspace_id);
  const settings = was.settings
    ? dashboardSettingsOf({ settings: was.settings as DashboardRow['settings'] })
    : undefined;
  const patch = {
    ...(was.name !== undefined ? { name: was.name } : {}),
    ...(was.description !== undefined ? { description: was.description ?? '' } : {}),
    ...(was.icon !== undefined ? { icon: was.icon } : {}),
    ...(was.kind ? { kind: was.kind } : {}),
    ...(was.workspace_id ? { workspaceId: was.workspace_id } : {}),
    ...(was.folder_id !== undefined ? { folderId: was.folder_id } : {}),
    ...(was.position ? { position: was.position } : {}),
    ...(settings ? { settings } : {}),
  };
  await updateDashboardRow(tx, d.id, { ...patch, revision: d.revision + 1, updatedBy: a.user.id });
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'dashboard.updated',
    actorId: a.user.id,
    requestId: a.requestId,
    before: {
      id: d.id,
      name: d.name,
      description: d.description,
      icon: d.icon,
      kind: d.kind,
      workspace_id: d.workspaceId,
      folder_id: d.folderId,
      position: d.position,
      settings: dashboardSettingsOf(d),
    },
    after: { id: d.id, ...was },
    meta: { dashboard_id: d.id, undo_of: ev.id, access_changed: !!moving },
  });
};

/** DELETE /dashboards/:id — to trash (30 days; restore / undo). */
export const deleteDashboard = async (db: Db, a: Actor, id: string) => {
  const access = await loadDashboardAccess(db, a.ctx, a.user, id);
  assertDashboard(access, 'dashboard.manage');
  const d = access.dashboard;
  return db.transaction(async (tx) => {
    await updateDashboardRow(tx, d.id, { deletedAt: new Date() });
    const entryId = await trashObject(tx, a, { type: 'dashboard', id: d.id, name: d.name });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'dashboard.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id: d.id, name: d.name, workspace_id: d.workspaceId, folder_id: d.folderId },
      meta: { trash_entry_id: entryId, dashboard_id: d.id },
    });
  });
};

/** POST /dashboards/:id/duplicate — the widgets and settings right after it; I own the copy. */
export const duplicateDashboard = async (db: Db, a: Actor, id: string, input: { name?: string }) => {
  const access = await loadDashboardAccess(db, a.ctx, a.user, id);
  if (!canCreateDashboard(a.ctx.role)) throw new AppError('forbidden', 'cannot_create_dashboard');
  const d = access.dashboard;
  const widgets = await listWidgets(db, d.id);
  const copyId = newId();
  const name = input.name ?? `${d.name} (2)`;
  const siblings = await folderSiblings(db, a.ctx.accountId, d.workspaceId, d.folderId);
  await db.transaction(async (tx) => {
    await insertDashboard(tx, {
      id: copyId,
      accountId: a.ctx.accountId,
      workspaceId: d.workspaceId,
      folderId: d.folderId,
      position: positionAmong(siblings, { after_id: d.id }),
      kind: d.kind,
      name,
      description: d.description,
      icon: d.icon,
      settings: d.settings,
      createdBy: a.user.id,
      updatedBy: a.user.id,
    });
    await insertDashboardMembers(tx, [
      {
        id: newId(),
        dashboardId: copyId,
        accountId: a.ctx.accountId,
        userId: a.user.id,
        level: 'owner',
        addedBy: a.user.id,
      },
    ]);
    await insertWidgets(
      tx,
      widgets.map((w) => ({
        id: newId(),
        dashboardId: copyId,
        accountId: a.ctx.accountId,
        type: w.type,
        title: w.title,
        position: w.position,
        settings: w.settings,
        createdBy: a.user.id,
        updatedBy: a.user.id,
      })),
    );
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'dashboard.duplicated',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id: d.id, name: d.name },
      after: { id: copyId, name },
      meta: { dashboard_id: copyId, source_dashboard_id: d.id },
    });
  });
  return getDashboard(db, a, copyId);
};

// ---- members ----
export const getDashboardMembers = async (db: Db, a: Actor, id: string) => {
  await loadDashboardAccess(db, a.ctx, a.user, id);
  // A guest sees who else is on the dashboard by name only — never the account's email addresses.
  const guest = a.ctx.role === 'guest';
  return {
    data: (await listDashboardMembers(db, id)).map((m) =>
      m.userId
        ? {
            type: 'user' as const,
            id: m.userId,
            name: m.userName ?? '',
            email: guest ? null : (m.email ?? null),
            level: m.level,
          }
        : { type: 'team' as const, id: m.teamId!, name: m.teamName ?? '', email: null, level: m.level },
    ),
  };
};

/**
 * PUT /dashboards/:id/members — the whole list (owners, admins). People must be active members of the account (a
 * guest only on a shareable dashboard, never as its owner — like a shareable board); teams the account's; a
 * dashboard keeps a person (not a guest) who owns it. Newly added people hear about it; guests are audited.
 */
export const setDashboardMembers = async (
  db: Db,
  a: Actor,
  id: string,
  input: z.infer<typeof setDashboardMembersSchema>,
) => {
  const access = await loadDashboardAccess(db, a.ctx, a.user, id);
  assertDashboard(access, 'dashboard.manage');
  const seen = new Set<string>();
  const rows: { type: 'user' | 'team'; id: string; level: DashboardLevel }[] = [];
  for (const m of input.members) {
    const key = `${m.type}:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (m.type === 'user') {
      const membership = await findMembership(db, a.ctx.accountId, m.id);
      if (!membership || membership.status === 'deactivated')
        throw new AppError('validation_failed', 'Not a member of the account', { user_id: m.id });
      if (membership.role === 'guest' && access.dashboard.kind !== 'shareable')
        throw new AppError('validation_failed', 'guests_only_on_shareable', { user_id: m.id });
      if (membership.role === 'guest' && m.level === 'owner')
        throw new AppError('validation_failed', 'guest_cannot_own', { user_id: m.id });
    } else if (!(await findTeam(db, a.ctx.accountId, m.id))) {
      throw new AppError('validation_failed', 'Team not found', { team_id: m.id });
    }
    rows.push(m);
  }
  if (!rows.some((r) => r.type === 'user' && r.level === 'owner'))
    throw new AppError('validation_failed', 'dashboard_needs_owner');
  const before = (await getDashboardMembers(db, a, id)).data.map((m) => ({ type: m.type, id: m.id, level: m.level }));
  const beforeUsers = new Set(before.filter((m) => m.type === 'user').map((m) => m.id));
  const afterUsers = new Set(rows.filter((r) => r.type === 'user').map((r) => r.id));
  const guests = await guestsAmong(db, a.ctx.accountId, [...beforeUsers, ...afterUsers]);
  const object = { type: 'dashboard' as const, id, name: access.dashboard.name };
  await db.transaction(async (tx) => {
    await replaceDashboardMembers(
      tx,
      id,
      rows.map((r) => ({
        id: newId(),
        dashboardId: id,
        accountId: a.ctx.accountId,
        userId: r.type === 'user' ? r.id : null,
        teamId: r.type === 'team' ? r.id : null,
        level: r.level,
        addedBy: a.user.id,
      })),
    );
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'dashboard.members_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { id, members: before },
      after: { id, members: rows },
      meta: { dashboard_id: id, access_changed: true },
    });
    const added = rows.filter((r) => r.type === 'user' && !beforeUsers.has(r.id));
    await auditGuestShare(tx, {
      accountId: a.ctx.accountId,
      actorId: a.user.id,
      object,
      added: added.filter((r) => guests.has(r.id)).map((r) => ({ userId: r.id, level: r.level })),
      removed: [...beforeUsers].filter((u) => guests.has(u) && !afterUsers.has(u)),
    });
    await notifyShared(
      tx,
      a.ctx.account,
      object,
      a.user.id,
      added.map((r) => r.id),
      canOpenDashboard(id),
    );
  });
  return getDashboardMembers(db, a, id);
};

// ---- widgets ----
const widgetEvent = (
  tx: Db,
  a: Actor,
  dashboardId: string,
  type: string,
  before: unknown,
  after: unknown,
  widgetId: string,
  meta: Record<string, unknown> = {},
) =>
  recordEvent(tx, {
    accountId: a.ctx.accountId,
    type,
    actorId: a.user.id,
    requestId: a.requestId,
    before,
    after,
    meta: { dashboard_id: dashboardId, widget_id: widgetId, ...meta },
  });

/** A board a "board view" widget embeds must be one the editor reads (like a source board). */
const checkWidgetBoards = async (db: Db, a: Actor, type: string, settings: Record<string, unknown>, keep?: unknown) => {
  if (type === 'board_view' && typeof settings.board_id === 'string' && settings.board_id !== keep)
    await checkBoards(db, a, [settings.board_id]);
};

/** POST /dashboards/:id/widgets — a widget of a registry type, under everything (or where it was dropped). */
export const createWidget = async (db: Db, a: Actor, id: string, input: z.infer<typeof createWidgetSchema>) => {
  const access = await loadDashboardAccess(db, a.ctx, a.user, id);
  assertDashboard(access, 'dashboard.edit');
  const def = getWidgetDef(input.type);
  const settings = parseWidgetSettings(input.type, input.settings ?? def.defaultSettings);
  await checkWidgetBoards(db, a, input.type, settings);
  const existing = await listWidgets(db, id);
  if (existing.length >= DASHBOARD_WIDGETS_MAX) throw new AppError('validation_failed', 'too_many_widgets');
  const items: GridItem[] = existing.map((w) => ({ id: w.id, rect: widgetDto(w).position }));
  const widgetId = newId();
  const rect = input.position ? clampRect(input.position, def.minSize) : nextFreeRect(items, def.defaultSize);
  const layout = placeWidget([...items, { id: widgetId, rect }], widgetId, rect);
  await db.transaction(async (tx) => {
    await insertWidgets(tx, [
      {
        id: widgetId,
        dashboardId: id,
        accountId: a.ctx.accountId,
        type: input.type,
        title: input.title ?? '',
        position: layout.find((l) => l.id === widgetId)!.rect,
        settings,
        createdBy: a.user.id,
        updatedBy: a.user.id,
      },
    ]);
    for (const l of layout)
      if (l.id !== widgetId && JSON.stringify(l.rect) !== JSON.stringify(items.find((i) => i.id === l.id)?.rect))
        await updateWidgetRow(tx, l.id, { position: l.rect });
    await widgetEvent(tx, a, id, 'dashboard.widget_added', undefined, { id: widgetId, type: input.type }, widgetId);
  });
  return (await widgetsForViewer(db, a, [(await findWidget(db, a.ctx.accountId, widgetId))!]))[0]!;
};

const loadWidget = async (db: Db, a: Actor, widgetId: string, withDeleted = false) => {
  const w = await findWidget(db, a.ctx.accountId, widgetId, withDeleted);
  if (!w) throw new AppError('not_found', 'Widget not found');
  const access = await loadDashboardAccess(db, a.ctx, a.user, w.dashboardId);
  return { w, access };
};

/** One widget as the viewer may see it (AI tools). */
export const getWidget = async (db: Db, a: Actor, widgetId: string) => {
  const { w } = await loadWidget(db, a, widgetId);
  return { dashboard_id: w.dashboardId, ...(await widgetsForViewer(db, a, [w]))[0]! };
};

/** PATCH /dashboard-widgets/:id — title and settings (owners). */
export const updateWidget = async (db: Db, a: Actor, widgetId: string, input: z.infer<typeof updateWidgetSchema>) => {
  const { w, access } = await loadWidget(db, a, widgetId);
  assertDashboard(access, 'dashboard.edit');
  // A guest editor saw the widget without boards they cannot read: what named those stays as it was.
  const hidden = input.settings ? await hiddenBoardsIn(db, a, [w.settings]) : new Set<string>();
  const settings = input.settings
    ? parseWidgetSettings(w.type, keepHiddenBoards(input.settings, w.settings, hidden))
    : undefined;
  if (settings) await checkWidgetBoards(db, a, w.type, settings, (w.settings as { board_id?: unknown }).board_id);
  await db.transaction(async (tx) => {
    await updateWidgetRow(tx, w.id, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(settings ? { settings } : {}),
      updatedBy: a.user.id,
    });
    await widgetEvent(
      tx,
      a,
      w.dashboardId,
      'dashboard.widget_updated',
      { title: w.title, settings: w.settings },
      input,
      w.id,
    );
  });
  return (await widgetsForViewer(db, a, [(await findWidget(db, a.ctx.accountId, w.id))!]))[0]!;
};

/** DELETE /dashboard-widgets/:id (soft; `restore` brings it back — the undo toast). */
export const deleteWidget = async (db: Db, a: Actor, widgetId: string) => {
  const { w, access } = await loadWidget(db, a, widgetId);
  assertDashboard(access, 'dashboard.edit');
  return db.transaction(async (tx) => {
    await updateWidgetRow(tx, w.id, { deletedAt: new Date() });
    return widgetEvent(tx, a, w.dashboardId, 'dashboard.widget_removed', { id: w.id, type: w.type }, undefined, w.id);
  });
};

export const restoreWidget = async (db: Db, a: Actor, widgetId: string) => {
  const { w, access } = await loadWidget(db, a, widgetId, true);
  assertDashboard(access, 'dashboard.edit');
  const others = (await listWidgets(db, w.dashboardId)).map((x) => ({ id: x.id, rect: widgetDto(x).position }));
  const rect = widgetDto(w).position;
  const layout = placeWidget([...others, { id: w.id, rect }], w.id, rect);
  await db.transaction(async (tx) => {
    await updateWidgetRow(tx, w.id, { deletedAt: null });
    for (const l of layout) await updateWidgetRow(tx, l.id, { position: l.rect });
    await widgetEvent(tx, a, w.dashboardId, 'dashboard.widget_added', undefined, { id: w.id, type: w.type }, w.id);
  });
  return (await widgetsForViewer(db, a, [(await findWidget(db, a.ctx.accountId, w.id))!]))[0]!;
};

/** PUT /dashboards/:id/layout — every widget's place after a drag or a resize, compacted like the client does. */
export const saveLayout = async (db: Db, a: Actor, id: string, input: z.infer<typeof dashboardLayoutSchema>) => {
  const access = await loadDashboardAccess(db, a.ctx, a.user, id);
  assertDashboard(access, 'dashboard.edit');
  const widgets = await listWidgets(db, id);
  const asked = new Map(input.widgets.map((w) => [w.id, w.position]));
  let items: GridItem[] = widgets.map((w) => {
    const min = widgetTypesMin(w.type);
    return { id: w.id, rect: clampRect(asked.get(w.id) ?? widgetDto(w).position, min) };
  });
  // No overlaps whatever was sent: each asked rect in reading order keeps its place.
  for (const it of [...items].sort((p, q) => p.rect.y - q.rect.y || p.rect.x - q.rect.x))
    items = placeWidget(items, it.id, items.find((x) => x.id === it.id)!.rect);
  await db.transaction(async (tx) => {
    for (const it of items) await updateWidgetRow(tx, it.id, { position: it.rect });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'dashboard.layout_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      before: { widgets: widgets.map((w) => ({ id: w.id, position: widgetDto(w).position })) },
      after: { widgets: items.map((i) => ({ id: i.id, position: i.rect })) },
      meta: { dashboard_id: id },
    });
  });
  return { widgets: await widgetsForViewer(db, a, await listWidgets(db, id)) };
};

type UndoneEvent = { id: string; type: string; payload?: unknown };
type WidgetPayload = {
  before?: { title?: string; settings?: unknown; widgets?: { id: string; position: unknown }[] };
  meta?: { dashboard_id?: string; widget_id?: string };
};

/**
 * Undo of a widget event (the activity log, an AI tool's batch): an added widget is removed again
 * a removed one comes back to its place, a changed one gets its title and settings back. Returns the new event id.
 */
export const undoWidgetEventTx = async (tx: Db, a: Actor, ev: UndoneEvent) => {
  const p = (ev.payload ?? {}) as WidgetPayload;
  const { w, access } = await loadWidget(tx, a, String(p.meta?.widget_id ?? ''), true);
  assertDashboard(access, 'dashboard.edit');
  const undo = { undo_of: ev.id };
  if (ev.type === 'dashboard.widget_added') {
    if (w.deletedAt) throw new AppError('not_undoable', 'Widget already removed');
    await updateWidgetRow(tx, w.id, { deletedAt: new Date() });
    return widgetEvent(
      tx,
      a,
      w.dashboardId,
      'dashboard.widget_removed',
      { id: w.id, type: w.type },
      undefined,
      w.id,
      undo,
    );
  }
  if (ev.type === 'dashboard.widget_removed') {
    if (!w.deletedAt) throw new AppError('not_undoable', 'Widget not removed');
    const others = (await listWidgets(tx, w.dashboardId)).map((x) => ({ id: x.id, rect: widgetDto(x).position }));
    if (others.length >= DASHBOARD_WIDGETS_MAX) throw new AppError('validation_failed', 'too_many_widgets');
    const rect = widgetDto(w).position;
    await updateWidgetRow(tx, w.id, { deletedAt: null });
    for (const l of placeWidget([...others, { id: w.id, rect }], w.id, rect))
      await updateWidgetRow(tx, l.id, { position: l.rect });
    return widgetEvent(
      tx,
      a,
      w.dashboardId,
      'dashboard.widget_added',
      undefined,
      { id: w.id, type: w.type },
      w.id,
      undo,
    );
  }
  if (w.deletedAt) throw new AppError('not_undoable', 'Widget removed');
  const before = {
    title: p.before?.title ?? w.title,
    settings: readWidgetSettings(w.type, p.before?.settings ?? w.settings),
  };
  await updateWidgetRow(tx, w.id, { ...before, updatedBy: a.user.id });
  return widgetEvent(
    tx,
    a,
    w.dashboardId,
    'dashboard.widget_updated',
    { title: w.title, settings: w.settings },
    before,
    w.id,
    undo,
  );
};

/** Undo of a layout change: the widgets still on the dashboard go back to where they were. */
export const undoLayoutTx = async (tx: Db, a: Actor, ev: UndoneEvent) => {
  const p = (ev.payload ?? {}) as WidgetPayload;
  const access = await loadDashboardAccess(tx, a.ctx, a.user, String(p.meta?.dashboard_id ?? ''));
  assertDashboard(access, 'dashboard.edit');
  const widgets = await listWidgets(tx, access.dashboard.id);
  const was = new Map((p.before?.widgets ?? []).map((x) => [x.id, gridRectSchema.safeParse(x.position).data]));
  let items: GridItem[] = widgets.map((w) => ({ id: w.id, rect: was.get(w.id) ?? widgetDto(w).position }));
  for (const it of [...items].sort((x, y) => x.rect.y - y.rect.y || x.rect.x - y.rect.x))
    items = placeWidget(items, it.id, items.find((x) => x.id === it.id)!.rect);
  for (const it of items) await updateWidgetRow(tx, it.id, { position: it.rect });
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'dashboard.layout_changed',
    actorId: a.user.id,
    requestId: a.requestId,
    before: { widgets: widgets.map((w) => ({ id: w.id, position: widgetDto(w).position })) },
    after: { widgets: items.map((i) => ({ id: i.id, position: i.rect })) },
    meta: { dashboard_id: access.dashboard.id, undo_of: ev.id },
  });
};

const widgetTypesMin = (type: string) => {
  try {
    return getWidgetDef(type).minSize;
  } catch {
    return { w: 1, h: 1 };
  }
};

// ---- columns of the sources (widget pickers) ----
type LabelSettings = { labels?: { label?: string; color?: string; deactivated?: boolean }[] };

/** GET /dashboards/:id/columns — what the viewer may see of the sources' columns, merged by type + title. */
export const dashboardColumns = async (db: Db, a: Actor, id: string) => {
  const access = await loadDashboardAccess(db, a.ctx, a.user, id);
  const { boards } = await sourceBoards(db, a, dashboardSettingsOf(access.dashboard).board_ids);
  return columnsOfBoards(db, a, boards);
};

/** GET /boards/:id/widget-columns (round 15) — the same for a board's Dashboard view: the board and its sub-board. */
export const boardWidgetColumns = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  return columnsOfBoards(db, a, [{ id: access.board.id, name: access.board.name }]);
};

/**
 * The widget pickers' columns of some source boards — each board, then its sub-board (round 15: a widget may read
 * subitems; the entry says whose subitems it holds) — merged by type + title, as the viewer may see them.
 */
const columnsOfBoards = async (db: Db, a: Actor, boards: { id: string; name: string }[]) => {
  const out = [];
  const merged = new Map<
    string,
    { type: string; title: string; keys: Record<string, string>; labels: Map<string, string> }
  >();
  const sources: { id: string; name: string; subitemsOf: string | null }[] = [];
  for (const b of boards) {
    sources.push({ id: b.id, name: b.name, subitemsOf: null });
    const sub = await findSubBoard(db, b.id);
    if (sub) sources.push({ id: sub.id, name: b.name, subitemsOf: b.id });
  }
  for (const b of sources) {
    const boardAccess = await loadBoardAccess(db, a.ctx, a.user, b.id);
    const [columns, groups, views] = await Promise.all([
      visibleColumns(db, boardAccess),
      listGroups(db, b.id),
      b.subitemsOf ? Promise.resolve([]) : listBoardViews(db, b.id, a.user.id),
    ]);
    out.push({
      id: b.id,
      name: b.name,
      subitems_of: b.subitemsOf,
      columns: columns.map((c) => ({ id: c.key, type: c.type, title: c.title })),
      groups: groups.map((g) => ({ id: g.id, title: g.title })),
      views: views.map((v) => ({ id: v.id, name: v.name })),
    });
    for (const c of columns) {
      const k = `${c.type}\u0000${c.title.trim().toLocaleLowerCase()}`;
      const m = merged.get(k) ?? { type: c.type, title: c.title, keys: {}, labels: new Map<string, string>() };
      m.keys[b.id] = c.key;
      for (const l of (c.settings as LabelSettings).labels ?? [])
        if (l.label && !l.deactivated && !m.labels.has(l.label)) m.labels.set(l.label, labelColorKey(l.color));
      merged.set(k, m);
    }
  }
  return {
    boards: out,
    columns: [...merged.values()].map((m) => ({
      type: m.type,
      title: m.title,
      keys: m.keys,
      labels: [...m.labels].map(([label, color]) => ({ label, color })),
    })),
  };
};
