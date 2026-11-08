// SPDX-License-Identifier: AGPL-3.0-only
import { effectiveDepthMax } from '@bines/shared';
import {
  AppError,
  type ChoiceRemap,
  choiceFilters,
  columnTypes,
  isEmptyChoice,
  newId,
  ownWriter,
  rankBetween,
  remapChoiceSettings,
  viewChoiceQuery,
  viewSettingsSchema,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { activeItemsOfGroupRows, cellsByItemIds, listBoardItems } from '../items/items.repo';
import { boardVisibility, filterVisible } from '../items/visibility';
import { columnsFor, copyTree, type CopyInto } from '../items/duplicate.service';
import { withoutTwoWay } from '../items/relations.service';
import { assertBoard, loadBoardAccess, workspaceVisibleTo } from './boards.access';
import {
  findFolder,
  findWorkspace,
  findSubBoard,
  insertBoard,
  insertBoardMember,
  insertColumns,
  insertGroups,
  insertItemKey,
  listColumns,
  listGroups,
  prefixTaken,
  workspaceIdsWithMember,
  upsertBoardTeam,
  updateColumnRow,
} from './boards.repo';
import { lastEntityPosition } from '../docs/docs.service';
import {
  insertTemplate,
  insertViews,
  itemKeyOf,
  membersOf,
  remapLinks,
  sharedViewsOf,
  teamsOf,
  updateTemplateRow,
} from './board-copy.repo';
import { templateToReplace } from './boards.service';
import { dropUnreadableRelationTargets } from './relation-targets';
import { accountLocale, st } from '../../lib/i18n';
import { findView } from '../views/views.repo';
import { TEMPLATE_VIEW_TYPES } from '@bines/shared';

export type DuplicateMode = 'structure' | 'items' | 'items_updates';

/** Columns of one board copied onto another; returns old → new internal column ids. */
const copyColumns = async (tx: Db, a: Actor, fromBoardId: string, toBoardId: string, map: Map<string, string>) => {
  const cols = await listColumns(tx, fromBoardId);
  const rows = cols.map((c) => {
    const id = newId();
    map.set(c.id, id);
    return {
      ...c,
      id,
      boardId: toBoardId,
      // A two-way pair belongs to the original column; the copy links one-way (03 §2.16).
      settings: c.type === 'board_relation' ? withoutTwoWay(c.settings) : c.settings,
      sourceColumnId: null,
      createdBy: a.user.id,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  });
  if (rows.length) await insertColumns(tx, rows);
  return cols;
};

/** The relation columns of copied boards, with what they link to and filter by remapped (`remapChoiceSettings`). */
const remapCopiedRelations = async (tx: Db, boardIds: string[], m: ChoiceRemap) => {
  for (const boardId of boardIds)
    for (const c of await listColumns(tx, boardId)) {
      if (c.type !== 'board_relation') continue;
      const settings = remapChoiceSettings(c.settings, m);
      if (JSON.stringify(settings) !== JSON.stringify(c.settings)) await updateColumnRow(tx, c.id, { settings });
    }
};

/**
 * POST /boards/:id/duplicate (07 §4.1): structure (columns, groups, shared views, permissions, item key), then
 * optionally the items (cells, subitems, links within the board re-pointed) and their updates. The duplicator
 * owns the copy; subscribers come along only when asked. Webhooks, activity and private views are not copied.
 */
export const duplicateBoard = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: {
    mode: DuplicateMode;
    name?: string;
    folder_id?: string | null;
    workspace_id?: string;
    keep_subscribers?: boolean;
  },
) => {
  if (a.ctx.role !== 'admin' && a.ctx.role !== 'member') throw new AppError('forbidden', 'cannot_create_board');
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  if (input.mode !== 'structure') assertBoard(access, 'item.read');
  const src = access.board;
  const original = src;
  // Another Workspace (one the actor sees): its root, unless a folder of it is named.
  const workspaceId = input.workspace_id ?? original.workspaceId;
  if (workspaceId !== original.workspaceId) {
    const ws = await findWorkspace(db, a.ctx.accountId, workspaceId);
    const memberOf = await workspaceIdsWithMember(db, a.ctx.accountId, a.user.id);
    if (!ws || !workspaceVisibleTo(ws, a.ctx, memberOf)) throw new AppError('not_found', 'Workspace not found');
  }
  const folderId =
    input.folder_id !== undefined ? input.folder_id : workspaceId === original.workspaceId ? src.folderId : null;
  const folder = folderId ? await findFolder(db, a.ctx.accountId, folderId) : null;
  if (folderId && (!folder || folder.workspaceId !== workspaceId)) throw new AppError('not_found', 'Folder not found');
  const newBoardId = newId();
  const copyName =
    input.name ?? st('server.boardCopy', { name: original.name }, await accountLocale(db, a.ctx.accountId));

  await db.transaction(async (tx) => {
    await insertBoard(tx, {
      id: newBoardId,
      accountId: a.ctx.accountId,
      workspaceId,
      folderId,
      name: copyName.slice(0, 255),
      description: original.description,
      kind: original.kind,
      position: rankBetween(await lastEntityPosition(tx, workspaceId, folderId), null),
      itemTerminology: original.itemTerminology,
      hierarchyDepthMax: original.hierarchyDepthMax,
      permissionSet: original.permissionSet,
      viewItems: original.viewItems,
      viewItemsConfig: original.viewItemsConfig,
      settings: original.settings,
      createdBy: a.user.id,
    });
    await insertBoardMember(tx, {
      boardId: newBoardId,
      userId: a.user.id,
      accountId: a.ctx.accountId,
      role: 'owner',
      addedBy: a.user.id,
    });
    if (input.keep_subscribers) {
      for (const m of await membersOf(tx, src.id)) {
        if (m.userId === a.user.id) continue;
        await insertBoardMember(tx, {
          boardId: newBoardId,
          userId: m.userId,
          accountId: a.ctx.accountId,
          role: m.role,
          level: m.level,
          addedBy: a.user.id,
        });
      }
      for (const t of await teamsOf(tx, src.id)) {
        await upsertBoardTeam(tx, { ...t, boardId: newBoardId, addedBy: a.user.id, createdAt: undefined });
      }
    }

    const columnMap = new Map<string, string>();
    await copyColumns(tx, a, src.id, newBoardId, columnMap);
    // A custom item key needs a prefix of its own in the account.
    const key = await itemKeyOf(tx, src.id);
    if (key && columnMap.get(key.columnId)) {
      let prefix = key.prefix;
      for (let n = 2; await prefixTaken(tx, a.ctx.accountId, prefix); n++)
        prefix = `${key.prefix.replace(/-$/, '')}${n}-`;
      await insertItemKey(tx, {
        id: newId(),
        accountId: a.ctx.accountId,
        boardId: newBoardId,
        columnId: columnMap.get(key.columnId)!,
        prefix: prefix.slice(0, 12),
        padding: key.padding,
      });
    }

    const groupMap = new Map<string, string>();
    const groups = await listGroups(tx, src.id);
    await insertGroups(
      tx,
      groups.map((g) => {
        const id = newId();
        groupMap.set(g.id, id);
        return {
          id,
          accountId: a.ctx.accountId,
          boardId: newBoardId,
          title: g.title,
          color: g.color,
          position: g.position,
          createdBy: a.user.id,
        };
      }),
    );

    const viewMap = new Map<string, string>();
    await insertViews(
      tx,
      (await sharedViewsOf(tx, src.id)).map((v) => {
        const id = newId();
        viewMap.set(v.id, id);
        return {
          ...v,
          id,
          boardId: newBoardId,
          createdBy: a.user.id,
          revision: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      }),
    );

    // The sub-board (D14) and its columns come with the structure.
    const srcSub = await findSubBoard(tx, src.id);
    const subId = srcSub ? newId() : null;
    if (srcSub && subId) {
      await insertBoard(tx, {
        id: subId,
        accountId: a.ctx.accountId,
        workspaceId,
        folderId: null,
        parentBoardId: newBoardId,
        name: st('server.subitemsBoard', { board: copyName }, await accountLocale(tx, a.ctx.accountId)).slice(0, 255),
        kind: original.kind,
        position: rankBetween(null, null),
        hierarchyDepthMax: srcSub.hierarchyDepthMax,
        createdBy: a.user.id,
      });
      await copyColumns(tx, a, srcSub.id, subId, columnMap);
    }
    // r19relfilter: relation columns that link to this board (or its sub-board) link to the copy, and their choice
    // filters follow — the copied view, the copy's groups (columns keep their keys). Other boards stay.
    const boardMap = new Map([[src.id, newBoardId], ...(srcSub && subId ? [[srcSub.id, subId] as const] : [])]);
    await remapCopiedRelations(tx, [newBoardId, ...(subId ? [subId] : [])], {
      board: (id) => boardMap.get(id),
      view: (id) => viewMap.get(id),
      group: (id) => groupMap.get(id),
    });
    // the copy links only to boards its maker reads.
    await dropUnreadableRelationTargets(tx, a, [newBoardId, ...(subId ? [subId] : [])]);

    let itemCount = 0;
    if (input.mode !== 'structure') {
      const into: CopyInto = {
        boardOf: (b) => (b === src.id ? newBoardId : (subId ?? b)),
        columnMap,
        idMap: new Map(),
      };
      const columnsOf = await columnsFor(tx, [src.id, ...(srcSub ? [srcSub.id] : [])]);
      for (const g of groups) {
        for (const item of await activeItemsOfGroupRows(tx, g.id)) {
          await copyTree(
            tx,
            a,
            item,
            {
              groupId: groupMap.get(g.id)!,
              parentItemId: null,
              rootItemId: null,
              position: item.position,
              name: item.name,
            },
            columnsOf,
            input.mode === 'items_updates',
            into,
          );
          itemCount++;
        }
      }
      await remapLinks(tx, into.idMap);
    }

    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.duplicated',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: newBoardId,
      after: { name: copyName, mode: input.mode },
      meta: { from_board_id: src.id, item_count: itemCount },
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'board.duplicated_to',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: src.id,
      meta: { to_board_id: newBoardId },
    });
  });
  return newBoardId;
};

