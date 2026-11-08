// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type BulkEditRequest,
  type BulkEditSubitems,
  columnTypes,
  effectiveDepthMax,
  newId,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps } from '../../types';
import { type ActivityRow, batchEvents, recordEvent } from '../activity/activity.repo';
import { undoBatch } from '../activity/undo.service';
import { assertBoard, type BoardAccess, isOwnerOrAdmin, loadBoardAccess } from '../boards/boards.access';
import {
  type BoardRow,
  type ColumnRow,
  findSubBoard,
  listColumns,
  listGroups,
  updateColumnRow,
} from '../boards/boards.repo';
import { createColumnTx } from '../boards/boards.service';
import { findItem, itemCells, type ItemRow, itemsByIds, updateItemRow } from '../items/items.repo';
import { type Actor, assertAssigned, nameWho, writeCell } from '../items/items.service';
import { afterItemsRenamed, collectItemChanges, itemsChanged } from '../items/names.service';
import { isComputedName, nameSourceOfColumns } from '@bines/shared';
import { reparentTx } from '../items/subitems.service';
import { boardVisibility, filterVisible } from '../items/visibility';
import { ensureTags } from '../tags/tags.service';
import { insertItemsBatch } from './bulk-insert';
import { accountDataKey } from '../secrets/secret-crypto';
import {
  assertMayWriteSecretsInBatch,
  type BatchSecretResult,
  type SecretActor,
  writeSecretInBatch,
} from '../secrets/secrets.service';

type Label = { id: number; label: string; index?: number; color?: string; is_deactivated?: boolean };
const norm = (s: string) => s.trim().toLocaleLowerCase();

type Request = BulkEditRequest;
type SubRow = BulkEditSubitems['rows'][number];

/**
 * One board's part of the batch, before its rows: new columns (file import) through the column service, then new
 * labels on the column settings (ids still free, names new — someone may have edited the column: 409). Returns the
 * board's columns by key and by new-column ref.
 */
const prepareBoard = async (
  tx: Db,
  a: Actor,
  boardId: string,
  part: { columns?: Request['columns']; labels: Request['labels'] },
  rows: { cells: Record<string, unknown>; secrets?: Record<string, string> }[],
  batchId: string,
) => {
  const live = new Map<string, ColumnRow>();
  for (const c of part.columns ?? [])
    live.set(
      c.ref,
      await createColumnTx(
        tx,
        a,
        boardId,
        { title: c.title, type: c.type, ...(c.settings ? { settings: c.settings } : {}) },
        { batchId, meta: { bulk_edit: true, ref: c.ref }, fillNewDefaults: true },
      ),
    );
  const columns = await listColumns(tx, boardId);
  for (const c of columns) live.set(c.key, c);
  for (const r of rows) {
    for (const key of Object.keys(r.cells))
      if (!live.has(key)) throw new AppError('not_found', `Column "${key}" not found`);
    // secrets go to secret columns only (their cells are written by the secret engine).
    for (const key of Object.keys(r.secrets ?? {})) {
      const c = live.get(key);
      if (!c) throw new AppError('not_found', `Column "${key}" not found`);
      if (columnTypes.get(c.type)?.engine !== 'secret')
        throw new AppError('invalid_value', 'Not a secret column', { column_id: key });
    }
  }

  const labelsByColumn = new Map<string, Label[]>();
  for (const l of part.labels) {
    const column = live.get(l.column_id);
    const def = column && columnTypes.get(column.type);
    if (!column || !def?.labelIds) throw new AppError('not_found', `Label column "${l.column_id}" not found`);
    const list = labelsByColumn.get(l.column_id) ?? [...((column.settings.labels as Label[] | undefined) ?? [])];
    if (list.some((x) => x.id === l.id || (!x.is_deactivated && norm(x.label) === norm(l.label))))
      throw new AppError('conflict', 'labels_changed', { column_id: column.key });
    list.push({
      id: l.id,
      label: l.label,
      ...(column.type === 'status' ? { color: l.color ?? 'gray', index: l.index ?? l.id } : {}),
    });
    labelsByColumn.set(l.column_id, list);
  }
  for (const [key, labels] of labelsByColumn) {
    const column = live.get(key)!;
    const parsed = columnTypes.get(column.type)!.settingsSchema.safeParse({ ...column.settings, labels });
    if (!parsed.success)
      throw new AppError('validation_failed', 'Invalid labels', { column_id: key, issues: parsed.error.issues });
    const settings = parsed.data as Record<string, unknown>;
    await updateColumnRow(tx, column.id, { settings });
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'column.settings_changed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      columnId: column.id,
      batchId,
      before: { settings: column.settings },
      after: { settings },
      meta: {
        bulk_edit: true,
        added_label_ids: part.labels.filter((l) => l.column_id === key).map((l) => l.id),
      },
    });
    // Cells validate against the new labels (the column may be known by its key and its ref).
    const next = { ...column, settings };
    for (const [k, c] of live) if (c.id === column.id) live.set(k, next);
  }
  return { live, columns };
};

