// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  canBoard,
  type createViewSchema,
  newId,
  parseViewWidgets,
  rankBetween,
  remapViewSettings,
  t,
  type updateViewSchema,
  type View,
  viewPrefsSchema,
  viewSettingsSchema,
  type ViewPrefs,
  arrangeViews,
  type ViewLayout,
  viewLayoutSchema,
} from '@bines/shared';
import { assertFeature } from '../billing/entitlements';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { type BoardAccess, assertBoard, loadBoardAccess, positionAmong } from '../boards/boards.access';
import { listColumns } from '../boards/boards.repo';
import {
  boardPrefsOf,
  saveBoardPrefsSettings,
  clearDefault,
  countSharedViews,
  deleteViewPrefs,
  findView,
  insertView,
  listBoardViews,
  prefsForViews,
  saveViewSettings,
  setLastView,
  updateViewRow,
  upsertViewPrefs,
  type ViewRow,
} from './views.repo';
import { trashObject } from '../trash/trash.service';
import { notifyChoiceViewGone } from './view-dependents';

/** A Dashboard view's widgets (round 15) are validated like a dashboard's (400 on bad settings). */
const checkedSettings = <S extends { dashboard?: { widgets: { type: string; settings: Record<string, unknown> }[] } }>(
  s: S | undefined,
): S | undefined =>
  s?.dashboard ? { ...s, dashboard: { ...s.dashboard, widgets: parseViewWidgets(s.dashboard.widgets) } } : s;

/** 15 §6 — shared views per board; private views don't count. */
export const MAX_SHARED_VIEWS = 100;

const can = (access: BoardAccess, action: 'view.create' | 'view.update' | 'view.manage') =>
  canBoard(access.perm, action).ok;

/**
 * Who may do what with a view (15 §3, §5): private views belong to their creator; shared ones are saved by
 * their creator or board editors; locked ones only by board owners/admins (others work as a draft).
 */
const rights = (access: BoardAccess, view: ViewRow, userId: string) => {
  const mine = view.createdBy === userId;
  const manage = can(access, 'view.manage');
  // The default table never changes: saving a change there creates a new view.
  const save = view.isSystem
    ? false
    : view.visibility === 'private'
      ? mine
      : view.isLocked
        ? manage
        : manage || can(access, 'view.update') || (mine && can(access, 'view.create'));
  return {
    save,
    manage: view.visibility === 'private' ? mine : manage,
    delete: !view.isSystem && (view.visibility === 'private' ? mine : manage || (mine && can(access, 'view.create'))),
  };
};

const viewDto = (
  access: BoardAccess,
  view: ViewRow,
  userId: string,
  prefs: Record<string, unknown> | undefined,
  pinned = false,
): View => {
  const r = rights(access, view, userId);
  const settings = viewSettingsSchema.safeParse(view.settings);
  const myPrefs = viewPrefsSchema.safeParse(prefs ?? {});
  return {
    id: view.id,
    board_id: view.boardId,
    type: view.type as View['type'],
    name: view.name,
    position: view.position,
    is_default: view.isDefault,
    is_system: view.isSystem,
    is_locked: view.isLocked,
    visibility: view.visibility,
    created_by: view.createdBy,
    revision: view.revision,
    // Settings saved before a schema change fall back to defaults instead of breaking the board.
    settings: settings.success ? settings.data : viewSettingsSchema.parse({}),
    prefs: myPrefs.success ? myPrefs.data : {},
    pinned,
    can_save: r.save,
    can_manage: r.manage,
    can_delete: r.delete,
  };
};

/** Every board has a default table (15 §4); boards created before views existed get theirs on first open. */
const ensureMainTable = async (db: Db, a: Actor, access: BoardAccess, rows: ViewRow[]) => {
  if (rows.some((v) => v.isSystem)) return false;
  await insertView(db, {
    id: newId(),
    accountId: a.ctx.accountId,
    boardId: access.board.id,
    type: 'table',
    name: t('view.mainTable'),
    settings: viewSettingsSchema.parse({}),
    isSystem: true,
    isDefault: !rows.some((v) => v.isDefault),
    position: rankBetween(null, rows[0]?.position ?? null),
    createdBy: null,
  });
  return true;
};

const layoutOf = (settings: Record<string, unknown> | undefined): ViewLayout => {
  const parsed = viewLayoutSchema.safeParse(settings?.layout ?? {});
  return parsed.success ? parsed.data : viewLayoutSchema.parse({});
};

export const listViews = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  let rows = await listBoardViews(db, boardId, a.user.id);
  if (await ensureMainTable(db, a, access, rows)) rows = await listBoardViews(db, boardId, a.user.id);
  const [prefs, boardPrefs] = await Promise.all([
    prefsForViews(
      db,
      a.user.id,
      rows.map((v) => v.id),
    ),
    boardPrefsOf(db, a.user.id, boardId),
  ]);
  const layout = layoutOf(boardPrefs?.settings);
  const last = boardPrefs?.lastViewId;
  const current = rows.find((v) => v.id === last) ?? rows.find((v) => v.isDefault) ?? rows[0]!;
  return {
    data: arrangeViews(rows, layout).map((v) => viewDto(access, v, a.user.id, prefs.get(v.id), v.pinned)),
    layout,
    current_view_id: current.id,
  };
};

