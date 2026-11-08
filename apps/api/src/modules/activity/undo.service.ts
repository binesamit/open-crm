// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  columnTypes,
  DERIVED_VALUE_KEYS,
  type GroupColor,
  normalizeGroupColor,
  UNDO_WINDOW_DAYS,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { findColumnById, findGroup, updateColumnRow, updateGroupRow } from '../boards/boards.repo';
import { columnCells, findItem, itemsByIds, updateItemRow } from '../items/items.repo';
import { currentCellValue, deleteItemsTx, deleteItemTx, loadItem, nameWho, writeCellTx } from '../items/items.service';
import { afterItemsRenamed, assertNameEditable } from '../items/names.service';
import { listColumns } from '../boards/boards.repo';
import { deleteColumnTx, deleteGroupTx } from '../boards/boards.service';
import { type ItemSnapshot, restoreSnapshot } from '../items/move.repo';
import { reflectItemLinks } from '../items/relations.service';
import { anyBoard, findTrashEntry } from '../trash/trash.repo';
import { bulkSecretChanged, undoBulkSecretTx } from '../secrets/secrets.service';
import { undoLinkEventTx } from '../files/files.links';
import { archivedGroup, archivedItem } from '../archive/archive.repo';
import { unarchiveBoardTx, unarchiveGroupTx, unarchiveItemTx } from '../archive/archive.service';
import { restoreEntryTx } from '../trash/trash.service';
import { type ActivityRow, batchEvents, findEvent, markUndoneMany, recordEvent } from './activity.repo';
import { conversionChanged, undoConversionTx } from '../conversions/conversions.service';
import {
  undoDashboardCreatedTx,
  undoDashboardUpdateTx,
  undoLayoutTx,
  undoWidgetEventTx,
} from '../dashboards/dashboards.service';
import { undoItemTemplateEventTx } from '../item-templates/item-templates.service';

type Payload = { before?: Record<string, unknown>; after?: Record<string, unknown>; meta?: Record<string, unknown> };
const payloadOf = (ev: { payload?: unknown }) => (ev.payload ?? {}) as Payload;

/** Key-order-insensitive JSON equality (JSONB does not keep key order). */
const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v;
/** A cell value without its derived keys (phone `e164` / `valid`): only what someone typed counts as a change. */
const withoutDerived = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).filter(([k]) => !DERIVED_VALUE_KEYS.includes(k)))
    : v;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a ?? null)) === JSON.stringify(canonical(b ?? null));

/**
 * One handler per undoable event type (07 §5.3). `changed` says whether the subject moved on since the event
 * (someone edited it again) — then undo needs `force`. `undo` writes the compensating change inside the
 * transaction and returns its event id (that event carries `meta.undo_of`).
 */
type UndoHandler = {
  /** Only events this says yes to are undoable (e.g. what a bulk edit wrote, not every `column.created`). */
  applies?: (p: Payload) => boolean;
  /**
   * Within one undo, lower phases go first (a batch: existing items, then new items, labels, new columns); per
   * event when one type plays two parts (a column's settings: labels after cells, a relation's boards before).
   */
  phase?: number | ((p: Payload) => number);
  changed?: (tx: Db, ev: ActivityRow) => Promise<boolean>;
  undo: (tx: Db, a: Actor, ev: ActivityRow) => Promise<string>;
  /** Many events of this type at once (thousands of new items); event ids in the same order. */
  undoMany?: (tx: Db, a: Actor, evs: ActivityRow[]) => Promise<string[]>;
};

/**
 * boards taken off a relation column (with their links, the batch's `cell.changed` events) are put
 * back on its list; the column's other settings stay as they are now.
 */