/**
 * POST /boards/:id/save-as-template (07 §4.3): the board's structure — columns with their own settings,
 * groups, permissions, the subitems' columns — as a template of this account (no items in MVP). New boards
 * from it come through the usual "new board" form.
 */
/** Values a template keeps: stored cells (not files, time, relations or computed ones). */
const keepsValue = (type: string) => {
  const def = columnTypes.get(type);
  return !!def && def.storage === 'cell' && !def.readOnly && !ownWriter(def) && def.engine !== 'links';
};

/** A "with items" template's items (07 §4.3): what the saver sees, up to 500, with their direct subitems. */
const templateItems = async (
  db: Db,
  a: Actor,
  access: Awaited<ReturnType<typeof loadBoardAccess>>,
  columns: Awaited<ReturnType<typeof listColumns>>,
  groups: Awaited<ReturnType<typeof listGroups>>,
  subId: string | null,
  subColumns: Awaited<ReturnType<typeof listColumns>>,
) => {
  const order = new Map(groups.map((g, i) => [g.id, i]));
  const items = (
    await filterVisible(db, await boardVisibility(db, a, access), await listBoardItems(db, access.board.id))
  )
    .filter((i) => i.depth === 0 && i.groupId)
    .sort((x, y) => order.get(x.groupId!)! - order.get(y.groupId!)! || (x.position < y.position ? -1 : 1))
    .slice(0, 500);
  const children = subId
    ? (await listBoardItems(db, subId)).filter((c) => c.depth === 1 && items.some((i) => i.id === c.parentItemId))
    : [];
  const cells = await cellsByItemIds(
    db,
    [...items, ...children].map((i) => i.id),
  );
  const keyOf = new Map([...columns, ...subColumns].filter((c) => keepsValue(c.type)).map((c) => [c.id, c.key]));
  const valuesOf = (itemId: string) =>
    Object.fromEntries(
      cells.flatMap((c) => (c.itemId === itemId && keyOf.has(c.columnId) ? [[keyOf.get(c.columnId)!, c.value]] : [])),
    );
  return items.map((i) => ({
    group_id: i.groupId!,
    name: i.name,
    cells: valuesOf(i.id),
    subitems: children.filter((c) => c.parentItemId === i.id).map((c) => ({ name: c.name, cells: valuesOf(c.id) })),
  }));
};