/** One secret cell of the batch: `writeSecretInBatch` with the batch's key, mode and counts. */
type SecretWrite = (
  access: BoardAccess,
  item: { id: string; boardId: string; name: string },
  column: ColumnRow,
  value: string,
  /** A row this batch just made (its check box needs no code). */
  fresh?: boolean,
) => Promise<BatchSecretResult>;

/** Renames and cells of existing items (gone / not visible / not the actor's: skipped, counted, dropped from `found`). */
const updateRows = async (
  tx: Db,
  a: Actor,
  access: BoardAccess,
  rows: { item_id?: string; name?: string; cells: Record<string, unknown>; secrets?: Record<string, string> }[],
  found: Map<string, ItemRow>,
  board: { live: Map<string, ColumnRow>; columns: ColumnRow[] },
  batchId: string,
  writeSecret: SecretWrite,
) => {
  let updated = 0;
  let skipped = 0;
  // Computed names: one recompute for the whole sheet, at the end.
  const [, changed] = await collectItemChanges(tx, async () => {
    for (const r of rows) {
      const item = found.get(r.item_id!);
      if (!item) {
        skipped++;
        continue;
      }
      try {
        assertAssigned(access, a.user, item, await itemCells(tx, item.id), board.columns);
      } catch {
        skipped++;
        found.delete(item.id);
        continue;
      }
      // A board that computes names: a name in the sheet is ignored (the columns make it).
      if (r.name && r.name !== item.name && !isComputedName(nameSourceOfColumns(board.columns))) {
        await updateItemRow(tx, item.id, { name: r.name });
        await recordEvent(tx, {
          accountId: a.ctx.accountId,
          type: 'item.renamed',
          actorId: a.user.id,
          requestId: a.requestId,
          boardId: item.boardId,
          itemId: item.id,
          batchId,
          before: { name: item.name },
          after: { name: r.name },
        });
        await afterItemsRenamed(tx, nameWho(a), [item.id]);
      }
      for (const [key, value] of Object.entries(r.cells))
        await writeCell(tx, a, access, item, board.live.get(key)!, value, batchId);
      for (const [key, value] of Object.entries(r.secrets ?? {}))
        await writeSecret(access, item, board.live.get(key)!, value);
      updated++;
    }
  });
  await itemsChanged(tx, nameWho(a), changed);
  return { updated, skipped };
};

/** Existing items of `boardId` among `ids` that the actor sees. */
const visibleItems = async (db: Db, a: Actor, access: BoardAccess, boardId: string, ids: string[]) =>
  filterVisible(
    db,
    await boardVisibility(db, a, access),
    (await itemsByIds(db, a.ctx.accountId, [...new Set(ids)])).filter((i) => i.boardId === boardId && !i.archivedAt),
  );

/**
 * "ייבוא ועריכה" (until "עריכה גדולה") → finish (B2–B4): the sheets' draft written as ONE batch in one transaction. Only the board's
 * owners and admins (12-ROADMAP, product decision 6). Order: new columns (file import) and new labels (column
 * settings) — the board's, then the sub-board's — new tags, then the items sheet's rows (renames and cells of
 * existing items; items that are gone / not visible / not the actor's are skipped and counted; new items at the
 * bottom of their group as one batch insert), then the subitems sheet's (B4): changes of existing subitems, new
 * subitems a level at a time under their parent — an existing item / subitem, or a new row of the batch named by
 * its `ref` — and last the subitems moved to another parent (with their own subitems, within the board's levels).
 * Every event carries the batch id; undoing the batch (activity log, Ctrl+Z, `undoBulkEdit`) takes all of it back.
 * Cell values are validated like any edit — a bad value fails the whole request (422).
 * Secrets (`rows.secrets`): encrypted per cell after the row's cells (`writeSecretInBatch`); a cell
 * that has a value is left alone unless `secrets_mode: replace`; no value is ever in an event, the audit or an error.
 */