const undoRelationBoardsTx = async (tx: Db, a: Actor, ev: ActivityRow) => {
  const column = await findColumnById(tx, ev.columnId!);
  if (!column || column.type !== 'board_relation') throw new AppError('already_undone', 'Column not found');
  await assertBoard(await loadBoardAccess(tx, a.ctx, a.user, column.boardId), 'column.update');
  const removed = (payloadOf(ev).meta?.removed_relation_boards as string[] | undefined) ?? [];
  const now = (column.settings.board_ids as string[] | undefined) ?? [];
  const settings = { ...column.settings, board_ids: [...now, ...removed.filter((id) => !now.includes(id))] };
  await updateColumnRow(tx, column.id, { settings });
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'column.settings_changed',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: column.boardId,
    columnId: column.id,
    before: { settings: column.settings },
    after: { settings },
    meta: { undo_of: ev.id },
  });
};

/** Every delete-to-trash event is undone by restoring its trash entry. */
const restoreHandler: UndoHandler = {
  undo: async (tx, a, ev) => {
    const entryId = payloadOf(ev).meta?.trash_entry_id;
    const entry = typeof entryId === 'string' ? await findTrashEntry(tx, ev.accountId, entryId) : undefined;
    if (!entry) throw new AppError('already_undone', 'No longer in trash');
    return restoreEntryTx(tx, a, entry, ev.id);
  },
};

const itemMoveHandler: UndoHandler = {
  changed: async (tx, ev) => {
    const item = await findItem(tx, ev.accountId, ev.itemId!);
    const after = payloadOf(ev).after ?? {};
    return !item || item.groupId !== after.group_id || item.position !== after.position;
  },
  undo: async (tx, a, ev) => {
    const { item, access } = await loadItem(tx, a, ev.itemId!);
    assertBoard(access, 'item.move_group');
    const before = payloadOf(ev).before as { group_id: string | null; position: string };
    // A subitem has no group: only its place among its siblings comes back.
    if (before.group_id && !(await findGroup(tx, item.boardId, before.group_id))) {
      throw new AppError('not_found', 'Group not found');
    }
    await updateItemRow(tx, item.id, { groupId: before.group_id, position: before.position });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: item.groupId === before.group_id ? 'item.reordered' : 'item.moved_to_group',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      before: { group_id: item.groupId, position: item.position },
      after: before,
      meta: { undo_of: ev.id },
    });
  },
};

/** Archive → back (07 §5.3): the item, the group with the items archived with it, the board. */
const unarchiveHandlers: Record<string, UndoHandler> = {
  'item.archived': {
    undo: async (tx, a, ev) => {
      const item = await archivedItem(tx, ev.accountId, ev.itemId!);
      if (!item?.archivedAt) throw new AppError('already_undone', 'Not archived');
      return unarchiveItemTx(tx, a, item, ev.id);
    },
  },
  'group.archived': {
    undo: async (tx, a, ev) => {
      const id = (payloadOf(ev).before as { id?: string } | undefined)?.id;
      const group = id ? await archivedGroup(tx, ev.accountId, id) : undefined;
      if (!group?.archivedAt) throw new AppError('already_undone', 'Not archived');
      const itemIds = (payloadOf(ev).meta?.item_ids as string[] | undefined) ?? [];
      return unarchiveGroupTx(tx, a, group, itemIds, ev.id);
    },
  },
  'board.archived': {
    undo: async (tx, a, ev) => {
      const board = await anyBoard(tx, ev.boardId!);
      if (!board?.archivedAt || board.deletedAt) throw new AppError('already_undone', 'Not archived');
      return unarchiveBoardTx(tx, a, board, ev.id);
    },
  },
};

/** A duplicate is undone by trashing the copy (07 §4.2). */
const duplicateHandlers: Record<string, UndoHandler> = {
  'item.duplicated': {
    undo: async (tx, a, ev) => {
      const copy = await findItem(tx, ev.accountId, ev.itemId!);
      if (!copy) throw new AppError('already_undone', 'The copy is gone');
      return deleteItemTx(tx, a, copy, null);
    },
  },
  'group.duplicated': {
    undo: async (tx, a, ev) => {
      const after = payloadOf(ev).after as { id: string; title: string; color: string };
      const access = await loadBoardAccess(tx, a.ctx, a.user, ev.boardId!);
      assertBoard(access, 'group.delete');
      if (!(await findGroup(tx, ev.boardId!, after.id))) throw new AppError('already_undone', 'The copy is gone');
      return deleteGroupTx(tx, a, ev.boardId!, after, ev.id);
    },
  },
};

