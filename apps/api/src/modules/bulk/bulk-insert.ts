// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, columnTypes, newId, ownWriter, parseCellValue, rankBetween } from '@bines/shared';
import type { Db } from '../../db/client';
import { type ActivityEvent, recordEvents } from '../activity/activity.repo';
import { type BoardAccess, columnAllowed } from '../boards/boards.access';
import { type ColumnRow, itemKeyFormat, listColumns, reserveItemKeySeqs } from '../boards/boards.repo';
import {
  type CellRow,
  childItemsOf,
  findItem,
  insertCells,
  insertItems,
  isAccountMember,
  type ItemRow,
  lastItemPosition,
  memberNames,
} from '../items/items.repo';
import { type Actor, nameWho, writeCell } from '../items/items.service';
import { collectItemChanges, initialItemName, itemsChanged } from '../items/names.service';
import { followItems } from '../notifications/followers.repo';
import { notifyAssigned } from '../notifications/notifications.service';
import { tagsByIds } from '../tags/tags.repo';
import { ensureTags } from '../tags/tags.service';
import { listTeamRows } from '../teams/teams.repo';
import { accountCountry } from '../phone/phone.service';

/**
 * A new item of a bulk edit / file import: cells by the column (key or a new column's ref) they write. An item goes
 * to a group; a subitem (B4) under `parent` (no group), one level below it.
 */
export type NewItemRow = {
  /** Required on a board with free names; ignored where the board computes them. */
  name?: string;
  groupId: string | null;
  parent?: { id: string; rootId: string; depth: number };
  cells: [ColumnRow, unknown][];
};

type Person = { id: string; kind: string };
const peopleOf = (raw: unknown) =>
  ((raw as { persons_and_teams?: Person[] } | null)?.persons_and_teams ?? []) as Person[];

/**
 * New items as a real batch (B3: 10,000 rows in a few seconds instead of ~7 ms × queries per row): positions at
 * the bottom of each group computed once, item keys reserved at once, every cell validated in memory like
 * `writeCell` (tags created and people checked once for all rows), then one multi-row insert per table — items,
 * cells, followers, activity (`item.created` and `cell.changed` per cell, all with `batchId`, in row order).
 * Relation cells, which need their own writer, still go through `writeCell` one by one. Returns the item ids.
 */
