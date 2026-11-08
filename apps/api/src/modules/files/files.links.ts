// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type CellLink,
  FILE_CELL_LINKS_MAX,
  FILE_LINK_NAME_MAX,
  newId,
  normalizeFileLink,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { recordEvent } from '../activity/activity.repo';
import { findColumnById } from '../boards/boards.repo';
import { fileCellRow } from './files.repo';
import { loadFileColumn, syncFileCell } from './files.service';

/**
 * Web links in a files column: web links beside a cell's files and docs. A
 * link has no storage and no trash; it lives in the cell value only, so each change locks the cell row and
 * rewrites it through `syncFileCell` (files and docs stay as they are). Every change is an undoable event.
 */

const cleanUrl = (raw: string) => {
  const url = normalizeFileLink(raw);
  if (!url) throw new AppError('invalid_value', 'invalid_link');
  return url;
};
const cleanName = (raw: string | undefined) => (raw ?? '').trim().slice(0, FILE_LINK_NAME_MAX);

type Target = Awaited<ReturnType<typeof loadFileColumn>>;
type LinkEvent = 'file.link_added' | 'file.link_changed' | 'file.link_removed';

/** The cell's links, locked until the transaction ends. */
const lockedLinks = async (tx: Db, t: Target) => (await fileCellRow(tx, t.item.id, t.column.id, true))?.links ?? [];

const writeLinks = (tx: Db, a: Actor, t: Target, links: CellLink[]) =>
  syncFileCell(tx, a, t.item.id, t.item.boardId, t.column.id, links);

const linkEvent = (
  tx: Db,
  a: Actor,
  t: Target,
  type: LinkEvent,
  change: { before?: CellLink; after?: CellLink },
  undoOf?: string,
) =>
  recordEvent(tx, {
    accountId: a.ctx.accountId,
    type,
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: t.item.boardId,
    itemId: t.item.id,
    columnId: t.column.id,
    ...(change.before ? { before: { link: change.before } } : {}),
    ...(change.after ? { after: { link: change.after } } : {}),
    meta: { column_key: t.column.key, column_type: t.column.type, ...(undoOf ? { undo_of: undoOf } : {}) },
  });

/** POST /items/{id}/cells/{columnId}/links — the new link (last in the cell). */
export const addCellLink = async (db: Db, a: Actor, itemId: string, columnKey: string, input: AddInput) => {
  const t = await loadFileColumn(db, a, itemId, columnKey);
  const link: CellLink = {
    id: newId(),
    url: cleanUrl(input.url),
    name: cleanName(input.name),
    added_by: a.user.id,
    added_at: new Date().toISOString(),
  };
  await db.transaction(async (tx) => {
    const links = await lockedLinks(tx, t);
    if (links.length >= FILE_CELL_LINKS_MAX) throw new AppError('validation_failed', 'too_many_links');
    await writeLinks(tx, a, t, [...links, link]);
    await linkEvent(tx, a, t, 'file.link_added', { after: link });
  });
  return link;
};
type AddInput = { url: string; name?: string };

/** PATCH /items/{id}/cells/{columnId}/links/{linkId} — a new address and / or name. */
export const updateCellLink = async (
  db: Db,
  a: Actor,
  itemId: string,
  columnKey: string,
  linkId: string,
  input: Partial<AddInput>,
) => {
  const t = await loadFileColumn(db, a, itemId, columnKey);
  return db.transaction(async (tx) => {
    const links = await lockedLinks(tx, t);
    const before = links.find((l) => l.id === linkId);
    if (!before) throw new AppError('not_found', 'Link not found');
    const after: CellLink = {
      ...before,
      ...(input.url !== undefined ? { url: cleanUrl(input.url) } : {}),
      ...(input.name !== undefined ? { name: cleanName(input.name) } : {}),
    };
    if (after.url === before.url && after.name === before.name) return before;
    await writeLinks(
      tx,
      a,
      t,
      links.map((l) => (l.id === linkId ? after : l)),
    );
    await linkEvent(tx, a, t, 'file.link_changed', { before, after });
    return after;
  });
};

/** DELETE /items/{id}/cells/{columnId}/links/{linkId} — gone at once (undo puts it back where it was). */
export const removeCellLink = async (db: Db, a: Actor, itemId: string, columnKey: string, linkId: string) => {
  const t = await loadFileColumn(db, a, itemId, columnKey);
  await db.transaction(async (tx) => {
    const links = await lockedLinks(tx, t);
    const at = links.findIndex((l) => l.id === linkId);
    if (at < 0) throw new AppError('not_found', 'Link not found');
    await writeLinks(
      tx,
      a,
      t,
      links.filter((l) => l.id !== linkId),
    );
    await linkEvent(tx, a, t, 'file.link_removed', { before: { ...links[at]!, position: at } as CellLink });
  });
};

type LinkPayload = { before?: { link?: CellLink & { position?: number } }; after?: { link?: CellLink } };

/** Undo of a link event (the activity log / an AI call's batch): the opposite change, as its own event. */
export const undoLinkEventTx = async (
  tx: Db,
  a: Actor,
  ev: { id: string; type: string; itemId: string | null; columnId: string | null; payload?: unknown },
) => {
  const column = ev.columnId ? await findColumnById(tx, ev.columnId) : undefined;
  if (!column || !ev.itemId) throw new AppError('already_undone', 'Column not found');
  const t = await loadFileColumn(tx, a, ev.itemId, column.key);
  const p = (ev.payload ?? {}) as LinkPayload;
  const links = await lockedLinks(tx, t);
  if (ev.type === 'file.link_added') {
    const added = p.after?.link;
    if (!added || !links.some((l) => l.id === added.id)) throw new AppError('already_undone', 'Link not found');
    await writeLinks(
      tx,
      a,
      t,
      links.filter((l) => l.id !== added.id),
    );
    return linkEvent(tx, a, t, 'file.link_removed', { before: added }, ev.id);
  }
  if (ev.type === 'file.link_removed') {
    const removed = p.before?.link;
    if (!removed || links.some((l) => l.id === removed.id)) throw new AppError('already_undone', 'Link is back');
    if (links.length >= FILE_CELL_LINKS_MAX) throw new AppError('validation_failed', 'too_many_links');
    const { position, ...link } = removed;
    const next = [...links];
    next.splice(Math.min(position ?? links.length, links.length), 0, link);
    await writeLinks(tx, a, t, next);
    return linkEvent(tx, a, t, 'file.link_added', { after: link }, ev.id);
  }
  const before = p.before?.link;
  const current = before && links.find((l) => l.id === before.id);
  if (!before || !current) throw new AppError('already_undone', 'Link not found');
  await writeLinks(
    tx,
    a,
    t,
    links.map((l) => (l.id === before.id ? before : l)),
  );
  return linkEvent(tx, a, t, 'file.link_changed', { before: current, after: before }, ev.id);
};
