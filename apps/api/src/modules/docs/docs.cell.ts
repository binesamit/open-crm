// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canBoard, columnTypes, newId, rankBetween, type RichNode } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { columnAllowed } from '../boards/boards.access';
import { findBoard, findColumnByKey, listColumns } from '../boards/boards.repo';
import { itemCells } from '../items/items.repo';
import { assertAssigned, loadItem } from '../items/items.service';
import { loadDocAccess } from './docs.access';
import { findCellDoc, findDoc, insertDoc, loadDocState, setDocAssets } from './docs.repo';
import { syncFileCell } from '../files/files.service';
import { getDoc, writeDocCell } from './docs.service';
import { decodeState, deriveDoc, encodeState, jsonToYdoc } from './ydoc';

/**
 * Duplicating an item (or a board with its items) copies its cell docs too (plan §3.1): a new doc with the same
 * content in the new item's cell. Returns whether one was copied.
 */
export const copyCellDoc = async (
  tx: Db,
  a: Actor,
  value: unknown,
  to: { itemId: string; boardId: string; columnId: string },
) => {
  const docId = (value as { doc_id?: string } | null)?.doc_id;
  if (!docId) return false;
  const source = await findDoc(tx, a.ctx.accountId, docId);
  const board = await findBoard(tx, a.ctx.accountId, to.boardId);
  if (!source || source.host !== 'cell' || !board) return false;
  const state = await loadDocState(tx, a.ctx.accountId, docId);
  const ydoc = state?.ydoc?.length
    ? state.ydoc
    : state?.content
      ? encodeState(jsonToYdoc(state.content as RichNode))
      : null;
  const derived = ydoc ? deriveDoc(decodeState(ydoc)) : null;
  const id = newId();
  await insertDoc(tx, {
    id,
    accountId: a.ctx.accountId,
    workspaceId: board.workspaceId,
    folderId: null,
    position: rankBetween(null, null),
    kind: 'main',
    host: 'cell',
    boardId: to.boardId,
    itemId: to.itemId,
    columnId: to.columnId,
    name: source.name,
    icon: source.icon,
    settings: source.settings,
    ydoc,
    content: derived?.content ?? null,
    textValue: derived?.text ?? '',
    createdBy: a.user.id,
    updatedBy: a.user.id,
  });
  if (derived?.assetIds.length) await setDocAssets(tx, { accountId: a.ctx.accountId, id }, derived.assetIds);
  await writeDocCell(tx, a, { id, itemId: to.itemId, columnId: to.columnId, boardId: to.boardId }, source.name);
  return true;
};

/**
 * POST /items/:id/cells/:col/doc (M8 ד2) — the doc of a `doc` column's cell, made on first use by whoever may
 * change that cell; later calls (anyone who sees the item) return the same doc. It has the item's permissions
 * (`loadDocAccess` → the item), is not in the sidebar, and starts from the column's template doc when one is set
 * (and the actor may read it). The cell holds `{doc_id, name}` — written only here and on rename.
 */
export const openCellDoc = async (db: Db, a: Actor, itemId: string, columnKey: string, input: { name?: string }) => {
  const { item, access } = await loadItem(db, a, itemId);
  const column = await findColumnByKey(db, item.boardId, columnKey);
  const def = column ? columnTypes.get(column.type) : undefined;
  // Fix: a `file` column's cell holds docs too ("new doc" next to "upload") — every call
  // there makes a new one; a `doc` column's cell has exactly one.
  const inFiles = def?.engine === 'files';
  if (!column || (def?.engine !== 'doc' && !inFiles) || !columnAllowed(access, column.restrictedView))
    throw new AppError('not_found', 'Doc column not found');

  if (!inFiles) {
    const existing = await findCellDoc(db, item.id, column.id);
    if (existing) return { doc: await getDoc(db, a, existing.id), created: false };
  }

  if (!canBoard(access.perm, 'item.update').ok) throw new AppError('forbidden', 'cannot_edit_item');
  if (!columnAllowed(access, column.restrictedEdit)) throw new AppError('forbidden', `column_restricted:${column.key}`);
  assertAssigned(access, a.user, item, await itemCells(db, item.id), await listColumns(db, item.boardId));

  // The column's starting template (a doc the actor can read).
  let ydoc: Uint8Array | null = null;
  const templateId = inFiles ? undefined : (column.settings as { template_doc_id?: string } | null)?.template_doc_id;
  if (templateId) {
    try {
      await loadDocAccess(db, a.ctx, a.user, templateId);
      const state = await loadDocState(db, a.ctx.accountId, templateId);
      ydoc = state?.ydoc?.length
        ? state.ydoc
        : state?.content
          ? encodeState(jsonToYdoc(state.content as RichNode))
          : null;
    } catch {
      ydoc = null; // a template one cannot read starts empty
    }
  }
  const derived = ydoc ? deriveDoc(decodeState(ydoc)) : null;

  const id = newId();
  const name = (input.name ?? item.name).slice(0, 255) || column.title;
  await db.transaction(async (tx) => {
    await insertDoc(tx, {
      id,
      accountId: a.ctx.accountId,
      workspaceId: access.workspace.id,
      folderId: null,
      position: rankBetween(null, null),
      kind: 'main',
      host: 'cell',
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      name,
      ydoc,
      content: derived?.content ?? null,
      textValue: derived?.text ?? '',
      createdBy: a.user.id,
      updatedBy: a.user.id,
    });
    if (derived?.assetIds.length) await setDocAssets(tx, { accountId: a.ctx.accountId, id }, derived.assetIds);
    if (inFiles) await syncFileCell(tx, a, item.id, item.boardId, column.id);
    else await writeDocCell(tx, a, { id, itemId: item.id, columnId: column.id, boardId: item.boardId }, name);
    await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'cell.doc_created',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      columnId: column.id,
      before: { value: null },
      after: { value: { doc_id: id, name } },
      meta: { doc_id: id, column_key: column.key, column_type: column.type },
    });
  });
  return { doc: await getDoc(db, a, id), created: true };
};