/**
 * Saves my tab layout (pins + order) for a board. Personal: it changes nothing for anyone else, so reading the
 * board is enough. Ids of views I can't see are dropped.
 */
export const saveLayout = async (db: Db, a: Actor, boardId: string, input: ViewLayout) => {
  await loadBoardAccess(db, a.ctx, a.user, boardId);
  const visible = new Set((await listBoardViews(db, boardId, a.user.id)).map((v) => v.id));
  const current = await boardPrefsOf(db, a.user.id, boardId);
  const layout = {
    pinned: [...new Set(input.pinned)].filter((id) => visible.has(id)),
    order: [...new Set(input.order)].filter((id) => visible.has(id)),
  };
  await saveBoardPrefsSettings(db, {
    userId: a.user.id,
    boardId,
    accountId: a.ctx.accountId,
    settings: { ...(current?.settings ?? {}), layout },
  });
  return listViews(db, a, boardId);
};

/** A view the actor can see (another user's private view is a 404), with its board access. */
const loadView = async (db: Db, a: Actor, viewId: string) => {
  const view = await findView(db, a.ctx.accountId, viewId);
  if (!view || (view.visibility === 'private' && view.createdBy !== a.user.id))
    throw new AppError('not_found', 'View not found');
  const access = await loadBoardAccess(db, a.ctx, a.user, view.boardId);
  return { view, access };
};

const freshView = async (db: Db, a: Actor, access: BoardAccess, viewId: string) => {
  const view = (await findView(db, a.ctx.accountId, viewId))!;
  const [prefs, boardPrefs] = await Promise.all([
    prefsForViews(db, a.user.id, [viewId]),
    boardPrefsOf(db, a.user.id, view.boardId),
  ]);
  return viewDto(access, view, a.user.id, prefs.get(viewId), layoutOf(boardPrefs?.settings).pinned.includes(viewId));
};

export const createView = async (db: Db, a: Actor, boardId: string, input: z.infer<typeof createViewSchema>) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  // Plans: a form view is the plan's `forms`.
  if (input.type === 'form') await assertFeature(db, a.ctx.accountId, 'forms');
  if (input.visibility === 'shared') {
    assertBoard(access, 'view.create');
    if ((await countSharedViews(db, boardId)) >= MAX_SHARED_VIEWS)
      throw new AppError('conflict', 'view_quota', { max: MAX_SHARED_VIEWS });
  }
  const siblings = await listBoardViews(db, boardId, a.user.id);
  const id = newId();
  await db.transaction(async (tx) => {
    await insertView(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId,
      type: input.type,
      name: input.name,
      settings: checkedSettings(input.settings) ?? viewSettingsSchema.parse({}),
      visibility: input.visibility,
      position: positionAmong(siblings, input.position),
      createdBy: a.user.id,
    });
    await setLastView(tx, { userId: a.user.id, boardId, accountId: a.ctx.accountId, viewId: id });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'view.created',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      after: { id, name: input.name, type: input.type, visibility: input.visibility },
    });
  });
  return freshView(db, a, access, id);
};

/** `If-Match` (15 §7): the revision the client saw; a newer save in between → 409 "overwrite / save as new". */
export const parseIfMatch = (header: string | undefined): number | null => {
  if (!header) return null;
  const n = Number(header.replace(/^W\//, '').replace(/"/g, ''));
  if (!Number.isInteger(n)) throw new AppError('bad_request', 'Invalid If-Match');
  return n;
};

export const updateView = async (
  db: Db,
  a: Actor,
  viewId: string,
  input: z.infer<typeof updateViewSchema>,
  ifMatch: number | null,
) => {
  const { view, access } = await loadView(db, a, viewId);
  const r = rights(access, view, a.user.id);
  if (input.settings && view.isSystem) throw new AppError('forbidden', 'main_table_is_fixed');
  if (input.name && view.isSystem && !r.manage) throw new AppError('forbidden', 'cannot_edit_view');
  if (((input.settings && !view.isSystem) || (input.name && !view.isSystem)) && !r.save)
    throw new AppError('forbidden', view.isLocked ? 'view_locked' : 'cannot_edit_view');
  if ((input.is_locked !== undefined || input.is_default !== undefined) && (!r.manage || view.visibility === 'private'))
    throw new AppError('forbidden', 'cannot_manage_view');
  if (input.position && !(r.manage || can(access, 'view.update'))) throw new AppError('forbidden', 'cannot_edit_view');
  if (input.visibility === 'shared' && view.visibility === 'private') {
    assertBoard(access, 'view.create');
    if ((await countSharedViews(db, view.boardId)) >= MAX_SHARED_VIEWS)
      throw new AppError('conflict', 'view_quota', { max: MAX_SHARED_VIEWS });
  }

  const settings = checkedSettings(input.settings);
  await db.transaction(async (tx) => {
    if (settings) {
      const saved = await saveViewSettings(tx, viewId, settings, ifMatch);
      if (!saved)
        throw new AppError('revision_mismatch', 'The view was saved by someone else', { revision: view.revision });
    }
    const patch: Parameters<typeof updateViewRow>[2] = {};
    if (input.name) patch.name = input.name;
    if (input.is_locked !== undefined) patch.isLocked = input.is_locked;
    if (input.visibility) patch.visibility = input.visibility;
    if (input.position) {
      const siblings = (await listBoardViews(tx, view.boardId, a.user.id)).filter((v) => v.id !== viewId);
      patch.position = positionAmong(siblings, input.position);
    }
    if (input.is_default) {
      await clearDefault(tx, view.boardId, viewId);
      patch.isDefault = true;
    }
    if (Object.keys(patch).length) await updateViewRow(tx, viewId, patch);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'view.updated',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: view.boardId,
      before: { name: view.name, revision: view.revision, is_locked: view.isLocked },
      after: { ...input, id: viewId },
    });
  });
  return freshView(db, a, access, viewId);
};