/**
 * A relation column in a template (r19relfilter): one-way; links to boards made together with it (`refs`) become
 * template refs (`board_refs`), and their choice filters move with them. Views are not part of a template, so a
 * filter "by a view" of such a board is kept as that view's filter (no longer live); a view that is gone or private
 * drops the filter (the column offers every item). Links to other boards stay as they are.
 */
const templateRelationSettings = async (
  db: Db,
  accountId: string,
  settings: Record<string, unknown>,
  refs: Map<string, string>,
) => {
  const base = withoutTwoWay(settings);
  const filters = choiceFilters(base);
  if (Object.keys(filters).length) {
    const next: Record<string, unknown> = { ...(base.choice_filter as Record<string, unknown>) };
    for (const [boardId, f] of Object.entries(filters)) {
      if (!refs.has(boardId) || f.mode !== 'view') continue;
      const view = await findView(db, accountId, f.view_id);
      const parsed =
        view && view.boardId === boardId && view.visibility === 'shared'
          ? viewSettingsSchema.safeParse(view.settings)
          : null;
      const filter = parsed?.success ? viewChoiceQuery(parsed.data.query).filter : undefined;
      if (filter && !isEmptyChoice({ mode: 'filter', filter })) next[boardId] = { mode: 'filter', filter };
      else delete next[boardId];
    }
    base.choice_filter = next;
  }
  const mapped = remapChoiceSettings(base, { board: (id) => refs.get(id) });
  const ids = (mapped.board_ids as string[] | undefined) ?? [];
  const local = ids.filter((id) => id.startsWith('@'));
  if (!local.length) return mapped;
  const before = (mapped.board_refs as string[] | undefined) ?? [];
  return {
    ...mapped,
    board_ids: ids.filter((id) => !id.startsWith('@')),
    board_refs: [...new Set([...before, ...local])],
  };
};