/** Moves between boards and item ↔ subitem: the item's snapshot back; the group row back (07 §3.4–3.7). */
const relocateHandler: UndoHandler = {
  changed: async (tx, ev) =>
    (await findItem(tx, ev.accountId, ev.itemId!))?.boardId !== (payloadOf(ev).after as { board_id?: string }).board_id,
  undo: async (tx, a, ev) => {
    const before = payloadOf(ev).before as unknown as ItemSnapshot;
    await assertBoard(await loadBoardAccess(tx, a.ctx, a.user, before.item.board_id), 'item.create');
    await reflectItemLinks(
      tx,
      { accountId: a.ctx.accountId, itemId: ev.itemId!, actorId: a.user.id, requestId: a.requestId },
      () => restoreSnapshot(tx, ev.itemId!, before),
    );
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: ev.type,
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: before.item.board_id,
      itemId: ev.itemId,
      after: { board_id: before.item.board_id, group_id: before.item.group_id },
      meta: { undo_of: ev.id },
    });
  },
};
const moveHandlers: Record<string, UndoHandler> = {
  'item.moved_to_board': relocateHandler,
  'item.converted': relocateHandler,
  'group.moved_to_board': {
    undo: async (tx, a, ev) => {
      const before = payloadOf(ev).before as { id: string; board_id: string; position: string };
      await updateGroupRow(tx, before.id, { boardId: before.board_id, position: before.position });
      return recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'group.moved_to_board',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: before.board_id,
        after: before,
        meta: { undo_of: ev.id },
      });
    },
  },
};

type Label = { id: number; label: string; is_deactivated?: boolean };
const isBulkEdit = (p: Payload) => p.meta?.bulk_edit === true;

/**
 * What a bulk edit / file import ("ייבוא ועריכה", B2–B3) wrote besides cells and names: its new items (to the trash,
 * all in one go), the labels it added (off their column; kept deactivated while a cell still uses one — trashed
 * items included, so a restore finds them), and its new columns (to the trash). Cells of new items and new
 * columns go with them (see `run`).
 */