export const deleteView = async (db: Db, a: Actor, viewId: string) => {
  const { view, access } = await loadView(db, a, viewId);
  if (view.isSystem) throw new AppError('bad_request', 'main_table_cannot_be_deleted');
  if (!rights(access, view, a.user.id).delete) throw new AppError('forbidden', 'cannot_delete_view');
  return db.transaction(async (tx) => {
    await updateViewRow(tx, viewId, { deletedAt: new Date(), isDefault: false });
    if (view.isDefault) {
      const main = (await listBoardViews(tx, view.boardId, a.user.id)).find((v) => v.isSystem);
      if (main) await updateViewRow(tx, main.id, { isDefault: true });
    }
    const entryId = await trashObject(tx, a, { type: 'view', id: viewId, name: view.name, boardId: view.boardId });
    // r19relfilter: relation columns offering "only the items of this view" lose it — their owners hear about it.
    // (A shared view cannot be made private again — `updateViewSchema` — so deleting is the only way it goes.)
    if (view.visibility === 'shared') await notifyChoiceViewGone(tx, a, view);
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'view.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: view.boardId,
      before: { id: viewId, name: view.name },
      meta: { trash_entry_id: entryId },
    });
  });
};

/**
 * Duplicate a view (15 §9) — on its board, or onto another (`boardId`): there its column references are mapped
 * to the target's columns (same key and type, else same title and type); what has no match is dropped.
 */
export const duplicateView = async (db: Db, a: Actor, viewId: string, name?: string, boardId?: string) => {
  const { view, access } = await loadView(db, a, viewId);
  if (view.type === 'form') await assertFeature(db, a.ctx.accountId, 'forms');
  const settings = viewSettingsSchema.parse(view.settings);
  if (boardId && boardId !== view.boardId) {
    const target = await loadBoardAccess(db, a.ctx, a.user, boardId);
    if (target.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
    const [from, to] = await Promise.all([listColumns(db, view.boardId), listColumns(db, boardId)]);
    const norm = (s: string) => s.trim().toLocaleLowerCase();
    const mapColumn = (key: string) => {
      const src = from.find((c) => c.key === key);
      if (!src) return null;
      const hit =
        to.find((c) => c.key === key && c.type === src.type) ??
        to.find((c) => c.type === src.type && norm(c.title) === norm(src.title));
      return hit?.key ?? null;
    };
    return createView(db, a, boardId, {
      type: view.type as View['type'],
      name: name ?? view.name,
      settings: remapViewSettings(settings, mapColumn),
      visibility: can(target, 'view.create') ? 'shared' : 'private',
    });
  }
  const visibility = view.visibility === 'shared' && can(access, 'view.create') ? 'shared' : 'private';
  return createView(db, a, view.boardId, {
    type: view.type as View['type'],
    name: name ?? t('view.copyOf', { name: view.name }),
    settings,
    visibility,
    position: { after_id: view.id },
  });
};

/** Personal overrides (15 §9.5): merged into what is stored; never touch the view's revision. */
export const savePrefs = async (db: Db, a: Actor, viewId: string, input: ViewPrefs) => {
  const { view, access } = await loadView(db, a, viewId);
  const current = viewPrefsSchema.parse((await prefsForViews(db, a.user.id, [viewId])).get(viewId) ?? {});
  await upsertViewPrefs(db, {
    userId: a.user.id,
    viewId,
    accountId: a.ctx.accountId,
    settings: { ...current, ...input },
  });
  return freshView(db, a, access, view.id);
};

export const resetPrefs = async (db: Db, a: Actor, viewId: string) => {
  const { view, access } = await loadView(db, a, viewId);
  await deleteViewPrefs(db, a.user.id, viewId);
  return freshView(db, a, access, view.id);
};

/** Remembers the view I opened last on this board (15 §7 user_board_prefs). */
export const openView = async (db: Db, a: Actor, viewId: string) => {
  const { view } = await loadView(db, a, viewId);
  await setLastView(db, { userId: a.user.id, boardId: view.boardId, accountId: a.ctx.accountId, viewId });
};