/**
 * A board as a native template snapshot (07 §4.3): columns (by key), groups, the sub-board's columns, the
 * permission set and column restrictions, and — `with_items` — what the saver sees of its items. Also "save as
 * pack" (D27 ת1) builds a data pack from these.
 */
export const boardSnapshot = async (
  db: Db,
  a: Actor,
  access: Awaited<ReturnType<typeof loadBoardAccess>>,
  input: {
    key: string;
    name: string;
    description?: string | null;
    with_items?: boolean;
    /** Other boards made together from the same set (a pack's starter kit): board id → its template ref (`@key`). */
    refs?: Map<string, string>;
  },
) => {
  const b = access.board;
  const [columns, groups, sub, boardViews] = await Promise.all([
    listColumns(db, b.id),
    listGroups(db, b.id),
    findSubBoard(db, b.id),
    sharedViewsOf(db, b.id),
  ]);
  const subColumns = sub ? await listColumns(db, sub.id) : [];
  // Links to the board itself (and its sub-board) point at the new board made from the template.
  const refs = new Map([...(input.refs ?? []), [b.id, '@self'], ...(sub ? [[sub.id, '@self_sub'] as const] : [])]);
  const relationSettings = new Map<string, Record<string, unknown>>();
  for (const c of [...columns, ...subColumns])
    if (c.type === 'board_relation')
      relationSettings.set(c.id, await templateRelationSettings(db, a.ctx.accountId, c.settings, refs));
  const toTemplateColumn = (c: (typeof columns)[number]) => ({
    id: c.key,
    title: c.title,
    type: c.type,
    description: c.description,
    settings: relationSettings.get(c.id) ?? c.settings,
    width: c.width,
  });
  return {
    native: true,
    format_version: 2,
    key: input.key,
    name: input.name,
    description: input.description ?? b.description,
    board_kind: ({ main: 'public', shareable: 'share', private: 'private' } as const)[b.kind],
    item_terminology: b.itemTerminology,
    hierarchy_depth_max: effectiveDepthMax(b.hierarchyDepthMax),
    groups: groups.map((g) => ({ id: g.id, title: g.title, color: g.color })),
    columns: columns.map(toTemplateColumn),
    subitem_columns: subColumns.map(toTemplateColumn),
    items: input.with_items ? await templateItems(db, a, access, columns, groups, sub?.id ?? null, subColumns) : [],
    permissions: {
      set: b.permissionSet,
      restrict_column_editing: Object.fromEntries(
        columns.filter((c) => c.restrictedEdit).map((c) => [c.key, ['@owner']]),
      ),
      restrict_column_view: Object.fromEntries(columns.filter((c) => c.restrictedView).map((c) => [c.key, ['@owner']])),
    },
    // Prod phase B: the board's shared views come along (not its default table, forms or extension views).
    views: boardViews
      .filter((v) => !v.isSystem && (TEMPLATE_VIEW_TYPES as readonly string[]).includes(v.type))
      .sort((x, y) => (x.position < y.position ? -1 : x.position > y.position ? 1 : 0))
      .slice(0, 30)
      .map((v) => ({ name: v.name, type: v.type, settings: v.settings })),
  };
};

export const saveAsTemplate = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: { name: string; description?: string | null; with_items?: boolean; replace_key?: string },
) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId) throw new AppError('bad_request', 'sub_board');
  assertBoard(access, 'board.update'); // owners and admins
  const b = access.board;
  const key = `acct_${newId().toLowerCase()}`;
  const snapshot = await boardSnapshot(db, a, access, {
    key,
    name: input.name,
    description: input.description,
    with_items: input.with_items,
  });
  // Save over an existing template (its key stays, boards made from it are untouched).
  if (input.replace_key) {
    const target = await templateToReplace(db, a, input.replace_key);
    await db.transaction(async (tx) => {
      await updateTemplateRow(tx, target.id, {
        name: input.name,
        description: input.description ?? target.description,
        snapshot: { ...snapshot, key: target.key },
      });
      await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'template.updated',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: b.id,
        before: { key: target.key, name: target.name },
        after: { key: target.key, name: input.name, with_items: !!input.with_items },
      });
    });
    return { key: target.key, name: input.name };
  }
  await db.transaction(async (tx) => {
    await insertTemplate(tx, {
      id: newId(),
      accountId: a.ctx.accountId,
      kind: 'board',
      key,
      name: input.name,
      description: input.description ?? null,
      category: null,
      snapshot,
      isBuiltin: false,
      sourceBoardId: b.id,
      createdBy: a.user.id,
    });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'template.created',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: b.id,
      after: { key, name: input.name },
    });
  });
  return { key, name: input.name };
};