const bulkHandlers: Record<string, UndoHandler> = {
  'item.created': {
    // Also an item an AI app created over MCP (AGENTS-MCP מ4), an agent run (מ6) or the assistant panel (מ12):
    // undoing the tool call / the run / the approved actions sends it to the trash. An item template's tree
    // one undo sends the new items (with their subitems) to the trash.
    applies: (p) =>
      isBulkEdit(p) ||
      p.meta?.via === 'mcp' ||
      p.meta?.via === 'ai' ||
      p.meta?.via === 'app' ||
      p.meta?.via === 'template' ||
      // subitems a popup added with its move or click.
      p.meta?.via === 'popup' ||
      !!p.meta?.agent,
    phase: 1,
    undo: async (tx, a, ev) => (await bulkHandlers['item.created']!.undoMany!(tx, a, [ev]))[0]!,
    undoMany: async (tx, a, evs) => {
      const live = new Map(
        (
          await itemsByIds(
            tx,
            a.ctx.accountId,
            evs.map((e) => e.itemId!),
          )
        ).map((i) => [i.id, i]),
      );
      // New subitems under a new item of the same batch (B4) go to the trash with it, in its entry.
      const topOf = (id: string) => {
        let top = id;
        for (let p = live.get(id)?.parentItemId; p && live.has(p); p = live.get(p)?.parentItemId) top = p;
        return top;
      };
      const list = evs.flatMap((e) =>
        live.has(e.itemId!) && topOf(e.itemId!) === e.itemId ? [live.get(e.itemId!)!] : [],
      );
      const ids = await deleteItemsTx(tx, a, list, null);
      const by = new Map(list.map((i, k) => [i.id, ids[k]!]));
      // An item already gone (deleted since) has nothing to undo: it is marked as its own.
      return evs.map((e) => (live.has(e.itemId!) ? by.get(topOf(e.itemId!)) : undefined) ?? e.id);
    },
  },
  'column.settings_changed': {
    applies: (p) =>
      (isBulkEdit(p) && Array.isArray(p.meta?.added_label_ids)) || Array.isArray(p.meta?.removed_relation_boards),
    // The relation's boards come back before its cells (a link must point to one of the column's boards).
    phase: (p) => (Array.isArray(p.meta?.removed_relation_boards) ? -1 : 2),
    undo: async (tx, a, ev) => {
      if (Array.isArray(payloadOf(ev).meta?.removed_relation_boards)) return undoRelationBoardsTx(tx, a, ev);
      const column = await findColumnById(tx, ev.columnId!);
      const def = column && columnTypes.get(column.type);
      if (!column || !def?.labelIds) throw new AppError('already_undone', 'Column not found');
      await assertBoard(await loadBoardAccess(tx, a.ctx, a.user, column.boardId), 'column.update');
      const added = new Set((payloadOf(ev).meta?.added_label_ids as number[] | undefined) ?? []);
      const used = new Set(
        (await columnCells(tx, column.id)).flatMap((c) => {
          const v = def.valueSchema.safeParse(c.value);
          return v.success ? def.labelIds!(v.data) : [];
        }),
      );
      const labels = ((column.settings.labels as Label[] | undefined) ?? []).flatMap((l) =>
        !added.has(l.id) ? [l] : used.has(l.id) ? [{ ...l, is_deactivated: true }] : [],
      );
      const settings = { ...column.settings, labels };
      await updateColumnRow(tx, column.id, { settings });
      return recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'column.settings_changed',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: column.boardId,
        columnId: column.id,
        before: { settings: column.settings },
        after: { settings },
        meta: { undo_of: ev.id },
      });
    },
  },
  'column.created': {
    applies: isBulkEdit,
    phase: 3,
    undo: async (tx, a, ev) => {
      const column = await findColumnById(tx, ev.columnId!);
      if (!column) throw new AppError('already_undone', 'Column not found');
      await assertBoard(await loadBoardAccess(tx, a.ctx, a.user, column.boardId), 'column.delete');
      return deleteColumnTx(tx, a, column, { undo_of: ev.id });
    },
  },
};

/**
 * D28: a column type conversion (or a restore from its backup) is one event; undoing it puts the type, the settings,
 * every value (from the backup) and what it changed around it back. Cells edited since → `force`.
 */
const conversionOf = (ev: { payload?: unknown }) => String(payloadOf(ev).meta?.conversion_id ?? '');
const conversionHandler: UndoHandler = {
  applies: (p) => typeof p.meta?.conversion_id === 'string' && !p.meta?.undo_of,
  changed: (tx, ev) => conversionChanged(tx, ev.accountId, conversionOf(ev)),
  undo: (tx, a, ev) => undoConversionTx(tx, a, conversionOf(ev), ev.id),
};

/** Dashboard widgets (an AI tool's change is one undoable batch, like the dashboard's own undo toast). */
const widgetHandler: UndoHandler = { undo: undoWidgetEventTx };