export const insertItemsBatch = async (
  tx: Db,
  a: Actor,
  access: BoardAccess,
  boardId: string,
  rows: NewItemRow[],
  batchId: string,
): Promise<string[]> => {
  if (!rows.length) return [];
  const accountId = a.ctx.accountId;
  const now = new Date();
  // A board that computes names: given names are ignored, the names are computed after the cells.
  const boardColumns = await listColumns(tx, boardId);
  const nameOf = (r: NewItemRow) => initialItemName(boardColumns, r.name).name;
  const initialNames = rows.map(nameOf);

  // Values first: nothing is written when one of them is bad (the transaction fails as a whole anyway).
  const tagNames = new Set<string>();
  const tagIds = new Set<string>();
  const personIds = new Set<string>();
  let teamsUsed = false;
  for (const r of rows)
    for (const [column, raw] of r.cells) {
      if (raw === null) continue;
      const def = columnTypes.get(column.type);
      if (!def) throw new AppError('unknown_column_type', `Unknown column type "${column.type}"`);
      if (def.readOnly || def.storage !== 'cell' || ownWriter(def))
        throw new AppError('column_read_only', `Column "${column.key}" is read-only`);
      if (!columnAllowed(access, column.restrictedEdit))
        throw new AppError('forbidden', `column_restricted:${column.key}`);
      if (column.type === 'tags') {
        const v = (raw ?? {}) as { tag_ids?: unknown; tags?: unknown };
        if (Array.isArray(v.tags))
          for (const n of v.tags) {
            const name = String(n).replace(/^#+/, '').trim();
            if (name) tagNames.add(name);
          }
        if (Array.isArray(v.tag_ids)) for (const id of v.tag_ids) tagIds.add(String(id));
      }
      if (column.type === 'people')
        for (const p of peopleOf(raw)) {
          if (p.kind === 'person') personIds.add(p.id);
          else if (p.kind === 'team') teamsUsed = true;
        }
    }
  const tagByName = new Map<string, { id: string; name: string }>();
  const names = new Map<string, string>(); // tag / person / team id → name
  if (tagNames.size)
    for (const t of await ensureTags(tx, a, [...tagNames])) {
      tagByName.set(t.name.toLowerCase(), t);
      names.set(t.id, t.name);
    }
  if (tagIds.size) {
    const known = await tagsByIds(tx, accountId, [...tagIds]);
    if (known.length !== tagIds.size) throw new AppError('invalid_value', 'Unknown tag');
    for (const t of known) names.set(t.id, t.name);
  }
  if (personIds.size) {
    if (!(await isAccountMember(tx, accountId, [...personIds]))) throw new AppError('invalid_value', 'Unknown person');
    for (const [id, name] of await memberNames(tx, accountId, [...personIds])) names.set(id, name);
  }
  const teams = teamsUsed ? new Map((await listTeamRows(tx, accountId)).map((t) => [t.id, t.name])) : null;
  if (teams) for (const [id, name] of teams) names.set(id, name);

  // Values with derived keys (phone E.164) fall back to the account's country.
  const country = rows.some((r) => r.cells.some(([c]) => columnTypes.get(c.type)?.normalize))
    ? await accountCountry(tx, accountId)
    : undefined;
  const label = { userName: (id: string) => names.get(id), tagName: (id: string) => names.get(id), country };
  type Parsed = { column: ColumnRow; row: number; cell: Omit<CellRow, 'updatedAt'> | null; raw: unknown };
  const parsed: Parsed[] = [];
  const ids = rows.map(() => newId());
  rows.forEach((r, i) => {
    for (const [column, input] of r.cells) {
      if (input === null) continue; // nothing to clear on a new item
      const def = columnTypes.get(column.type)!;
      let raw = input;
      if (def.engine === 'links') {
        parsed.push({ column, row: i, cell: null, raw });
        continue;
      }
      if (column.type === 'tags') {
        const v = (raw ?? {}) as { tag_ids?: unknown; tags?: unknown };
        if (Array.isArray(v.tags) || Array.isArray(v.tag_ids)) {
          const order = [
            ...new Set([
              ...(Array.isArray(v.tag_ids) ? v.tag_ids.map(String) : []),
              ...(Array.isArray(v.tags) ? v.tags : []).flatMap((n) => {
                const t = tagByName.get(String(n).replace(/^#+/, '').trim().toLowerCase());
                return t ? [t.id] : [];
              }),
            ]),
          ];
          if (!order.length) continue;
          raw = { tag_ids: order };
        }
      }
      if (column.type === 'people' && teams)
        for (const p of peopleOf(raw))
          if (p.kind === 'team' && !teams.has(p.id)) throw new AppError('invalid_value', 'Unknown team');
      const out = parseCellValue(def, column.settings, raw, label);
      if (!out.ok)
        throw new AppError(
          out.error === 'label_not_found' ? 'label_not_found' : 'invalid_value',
          `Invalid value for "${column.key}"`,
          {
            column_id: column.key,
            error: out.error,
            issues: out.issues,
            row: i,
          },
        );
      parsed.push({
        column,
        row: i,
        raw: out.value,
        cell: {
          itemId: ids[i]!,
          columnId: column.id,
          accountId,
          boardId,
          value: out.value as Record<string, unknown>,
          textValue: out.derived.textValue,
          numberValue: out.derived.numberValue,
          dateValue: out.derived.dateValue,
          dateEndValue: out.derived.dateEndValue,
          updatedBy: a.user.id,
          updatedByType: 'user',
        },
      });
    }
  });

  // Positions: after the last item of each group (subitems: of each parent), one after the other.
  const last = new Map<string, string | null>();
  const positions: string[] = [];
  for (const r of rows) {
    const key = r.parent ? `p:${r.parent.id}` : `g:${r.groupId}`;
    if (!last.has(key))
      last.set(
        key,
        r.parent
          ? ((await childItemsOf(tx, [r.parent.id])).at(-1)?.position ?? null)
          : await lastItemPosition(tx, r.groupId!),
      );
    const p = rankBetween(last.get(key)!, null);
    last.set(key, p);
    positions.push(p);
  }
  const firstSeq = (await itemKeyFormat(tx, boardId)) ? await reserveItemKeySeqs(tx, boardId, rows.length) : undefined;
  const withCells = new Set(parsed.map((p) => p.row));
  const itemRows = rows.map((r, i) => ({
    id: ids[i]!,
    accountId,
    boardId,
    groupId: r.parent ? null : r.groupId,
    parentItemId: r.parent?.id ?? null,
    rootItemId: r.parent?.rootId ?? null,
    depth: r.parent ? r.parent.depth + 1 : 0,
    position: positions[i]!,
    name: initialNames[i]!,
    keySeq: firstSeq === undefined ? null : Number(firstSeq) + i,
    createdBy: a.user.id,
    creatorType: 'user' as const,
    lastCellChangeAt: withCells.has(i) ? now : null,
    lastCellChangeBy: withCells.has(i) ? a.user.id : null,
  }));
  await insertItems(tx, itemRows);
  await insertCells(
    tx,
    parsed.flatMap((p) => (p.cell ? [p.cell] : [])),
  );
  await followItems(tx, accountId, ids, a.user.id, 'creator');

  // Activity in row order: each item's `item.created`, then its cells.
  const byRow = new Map<number, Parsed[]>();
  for (const p of parsed) if (p.cell) byRow.set(p.row, [...(byRow.get(p.row) ?? []), p]);
  const base = { accountId, actorId: a.user.id, requestId: a.requestId, boardId, batchId };
  const events: ActivityEvent[] = [];
  const createdAt: number[] = []; // index of each row's `item.created` in `events`
  rows.forEach((r, i) => {
    const name = initialNames[i]!;
    createdAt.push(events.length);
    events.push({
      ...base,
      type: 'item.created',
      itemId: ids[i]!,
      after: r.parent ? { name, parent_item_id: r.parent.id } : { name, group_id: r.groupId },
      meta: { bulk_edit: true },
    });
    for (const p of byRow.get(i) ?? [])
      events.push({
        ...base,
        type: 'cell.changed',
        itemId: ids[i]!,
        columnId: p.column.id,
        before: { value: null },
        after: { value: p.raw },
        meta: { column_key: p.column.key, column_type: p.column.type },
      });
  });
  const eventIds = await recordEvents(tx, events);

  // "Assigned to you" for people cells, and relation cells through their own writer.
  const item = (i: number): ItemRow => ({
    ...itemRows[i]!,
    childCount: 0,
    sourceItemId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    archivedBy: null,
    deletedAt: null,
  });
  const [, changed] = await collectItemChanges(tx, async () => {
    for (const p of parsed) {
      if (p.cell && p.column.type === 'people') await notifyAssigned(tx, a, item(p.row), p.column.id, null, p.raw);
      if (!p.cell) {
        const live = (await findItem(tx, accountId, ids[p.row]!))!;
        await writeCell(tx, a, access, live, p.column, p.raw, batchId);
      }
    }
  });
  // Computed names of the new items (into their `item.created` events), and of parents reading their subitems.
  const parents = [...new Set(rows.flatMap((r) => (r.parent ? [r.parent.id] : [])))];
  await itemsChanged(tx, nameWho(a), [...ids, ...parents, ...changed], {
    silent: new Map(ids.map((id, i) => [id, eventIds[createdAt[i]!]!])),
  });
  return ids;
};