export const bulkEdit = async (
  deps: Pick<AppDeps, 'db' | 'env'>,
  actor: SecretActor,
  boardId: string,
  input: BulkEditRequest,
) => {
  const { db } = deps;
  // r19relfilter: the sheet / a file import leaves out links the relation's filter does not offer (counted).
  const a: SecretActor = { ...actor, relationPolicy: 'drop', notes: [] };
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.update');
  if (!isOwnerOrAdmin(access)) throw new AppError('forbidden', 'bulk_edit_owners_only');
  const subIn = input.subitems;
  if (!input.rows.length && !subIn?.rows.length) throw new AppError('validation_failed', 'Nothing to write');
  const creates = input.rows.filter((r) => !r.item_id);
  if (creates.length) {
    assertBoard(access, 'item.create');
    // On a sub-board itself new rows have no parent (the main board's subitems sheet gives one, B4).
    if (access.board.parentBoardId) throw new AppError('bad_request', 'subitems_need_a_parent');
  }
  if (input.labels.length) assertBoard(access, 'column.update');
  const newColumns = input.columns ?? [];
  if (newColumns.length) assertBoard(access, 'column.create');
  for (const cols of [newColumns, subIn?.columns ?? []])
    if (new Set(cols.map((c) => c.ref)).size !== cols.length)
      throw new AppError('validation_failed', 'Duplicate new column ref');

  const groups = await listGroups(db, boardId);
  if (creates.length && !groups.length) throw new AppError('not_found', 'Group not found');
  // New rows need a name unless the board computes names.
  const freeNames = (columns: { type: string; settings: unknown }[]) => !isComputedName(nameSourceOfColumns(columns));
  const mainFree = creates.length ? freeNames(await listColumns(db, boardId)) : true;
  for (const r of creates) {
    if (!r.name && mainFree) throw new AppError('validation_failed', 'A new row needs a name');
    if (r.group_id && !groups.some((g) => g.id === r.group_id)) throw new AppError('not_found', 'Group not found');
  }

  // New rows' refs: unique, on new rows only; a subitem's `parent_ref` names one of them.
  const refs = new Set<string>();
  for (const r of [...input.rows, ...(subIn?.rows ?? [])]) {
    if (!r.ref) continue;
    if (r.item_id) throw new AppError('validation_failed', 'Only a new row has a ref');
    if (refs.has(r.ref)) throw new AppError('validation_failed', `Duplicate row ref "${r.ref}"`);
    refs.add(r.ref);
  }

  const updates = input.rows.filter((r) => r.item_id);
  const found = new Map(
    (
      await visibleItems(
        db,
        a,
        access,
        boardId,
        updates.map((r) => r.item_id!),
      )
    ).map((i) => [i.id, i]),
  );

  // The subitems sheet (B4): the sub-board, its access, the subitems it changes and the parents it names.
  type Sub = {
    board: BoardRow;
    access: BoardAccess;
    depthMax: number;
    found: Map<string, ItemRow>;
    parents: Map<string, ItemRow>;
  };
  let sub: Sub | null = null;
  if (subIn) {
    if (access.board.parentBoardId) throw new AppError('bad_request', 'not_a_main_board');
    const board = await findSubBoard(db, boardId);
    if (!board) throw new AppError('not_found', 'no_subitems_board');
    const subAccess = await loadBoardAccess(db, a.ctx, a.user, board.id);
    assertBoard(subAccess, 'item.update');
    if (subIn.rows.some((r) => !r.item_id)) assertBoard(subAccess, 'item.create');
    if (subIn.labels.length) assertBoard(subAccess, 'column.update');
    if (subIn.columns?.length) assertBoard(subAccess, 'column.create');
    for (const r of subIn.rows) {
      if (r.parent_item_id && r.parent_ref) throw new AppError('validation_failed', 'One parent per row');
      if (r.parent_ref && !refs.has(r.parent_ref))
        throw new AppError('validation_failed', `Unknown parent ref "${r.parent_ref}"`);
      if (r.item_id) continue;
      if (!r.name && freeNames(await listColumns(db, board.id)))
        throw new AppError('validation_failed', 'A new row needs a name');
      if (!r.parent_item_id && !r.parent_ref) throw new AppError('bad_request', 'subitems_need_a_parent');
    }
    const parentIds = subIn.rows.flatMap((r) => (r.parent_item_id ? [r.parent_item_id] : []));
    const parents = new Map(
      [
        ...(await visibleItems(db, a, access, boardId, parentIds)),
        ...(await visibleItems(db, a, subAccess, board.id, parentIds)),
      ].map((i) => [i.id, i]),
    );
    for (const id of parentIds) if (!parents.has(id)) throw new AppError('not_found', 'Parent item not found');
    const changed = await visibleItems(
      db,
      a,
      subAccess,
      board.id,
      subIn.rows.flatMap((r) => (r.item_id ? [r.item_id] : [])),
    );
    sub = {
      board,
      access: subAccess,
      depthMax: access.board.hierarchyDepthMax,
      found: new Map(changed.map((i) => [i.id, i])),
      parents,
    };
  }
  const batchId = newId();

  // Secrets: who may write them in a batch, and the account's data key (before the transaction).
  const hasSecrets = [...input.rows, ...(subIn?.rows ?? [])].some((r) => Object.keys(r.secrets ?? {}).length);
  if (hasSecrets) assertMayWriteSecretsInBatch(a);
  const dataKey = hasSecrets ? await accountDataKey(db, deps.env, a.ctx.accountId) : null;
  const secretCounts = { secrets_set: 0, secrets_replaced: 0, secrets_skipped: 0 };
  const verified = new Set<string>();

  return db.transaction(async (tx) => {
    const writeSecret: SecretWrite = async (acc, item, column, value, fresh) => {
      const out = await writeSecretInBatch(tx, a, dataKey!, acc, item, column, value, {
        batchId,
        replace: input.secrets_mode === 'replace',
        verified,
        fresh,
      });
      secretCounts[out === 'set' ? 'secrets_set' : out === 'replaced' ? 'secrets_replaced' : 'secrets_skipped']++;
      return out;
    };
    /** The secrets of rows a batch insert just made, by the ids it returned (in request order). */
    const newRowSecrets = async (
      acc: BoardAccess,
      board: Map<string, ColumnRow>,
      rows: { secrets?: Record<string, string> }[],
      ids: string[],
    ) => {
      for (const [i, r] of rows.entries()) {
        if (!r.secrets || !Object.keys(r.secrets).length) continue;
        const item = (await findItem(tx, a.ctx.accountId, ids[i]!))!;
        for (const [key, value] of Object.entries(r.secrets))
          await writeSecret(acc, item, board.get(key)!, value, true);
      }
    };
    const main = await prepareBoard(tx, a, boardId, input, input.rows, batchId);
    const subBoard = sub && subIn ? await prepareBoard(tx, a, sub.board.id, subIn, subIn.rows, batchId) : null;
    for (const tag of input.tags) await ensureTags(tx, a, [tag.name], tag.color);

    const res = await updateRows(tx, a, access, updates, found, main, batchId, writeSecret);
    const updated = res.updated;
    let skipped = res.skipped;

    const itemIds = await insertItemsBatch(
      tx,
      a,
      access,
      boardId,
      creates.map((r) => ({
        name: r.name,
        groupId: r.group_id ?? groups[0]!.id,
        cells: Object.entries(r.cells).map(([key, value]): [ColumnRow, unknown] => [main.live.get(key)!, value]),
      })),
      batchId,
    );
    await newRowSecrets(access, main.live, creates, itemIds);
    // Where each new row of the batch is: its id, tree and level (for new subitems under it).
    const placed = new Map<string, { id: string; rootId: string; depth: number }>();
    creates.forEach((r, i) => {
      if (r.ref) placed.set(r.ref, { id: itemIds[i]!, rootId: itemIds[i]!, depth: 0 });
    });

    let subUpdated = 0;
    let reparented = 0;
    const subitemIds: string[] = [];
    if (sub && subIn && subBoard) {
      const s = sub;
      const subUpdates = subIn.rows.filter((r) => r.item_id);
      const changes = subUpdates.filter(
        (r) => r.name !== undefined || Object.keys(r.cells).length || Object.keys(r.secrets ?? {}).length,
      );
      const out = await updateRows(tx, a, s.access, changes, s.found, subBoard, batchId, writeSecret);
      subUpdated = out.updated;
      skipped += out.skipped;

      // New subitems, a level at a time: a row goes once its parent exists (an existing one, or placed before).
      const parentOf = (r: SubRow) => {
        if (r.parent_ref) return placed.get(r.parent_ref);
        const p = s.parents.get(r.parent_item_id!)!;
        return { id: p.id, rootId: p.rootItemId ?? p.id, depth: p.depth };
      };
      let pending = subIn.rows.filter((r) => !r.item_id);
      while (pending.length) {
        const ready = pending.filter((r) => parentOf(r));
        if (!ready.length) throw new AppError('validation_failed', 'Parent refs form a loop');
        for (const r of ready)
          if (parentOf(r)!.depth + 1 > effectiveDepthMax(s.depthMax))
            throw new AppError(
              'depth_exceeded',
              `This board allows ${effectiveDepthMax(s.depthMax)} levels of subitems`,
            );
        const ids = await insertItemsBatch(
          tx,
          a,
          s.access,
          s.board.id,
          ready.map((r) => ({
            name: r.name,
            groupId: null,
            parent: parentOf(r)!,
            cells: Object.entries(r.cells).map(([key, value]): [ColumnRow, unknown] => [
              subBoard.live.get(key)!,
              value,
            ]),
          })),
          batchId,
        );
        await newRowSecrets(s.access, subBoard.live, ready, ids);
        ready.forEach((r, i) => {
          const p = parentOf(r)!;
          if (r.ref) placed.set(r.ref, { id: ids[i]!, rootId: p.rootId, depth: p.depth + 1 });
        });
        subitemIds.push(...ids);
        const done = new Set(ready);
        pending = pending.filter((r) => !done.has(r));
      }

      // Subitems that move to another parent (their own subitems come along).
      const moves = subUpdates.filter((r) => r.parent_item_id || r.parent_ref);
      for (const r of moves) {
        if (!s.found.has(r.item_id!)) {
          if (!changes.includes(r)) skipped++;
          continue;
        }
        const item = await findItem(tx, a.ctx.accountId, r.item_id!);
        const targetId = r.parent_ref ? placed.get(r.parent_ref)!.id : r.parent_item_id!;
        if (!item || item.parentItemId === targetId) continue;
        const parent = await findItem(tx, a.ctx.accountId, targetId);
        if (!parent) throw new AppError('not_found', 'Parent item not found');
        if (!changes.includes(r)) {
          // Only a move: the subitem must still be the actor's to change.
          try {
            assertAssigned(s.access, a.user, item, await itemCells(tx, item.id), subBoard.columns);
          } catch {
            skipped++;
            continue;
          }
        }
        await reparentTx(tx, a, item, parent, s.depthMax, batchId);
        reparented++;
      }
    }

    const counts = {
      updated,
      created: itemIds.length,
      labels_added: input.labels.length + (subIn?.labels.length ?? 0),
      columns_added: newColumns.length + (subIn?.columns?.length ?? 0),
      skipped,
      sub_updated: subUpdated,
      sub_created: subitemIds.length,
      reparented,
      ...(hasSecrets ? secretCounts : {}),
    };
    const eventId = await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'batch.executed',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      batchId,
      meta: {
        action: 'bulk_edit',
        count: updated + itemIds.length + subUpdated + subitemIds.length + reparented,
        ...counts,
      },
    });
    return {
      ok: true as const,
      batch_id: batchId,
      event_id: eventId,
      ...counts,
      item_ids: itemIds,
      subitem_ids: subitemIds,
      ...(a.notes?.length ? { links_dropped: a.notes.reduce((n, x) => n + x.ids.length, 0) } : {}),
    };
  });
};

const actionOf = (ev: ActivityRow) => (ev.payload as { meta?: { action?: string } } | null)?.meta?.action;

/**
 * `POST /boards/:id/items/bulk-edit/:batch_id/undo` — the same as undoing the batch from the activity log or with
 * Ctrl+Z (`undoBatch`): cells and names of existing items back, new items and new columns to the trash, new labels
 * off their columns (kept, deactivated, if a cell still uses one). The actor (or an admin) within 7 days, once;
 * when a value changed since, 409 `changed_since` unless `force`.
 */
export const undoBulkEdit = async (db: Db, a: Actor, boardId: string, batchId: string, force = false) => {
  const summary = (await batchEvents(db, a.ctx.accountId, batchId)).find(
    (e) => e.type === 'batch.executed' && actionOf(e) === 'bulk_edit',
  );
  if (!summary || summary.boardId !== boardId) throw new AppError('not_found', 'Batch not found');
  if (summary.undoneAt) throw new AppError('already_undone', 'Already undone');
  const res = await undoBatch(db, a, batchId, force);
  return { ok: true as const, undone: res.undone };
};