const HANDLERS: Record<string, UndoHandler> = {
  ...bulkHandlers,
  'column.type_changed': conversionHandler,
  ...unarchiveHandlers,
  ...moveHandlers,
  ...duplicateHandlers,
  'item.deleted': restoreHandler,
  'group.deleted': restoreHandler,
  'column.deleted': restoreHandler,
  'view.deleted': restoreHandler,
  'update.deleted': restoreHandler,
  'board.deleted': restoreHandler,
  'folder.deleted': restoreHandler,
  'workspace.deleted': restoreHandler,
  'doc.deleted': restoreHandler,
  // A file taken off a files cell went to the trash; one taken off an update did not.
  'file.removed': { ...restoreHandler, applies: (p) => typeof p.meta?.trash_entry_id === 'string' },
  // a link added to / changed in / removed from a files cell.
  'file.link_added': { undo: undoLinkEventTx },
  'file.link_changed': { undo: undoLinkEventTx },
  'file.link_removed': { undo: undoLinkEventTx },
  // an item template made, changed, deleted or brought back (an API / AI call is one undo).
  'item_template.created': { undo: undoItemTemplateEventTx },
  'item_template.updated': { applies: (p) => !!p.before, undo: undoItemTemplateEventTx },
  'item_template.deleted': { undo: undoItemTemplateEventTx },
  'item_template.restored': { undo: undoItemTemplateEventTx },
  // a dashboard made, changed, moved or deleted (an AI tool call is one undoable batch).
  'dashboard.created': { undo: undoDashboardCreatedTx },
  'dashboard.duplicated': { undo: undoDashboardCreatedTx },
  'dashboard.updated': {
    applies: (p) => !!p.before && typeof p.meta?.dashboard_id === 'string',
    undo: undoDashboardUpdateTx,
  },
  'dashboard.moved': {
    applies: (p) => !!p.before && typeof p.meta?.dashboard_id === 'string',
    undo: undoDashboardUpdateTx,
  },
  'dashboard.deleted': restoreHandler,
  'dashboard.widget_added': widgetHandler,
  'dashboard.widget_removed': widgetHandler,
  'dashboard.widget_updated': widgetHandler,
  // Layout events written before the places they replaced were kept cannot be undone.
  'dashboard.layout_changed': { applies: (p) => Array.isArray(p.before?.widgets), undo: undoLayoutTx },
  'item.moved_to_group': itemMoveHandler,
  'item.reordered': itemMoveHandler,
  // a secret an import set into an empty cell is cleared again; replaced ones can not come back.
  'secret.changed': {
    applies: (p) => p.meta?.bulk === true && p.meta?.action === 'set' && p.meta?.had === false && !p.meta?.undo_of,
    changed: bulkSecretChanged,
    undo: undoBulkSecretTx,
  },
  'cell.changed': {
    changed: async (tx, ev) =>
      !same(
        withoutDerived(await currentCellValue(tx, ev.itemId!, ev.columnId!)),
        withoutDerived(payloadOf(ev).after?.value),
      ),
    undo: (tx, a, ev) =>
      writeCellTx(tx, a, ev.itemId!, ev.columnId!, payloadOf(ev).before?.value ?? null, { undo_of: ev.id }),
  },
  'item.renamed': {
    // A computed name follows its columns: undoing those changes brings it back, not this event.
    applies: (p) => !p.meta?.computed,
    changed: async (tx, ev) => (await findItem(tx, ev.accountId, ev.itemId!))?.name !== payloadOf(ev).after?.name,
    undo: async (tx, a, ev) => {
      const { item, access } = await loadItem(tx, a, ev.itemId!);
      assertBoard(access, 'item.update');
      const name = String(payloadOf(ev).before?.name ?? item.name);
      assertNameEditable(await listColumns(tx, item.boardId), item.name, name);
      await updateItemRow(tx, item.id, { name });
      await afterItemsRenamed(tx, nameWho(a), [item.id]);
      return recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'item.renamed',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: item.boardId,
        itemId: item.id,
        before: { name: item.name },
        after: { name },
        meta: { undo_of: ev.id },
      });
    },
  },
  'group.updated': {
    changed: async (tx, ev) => {
      const after = payloadOf(ev).after as { id?: string; title?: string; color?: string };
      const groupId = (payloadOf(ev).before as { id?: string } | undefined)?.id ?? after.id;
      const group = groupId ? await findGroup(tx, ev.boardId!, groupId) : undefined;
      return (
        !group ||
        (!!after.title && group.title !== after.title) ||
        (!!after.color && group.color !== normalizeGroupColor(after.color))
      );
    },
    undo: async (tx, a, ev) => {
      const before = payloadOf(ev).before as { id?: string; title: string; color: GroupColor };
      const access = await loadBoardAccess(tx, a.ctx, a.user, ev.boardId!);
      assertBoard(access, 'group.update');
      const group = before.id ? await findGroup(tx, ev.boardId!, before.id) : undefined;
      if (!group) throw new AppError('not_undoable', 'Group not found');
      // An event written before F9 carries a legacy colour key.
      const color = normalizeGroupColor(before.color) as GroupColor;
      await updateGroupRow(tx, group.id, { title: before.title, color });
      return recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'group.updated',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: ev.boardId,
        before: { id: group.id, title: group.title, color: group.color },
        after: { title: before.title, color },
        meta: { undo_of: ev.id },
      });
    },
  },
};

const handlerOf = (ev: { type: string; payload?: unknown }) => {
  const h = HANDLERS[ev.type];
  return h && (!h.applies || h.applies(payloadOf(ev))) ? h : undefined;
};

export const isUndoable = (ev: { type: string; payload?: unknown }) => !!handlerOf(ev);

/** Whether the actor may undo this event now (the activity log's "undo" button). */
export const mayUndo = (
  a: Actor,
  ev: { type: string; payload?: unknown; actorId: string | null; undoneAt: Date | null; createdAt: Date },
) =>
  isUndoable(ev) &&
  !ev.undoneAt &&
  (ev.actorId === a.user.id || a.ctx.role === 'admin') &&
  Date.now() - ev.createdAt.getTime() <= UNDO_WINDOW_DAYS * 86_400_000;

/** The actor (or an admin) within 7 days, once (07 §5.3). */
const assertMayUndo = (a: Actor, ev: ActivityRow) => {
  if (ev.actorId !== a.user.id && a.ctx.role !== 'admin') throw new AppError('forbidden', 'not_your_action');
  if (ev.undoneAt) throw new AppError('already_undone', 'Already undone');
  if (Date.now() - ev.createdAt.getTime() > UNDO_WINDOW_DAYS * 86_400_000) {
    throw new AppError('undo_expired', 'Too old to undo');
  }
};

/**
 * Undoes events (newest first) in one transaction. Events about an item or a column that the same undo removes
 * (cells of new items, labels of new columns…) are not undone one by one: they go with it, marked as undone by its
 * removal. `alongside` (a batch's summary event) is marked as undone by the last undo event.
 */
const run = async (db: Db, a: Actor, events: ActivityRow[], force: boolean, alongside: ActivityRow[] = []) =>
  db.transaction(async (tx) => {
    const newItems = new Set(events.flatMap((e) => (e.type === 'item.created' && e.itemId ? [e.itemId] : [])));
    const newColumns = new Set(events.flatMap((e) => (e.type === 'column.created' && e.columnId ? [e.columnId] : [])));
    const goesWith = (e: ActivityRow) =>
      e.type === 'item.created' || e.type === 'column.created'
        ? null
        : e.itemId && newItems.has(e.itemId)
          ? `item:${e.itemId}`
          : e.columnId && newColumns.has(e.columnId)
            ? `column:${e.columnId}`
            : null;
    const own = events.filter((e) => !goesWith(e));
    if (!force) {
      for (const ev of own) {
        if (await handlerOf(ev)!.changed?.(tx, ev)) {
          throw new AppError('changed_since', 'The value changed since', { event_id: ev.id });
        }
      }
    }
    // Stable sort: newest first within a phase.
    const phaseOf = (ev: ActivityRow) => {
      const ph = handlerOf(ev)!.phase;
      return typeof ph === 'function' ? ph(payloadOf(ev)) : (ph ?? 0);
    };
    const order = [...own].sort((x, y) => phaseOf(x) - phaseOf(y));
    const marks: [ActivityRow, string][] = [];
    for (let i = 0; i < order.length;) {
      const h = handlerOf(order[i]!)!;
      if (h.undoMany) {
        let j = i;
        while (j < order.length && order[j]!.type === order[i]!.type) j++;
        const group = order.slice(i, j);
        const ids = await h.undoMany(tx, a, group);
        group.forEach((ev, k) => marks.push([ev, ids[k]!]));
        i = j;
      } else {
        marks.push([order[i]!, await h.undo(tx, a, order[i]!)]);
        i++;
      }
    }
    const eventIds = marks.map(([, by]) => by);
    const removedBy = new Map<string, string>();
    for (const [ev, by] of marks) {
      if (ev.type === 'item.created') removedBy.set(`item:${ev.itemId}`, by);
      else if (ev.type === 'column.created') removedBy.set(`column:${ev.columnId}`, by);
    }
    for (const ev of events) {
      const key = goesWith(ev);
      if (key) marks.push([ev, removedBy.get(key)!]);
    }
    if (eventIds.length) for (const ev of alongside) marks.push([ev, eventIds.at(-1)!]);
    await markUndoneMany(tx, marks);
    return { ok: true as const, undone: events.length, event_ids: eventIds };
  });

/** POST /activity/:id/undo — an event of a batch undoes the whole batch (one toast = one action). */
export const undoEvent = async (db: Db, a: Actor, eventId: string, force = false) => {
  const ev = await findEvent(db, a.ctx.accountId, eventId);
  if (!ev) throw new AppError('not_found', 'Event not found');
  if (ev.batchId) return undoBatch(db, a, ev.batchId, force);
  if (!isUndoable(ev)) throw new AppError('not_undoable', `${ev.type} cannot be undone`);
  assertMayUndo(a, ev);
  return run(db, a, [ev], force);
};

/**
 * POST /activity/:id/redo — redo an undone action (07 §10, Ctrl+Shift+Z): undoes the events that undid it (the
 * whole batch's). Only where the undo itself is undoable (a value, a name, a move — not a restore from trash).
 */
export const redoEvent = async (db: Db, a: Actor, eventId: string, force = false) => {
  const ev = await findEvent(db, a.ctx.accountId, eventId);
  if (!ev) throw new AppError('not_found', 'Event not found');
  const originals = ev.batchId ? await batchEvents(db, a.ctx.accountId, ev.batchId) : [ev];
  const undoers: ActivityRow[] = [];
  const seen = new Set<string>();
  for (const o of originals) {
    // Many events of a batch may share one undoer (the cells of a new item → its trashing).
    if (!o.undoneByEventId || seen.has(o.undoneByEventId)) continue;
    seen.add(o.undoneByEventId);
    const u = await findEvent(db, a.ctx.accountId, o.undoneByEventId);
    if (u && isUndoable(u) && !u.undoneAt) undoers.push(u);
  }
  if (!undoers.length) throw new AppError('not_undoable', 'Nothing to redo');
  for (const u of undoers) assertMayUndo(a, u);
  return run(db, a, undoers, force);
};

/** POST /activity/batches/:id/undo — every undoable event of the batch, newest first. */
export const undoBatch = async (db: Db, a: Actor, batchId: string, force = false) => {
  const all = await batchEvents(db, a.ctx.accountId, batchId);
  if (!all.length) throw new AppError('not_found', 'Batch not found');
  const events = all.filter((ev) => isUndoable(ev) && !ev.undoneAt);
  if (!events.length) throw new AppError(all.some((e) => e.undoneAt) ? 'already_undone' : 'not_undoable');
  for (const ev of events) assertMayUndo(a, ev);
  // A bulk action's summary event (no handler of its own) is undone with the batch.
  const summaries = all.filter((ev) => ev.type === 'batch.executed' && !ev.undoneAt);
  return run(db, a, events, force, summaries);
};
