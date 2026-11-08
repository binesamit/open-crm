// SPDX-License-Identifier: AGPL-3.0-only
import { rankBetweenOrAfter } from '../boards/boards.access';
import { sql } from 'drizzle-orm';
import {
  AppError,
  columnTypes,
  type createItemSchema,
  isComputedName,
  type NameSource,
  nameSourceOfColumns,
  newId,
  ownWriter,
  parseCellValue,
  rankBetween,
  type updateItemSchema,
} from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { SessionUser, Actor as BaseActor } from '../../types';
import { recordEvent, recordEvents } from '../activity/activity.repo';
import { queueGeocode } from '../geo/geo.service';
import { followNewItem, notifyAssigned } from '../notifications/notifications.service';
import {
  type BoardAccess,
  assertBoard,
  columnAllowed,
  isOwnerOrAdmin,
  loadBoardAccess,
  positionAmong,
} from '../boards/boards.access';
import { trashObject, trashObjects } from '../trash/trash.service';
import { liveSubtreeIds, liveSubtreesOf, setItemsDeleted } from '../trash/trash.repo';
import { Calculator, type CellDto } from './computed';
import { actorRegion } from '../accounts/region';
import { boardVisibility, filterVisible, isVisible, visibleAcrossBoards } from './visibility';
import { listTeamRows } from '../teams/teams.repo';
import { resolveTagsValue } from '../tags/tags.service';
import { assertWorkflowMove, columnWorkflow, plainTextDoc } from './workflow';
import { writePopupSubitems } from './popup-subitems';
import { createUpdate } from '../updates/updates.service';
import {
  type ColumnRow,
  findColumnById,
  findGroup,
  itemKeyFormat,
  listColumns,
  listGroups,
  nextItemKeySeq,
} from '../boards/boards.repo';
import {
  type CellRow,
  columnValueCounts,
  deleteCell,
  findItem,
  firstItemPosition,
  insertItem,
  itemsByIds,
  isAccountMember,
  type ItemRow,
  itemCells,
  lastItemPosition,
  listBoardItems,
  byDepthPosition,
  memberNames,
  neighbourPositions,
  replaceLinks,
  searchItemsByName,
  updateItemRow,
  upsertCell,
} from './items.repo';
import { linkTargets } from './relations.repo';
import { syncReflection } from './relations.service';
import { checkNewLinks, relationPolicy, type RelationNote, type RelationPolicy } from './relation-filter.service';
import { accountCountry } from '../phone/phone.service';
import { checkDependencyValue, dependencyCellValue, shiftDependents, shiftTriggers } from './dependencies.service';
import { assertDeleteCode } from '../boards/delete-guard';
import {
  afterItemsRenamed,
  assertNameEditable,
  collectItemChanges,
  initialItemName,
  itemsChanged,
  type NameWho,
  noteItemsChanged,
} from './names.service';

/** Who computed-name events are recorded for. */
export const nameWho = (a: Actor): NameWho => ({
  accountId: a.ctx.accountId,
  actorId: a.user.id,
  requestId: a.requestId ?? null,
});

/** A board's name source from its column list (memoised per list: a board load builds 30k DTOs from one list). */
const sourceMemo = new WeakMap<object, NameSource>();
const sourceOf = (columns: ColumnRow[]) => {
  let s = sourceMemo.get(columns);
  if (!s) sourceMemo.set(columns, (s = nameSourceOfColumns(columns)));
  return s;
};

/** `automation`: the services act for an automation run (M6) — as its owner, with the owner's rights. */
export type AutomationActor = { id: string; title: string; runId: string };
/** `agent`: the services act for an agent run (מ6) — as the agent's own service user, limited to its boards. */
export type AgentActor = { id: string; name: string; runId: string };
/** The request's actor (types.ts) plus who the item services may act for and what they report back. */
export type Actor = BaseActor & {
  automation?: AutomationActor;
  agent?: AgentActor;
  /** r19relfilter: how new relation links that do not match the column's filter are treated (default: by actor). */
  relationPolicy?: RelationPolicy;
  /** Notes services leave for the caller's log (an automation run's warnings, a bulk result). */
  notes?: RelationNote[];
};

/** One calculator per request: computed columns (relations, mirrors, formulas, meta) for these items. */
/**
 * `known`: item rows already loaded by the caller (not read again); `boardId`: they are a whole board's items
 * (its cells are then read by board).
 */
export const calculatorFor = async (db: Db, a: Actor, itemIds: string[], known?: ItemRow[], boardId?: string) => {
  const calc = new Calculator(db, a.ctx.accountId, await actorRegion(db, a));
  await calc.prefetch(itemIds, undefined, known, boardId);
  await calc.authorize(itemIds, (items) => visibleAcrossBoards(db, a, items));
  await calc.hideColumns((boardId, columns) => hiddenColumnIds(db, a, boardId, columns));
  return calc;
};

/**
 * The columns of a board hidden from the actor (05 §6.1 `view`). A board they cannot open hides all its
 * restricted columns (the strictest rule).
 */
const hiddenColumnIds = async (db: Db, a: Actor, boardId: string, columns: ColumnRow[]) => {
  const restricted = columns.filter((c) => c.restrictedView);
  if (!restricted.length) return [];
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId).catch(() => null);
  return restricted.filter((c) => !access || !columnAllowed(access, c.restrictedView)).map((c) => c.id);
};

export const itemDto = (calc: Calculator, item: ItemRow, columns: ColumnRow[]) => {
  const out: Record<string, CellDto> = {};
  for (const col of columns) {
    const def = columnTypes.get(col.type);
    if (!def || def.storage === 'item') continue;
    const v = calc.display(item.id, col, def);
    if (v) out[col.key] = v;
  }
  return {
    id: item.id,
    board_id: item.boardId,
    group_id: item.groupId,
    parent_item_id: item.parentItemId,
    depth: item.depth,
    name: item.name,
    name_computed: isComputedName(sourceOf(columns)),
    name_source: sourceOf(columns).mode,
    position: item.position,
    key: calc.keyOf(item),
    cells: out,
    created_at: item.createdAt.toISOString(),
    created_by: item.createdBy,
    updated_at: item.updatedAt.toISOString(),
  };
};

/**
 * Board items with cells for the table view. Column-view restrictions hide cells from non-owners.
 * `ids`: only these items (a live board refreshes the rows an event named instead of the whole board — perf
 * review); ids that are not live, not on this board, archived or not visible to the actor are left out, which
 * tells the client to drop them.
 */
export const listItems = async (db: Db, a: Actor, boardId: string, ids?: string[]) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const [all, columns, v] = await Promise.all([
    ids
      ? itemsByIds(db, a.ctx.accountId, ids).then((rows) =>
          rows.filter((i) => i.boardId === boardId && !i.archivedAt).sort(byDepthPosition),
        )
      : listBoardItems(db, boardId),
    visibleColumns(db, access),
    boardVisibility(db, a, access),
  ]);
  const items = await filterVisible(db, v, all);
  const calc = await calculatorFor(
    db,
    a,
    items.map((i) => i.id),
    items,
    ids ? undefined : boardId,
  );
  return items.map((i) => itemDto(calc, i, columns));
};

export const visibleColumns = async (db: Db, access: BoardAccess) =>
  (await listColumns(db, access.board.id)).filter((c) => columnAllowed(access, c.restrictedView));

/** edit_assigned (05 §4): only items the actor created or is assigned to in a people column. */
export const assertAssigned = (
  access: BoardAccess,
  user: SessionUser,
  item: ItemRow,
  cells: CellRow[],
  columns: ColumnRow[],
) => {
  if (access.board.permissionSet !== 'edit_assigned' || isOwnerOrAdmin(access)) return;
  if (item.createdBy === user.id) return;
  const peopleIds = new Set(columns.filter((c) => c.type === 'people').map((c) => c.id));
  // Assigned = the user, or a team they are in (05 §6.2).
  const me = new Set([user.id, ...access.teamIds]);
  const assigned = cells.some(
    (c) =>
      peopleIds.has(c.columnId) &&
      ((c.value as { persons_and_teams?: { id: string }[] }).persons_and_teams ?? []).some((p) => me.has(p.id)),
  );
  if (!assigned) throw new AppError('forbidden', 'not_assigned');
};

/**
 * Validates and writes one cell (null = clear) and records `cell.changed` with the stored value before and
 * after (undo compares the current value with `after`). Returns the event id.
 */
export const writeCell = async (
  tx: Db,
  a: Actor,
  access: BoardAccess,
  item: ItemRow,
  column: ColumnRow,
  raw: unknown,
  batchId: string | null,
  meta: Record<string, unknown> = {},
) => {
  // A column hidden from the actor (05 §6.1 `view`) does not exist for them — not even to write blind (audit
  // 2026-10-10 #1: item update, bulk set_cell / shift_dates and undo all end here).
  if (!columnAllowed(access, column.restrictedView))
    throw new AppError('not_found', `Column "${column.key}" not found`);
  const def = columnTypes.get(column.type);
  if (!def) throw new AppError('unknown_column_type', `Unknown column type "${column.type}"`);
  // Files, time and votes have their own endpoints; their cell is a cache (03 §2.15, §3.3, §3.11).
  if (def.readOnly || def.storage !== 'cell' || ownWriter(def))
    throw new AppError('column_read_only', `Column "${column.key}" is read-only`);
  if (!columnAllowed(access, column.restrictedEdit)) {
    throw new AppError('forbidden', `column_restricted:${column.key}`);
  }
  // D28: a background type conversion runs on the column — edits wait until it ends.
  if (column.convertingId) throw new AppError('column_converting', `Column "${column.key}" is being converted`);
  const cellsNow = await itemCells(tx, item.id);
  const before = cellsNow.find((c) => c.columnId === column.id)?.value ?? null;
  // a status column's workflow decides which label may follow which.
  const workflowMeta = columnWorkflow(column)
    ? await assertWorkflowMove(
        tx,
        a,
        access,
        item,
        column,
        before,
        raw,
        meta,
        async (key) => {
          if (key === 'name') return !!item.name;
          const target = (await listColumns(tx, item.boardId)).find((c) => c.key === key);
          const cell = target && cellsNow.find((c) => c.columnId === target.id);
          return !!cell && cell.value !== null;
        },
        async () => {
          const columns = await listColumns(tx, item.boardId);
          const calc = await calculatorFor(tx, a, [item.id]);
          return { item: itemDto(calc, item, columns), columns };
        },
      )
    : {};

  let after: unknown = null;
  let names = new Map<string, string>();
  if (column.type === 'tags' && raw !== null) {
    // Tag names become account tags (03 §3.1); an empty list clears the cell.
    const resolved = await resolveTagsValue(tx, a, raw);
    names = resolved.names;
    raw = (resolved.value as { tag_ids?: string[] }).tag_ids?.length === 0 ? null : resolved.value;
  }
  if (def.engine === 'links') {
    after = await writeLinks(tx, a, item, column, raw, meta);
  } else if (raw === null) {
    await deleteCell(tx, item.id, column.id);
  } else {
    if (column.type === 'people') {
      const ids = ((raw as { persons_and_teams?: { id: string; kind: string }[] }).persons_and_teams ?? [])
        .filter((p) => p.kind === 'person')
        .map((p) => p.id);
      if (!(await isAccountMember(tx, a.ctx.accountId, ids))) throw new AppError('invalid_value', 'Unknown person');
      names = await memberNames(tx, a.ctx.accountId, ids);
      // Teams (05 §6.2) must be this account's; their names go into the cell text.
      const teamIds = ((raw as { persons_and_teams?: { id: string; kind: string }[] }).persons_and_teams ?? [])
        .filter((p) => p.kind === 'team')
        .map((p) => p.id);
      if (teamIds.length) {
        const teams = new Map((await listTeamRows(tx, a.ctx.accountId)).map((t) => [t.id, t.name]));
        if (teamIds.some((id) => !teams.has(id))) throw new AppError('invalid_value', 'Unknown team');
        for (const id of teamIds) names.set(id, teams.get(id)!);
      }
    }
    const parsed = parseCellValue(def, column.settings, raw, {
      userName: (id) => names.get(id),
      tagName: (id) => names.get(id),
      // Derived keys (phone E.164) fall back to the account's country.
      ...(def.normalize ? { country: await accountCountry(tx, a.ctx.accountId) } : {}),
    });
    if (!parsed.ok) {
      const code = parsed.error === 'label_not_found' ? 'label_not_found' : 'invalid_value';
      throw new AppError(code, `Invalid value for "${column.key}"`, {
        column_id: column.key,
        error: parsed.error,
        issues: parsed.issues,
      });
    }
    await upsertCell(tx, {
      itemId: item.id,
      columnId: column.id,
      accountId: a.ctx.accountId,
      boardId: item.boardId,
      value: parsed.value as Record<string, unknown>,
      textValue: parsed.derived.textValue,
      numberValue: parsed.derived.numberValue,
      dateValue: parsed.derived.dateValue,
      dateEndValue: parsed.derived.dateEndValue,
      updatedBy: a.user.id,
      updatedByType: 'user',
    });
    after = parsed.value;
    // A location without coordinates joins the geocoding queue (M8 ד10).
    const address = def.geocodeQuery?.(parsed.value);
    if (address)
      await queueGeocode(tx, { account_id: a.ctx.accountId, item_id: item.id, column_id: column.id, address });
  }
  await updateItemRow(tx, item.id, { lastCellChangeAt: new Date(), lastCellChangeBy: a.user.id });
  // "Assigned to you" (M4) — not when an undo puts an old value back.
  if (column.type === 'people' && !meta.undo_of) await notifyAssigned(tx, a, item, column.id, before, after);
  const eventId = await recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'cell.changed',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: item.boardId,
    itemId: item.id,
    columnId: column.id,
    batchId,
    before: { value: before },
    after: { value: after },
    meta: {
      column_key: column.key,
      column_type: column.type,
      ...meta,
      workflow_override: undefined,
      workflow_note: undefined,
      ...workflowMeta,
    },
  });
  // Computed item names that read this item follow — now, or at the end of the caller's batch.
  await noteItemsChanged(tx, nameWho(a), [item.id]);
  return eventId;
};

/** The stored value of one cell right now (undo checks it against the event's `after`). */
export const currentCellValue = async (db: Db, itemId: string, columnId: string) =>
  (await itemCells(db, itemId)).find((c) => c.columnId === columnId)?.value ?? null;

/** Writes a cell by internal column id inside a transaction, with the usual rights (undo of `cell.changed`). */
export const writeCellTx = async (
  tx: Db,
  a: Actor,
  itemId: string,
  columnId: string,
  value: unknown,
  meta: Record<string, unknown>,
) => {
  const { item, access } = await loadItem(tx, a, itemId);
  assertBoard(access, 'item.update');
  const column = await findColumnById(tx, columnId);
  if (!column || column.boardId !== item.boardId) throw new AppError('not_found', 'Column not found');
  const columns = await listColumns(tx, item.boardId);
  assertAssigned(access, a.user, item, await itemCells(tx, item.id), columns);
  return writeCell(tx, a, access, item, column, value, null, meta);
};

/**
 * board_relation (03 §2.16): targets must exist in this account, sit on one of the column's boards and be readable
 * by the actor; item_links is replaced and the cell keeps a cache `{item_ids}` + names for search and sort.
 */
const writeLinks = async (
  tx: Db,
  a: Actor,
  item: ItemRow,
  column: ColumnRow,
  raw: unknown,
  writeMeta: Record<string, unknown> = {},
) => {
  const settings = column.settings as { board_ids?: string[]; allow_multiple?: boolean };
  const parsed = raw === null ? { item_ids: [] } : (raw as { item_ids?: unknown; new_item_ids?: unknown });
  const requested = Array.isArray(parsed.item_ids) ? [...new Set(parsed.item_ids.map(String))] : null;
  if (!requested) throw new AppError('invalid_value', `Invalid value for "${column.key}"`, { column_id: column.key });
  if (settings.allow_multiple === false && requested.length > 1) {
    throw new AppError('invalid_value', 'This column links a single item', { column_id: column.key });
  }
  const targets = await itemsByIds(tx, a.ctx.accountId, requested);
  // Only items the actor may see — board access and the board's view_items (05 §6).
  const visible = await visibleAcrossBoards(tx, a, targets);
  const dependency = column.type === 'dependency';
  // A dependency links items of the item's own board (M8 ד7); a relation, its column's boards.
  const allowedBoards = dependency
    ? new Set([item.boardId])
    : settings.board_ids?.length
      ? new Set(settings.board_ids)
      : null;
  const ok = targets.filter((t) => visible.has(t.id) && (!allowedBoards || allowedBoards.has(t.boardId)));
  if (ok.length !== requested.length)
    throw new AppError('invalid_value', 'Unknown or unavailable item', { column_id: column.key });
  let meta: Record<string, Record<string, unknown>> | undefined;
  if (dependency) {
    const parsed = columnTypes.get('dependency')!.valueSchema.safeParse(raw ?? { item_ids: [] });
    if (!parsed.success)
      throw new AppError('invalid_value', `Invalid value for "${column.key}"`, { column_id: column.key });
    meta = await checkDependencyValue(tx, item, column, { ...(parsed.data as object), item_ids: requested }, ok);
  }

  const previous = await linkTargets(tx, column.id, item.id);
  // r19relfilter: NEW links must match the column's filter (per policy); existing ones are never checked.
  const ids = dependency
    ? requested
    : await checkNewLinks(tx, a, {
        column,
        itemId: item.id,
        ids: requested,
        previous,
        targets: ok,
        policy: relationPolicy(a, column.settings ?? {}, writeMeta),
        exempt: justCreatedBy(a, ok, parsed.new_item_ids),
      });
  await replaceLinks(tx, {
    accountId: a.ctx.accountId,
    columnId: column.id,
    fromItemId: item.id,
    toItemIds: ids,
    createdBy: a.user.id,
    meta,
  });
  // Two-way (03 §2.16): the partner column's cells follow, as a side effect (no rights needed there).
  const reflected = await syncReflection(tx, {
    accountId: a.ctx.accountId,
    columnId: column.id,
    column,
    fromItemId: item.id,
    before: previous,
    after: ids,
    actorId: a.user.id,
    requestId: a.requestId,
  });
  // The partner cells changed too: names computed from them follow.
  if (reflected.length) await noteItemsChanged(tx, nameWho(a), reflected);
  if (!ids.length) {
    await deleteCell(tx, item.id, column.id);
    return null;
  }
  const ordered = ids.map((id) => ok.find((t) => t.id === id)!);
  const value = meta ? dependencyCellValue(ids, meta) : { item_ids: ids };
  await upsertCell(tx, {
    itemId: item.id,
    columnId: column.id,
    accountId: a.ctx.accountId,
    boardId: item.boardId,
    value,
    textValue: ordered.map((t) => t.name).join(', '),
    numberValue: ids.length,
    dateValue: null,
    dateEndValue: null,
    updatedBy: a.user.id,
    updatedByType: 'user',
  });
  return value;
};

/**
 * r19relfilter: "create new item" in the picker links the item it just made, even when it does not match the
 * filter (it is marked). Only items this actor created in the last 15 minutes count.
 */
const JUST_CREATED_MS = 15 * 60_000;
const justCreatedBy = (a: Actor, targets: ItemRow[], raw: unknown) => {
  if (!Array.isArray(raw)) return new Set<string>();
  const asked = new Set(raw.map(String));
  const since = Date.now() - JUST_CREATED_MS;
  return new Set(
    targets
      .filter((t) => asked.has(t.id) && t.createdBy === a.user.id && t.createdAt.getTime() >= since)
      .map((t) => t.id),
  );
};

const columnsByKey = (columns: ColumnRow[], keys: string[]) => {
  const map = new Map(columns.map((c) => [c.key, c]));
  return keys.map((k) => {
    const col = map.get(k);
    if (!col) throw new AppError('not_found', `Column "${k}" not found`);
    return col;
  });
};

/** An item the actor can read, with its board access (404 otherwise). */
export const loadItem = async (db: Db, a: Actor, itemId: string) => {
  const item = await findItem(db, a.ctx.accountId, itemId);
  if (!item) throw new AppError('not_found', 'Item not found');
  const access = await loadBoardAccess(db, a.ctx, a.user, item.boardId);
  assertBoard(access, 'item.read');
  // Items the actor may not see do not exist for them (05 §6).
  if (!(await isVisible(db, await boardVisibility(db, a, access), item)))
    throw new AppError('not_found', 'Item not found');
  return { item, access };
};

export const freshItem = async (db: Db, a: Actor, access: BoardAccess, itemId: string) => {
  const item = (await findItem(db, access.board.accountId, itemId))!;
  const calc = await calculatorFor(db, a, [itemId]);
  return itemDto(calc, item, await visibleColumns(db, access));
};

export const createItem = async (
  db: Db,
  a: Actor,
  boardId: string,
  input: z.infer<typeof createItemSchema>,
  /** P1-03: a caller's batch (a button that creates the item) — one Ctrl+Z removes the item with the rest. */
  opts: { batchId?: string; via?: 'popup' } = {},
) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.create');
  if (access.board.parentBoardId) throw new AppError('bad_request', 'subitems_need_a_parent');
  const group = input.group_id ? await findGroup(db, boardId, input.group_id) : (await listGroups(db, boardId))[0];
  if (!group) throw new AppError('not_found', 'Group not found');

  // The rank is read inside the transaction, under the group's advisory lock (released with it): two appends at
  // once used to read the same last key and tie (audit 2026-10-10 C5).
  const positionIn = async (tx: Db) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${group.id}))`);
    const pos = input.position;
    if (pos && typeof pos === 'object' && 'after_id' in pos) {
      const n = await neighbourPositions(tx, group.id, pos.after_id);
      if (!n) throw new AppError('bad_request', 'Unknown position anchor');
      return rankBetweenOrAfter(n.before, n.after);
    }
    if (pos === 'top') return rankBetween(null, await firstItemPosition(tx, group.id));
    return rankBetween(await lastItemPosition(tx, group.id), null);
  };

  const columns = await listColumns(db, boardId);
  // A board that computes names ignores a given name; a free one needs it.
  const initial = initialItemName(columns, input.name);
  const cellEntries = Object.entries(input.cells ?? {});
  const targets = columnsByKey(
    columns,
    cellEntries.map(([k]) => k),
  );
  const id = newId();
  const batchId = opts.batchId ?? (cellEntries.length ? newId() : null);

  await db.transaction(async (tx) => {
    const position = await positionIn(tx);
    const key = (await itemKeyFormat(tx, boardId)) ? await nextItemKeySeq(tx, boardId) : undefined;
    await insertItem(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId,
      groupId: group.id,
      depth: 0,
      position,
      name: initial.name,
      keySeq: key ? Number(key.seq) : null,
      createdBy: a.user.id,
      // An automation's item is the automation's (audit 2026-10-10 #7): `@creator` named its owner.
      creatorType: a.automation ? 'automation' : 'user',
    });
    const createdEvent = await recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: 'item.created',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId,
      itemId: id,
      batchId,
      after: { name: initial.name, group_id: group.id },
      // P1-03: an item a button's popup made — its batch undo sends it to the trash.
      ...(opts.via ? { meta: { via: opts.via } } : {}),
    });
    await followNewItem(tx, a, id);
    const item = (await findItem(tx, a.ctx.accountId, id))!;
    const [, changed] = await collectItemChanges(tx, async () => {
      for (const [i, [, value]] of cellEntries.entries()) {
        await writeCell(tx, a, access, item, targets[i]!, value, batchId);
      }
    });
    // The new item's computed name goes into its own `item.created` event (no separate rename event).
    await itemsChanged(tx, nameWho(a), [id, ...changed], { silent: new Map([[id, createdEvent]]) });
  });
  return freshItem(db, a, access, id);
};

const wfLast = (c: ColumnRow) => (columnWorkflow(c) ? 1 : 0);

export const updateItem = async (db: Db, a: Actor, itemId: string, input: z.infer<typeof updateItemSchema>) => {
  const { item, access } = await loadItem(db, a, itemId);
  assertBoard(access, 'item.update');
  const columns = await listColumns(db, item.boardId);
  assertAssigned(access, a.user, item, await itemCells(db, item.id), columns);
  // A computed name changes through its columns only: 409 item_name_computed.
  assertNameEditable(columns, item.name, input.name);
  const cellEntries = Object.entries(input.cells ?? {});
  const targets = columnsByKey(
    columns,
    cellEntries.map(([k]) => k),
  );
  // A date / dependency edit that may shift dependents (M8 ד7) is one batch with the shifts: one Ctrl+Z.
  const triggers = shiftTriggers(columns, new Set(targets.map((c) => c.id)));
  // a popup's subitems are part of the same edit (one batch with it).
  const withSubitems = !!(input.subitems?.create?.length || input.subitems?.update?.length);
  const batchId = cellEntries.length + (input.name ? 1 : 0) > 1 || triggers.length || withSubitems ? newId() : null;

  // Any event of the edit (a batch is undone as one) — returned so Ctrl+Z can undo it.
  let eventId: string | null = null;
  let shifted: string[] = [];
  const write = async (tx: Db) => {
    const before = triggers.length
      ? new Map((await itemCells(tx, item.id)).map((c) => [c.columnId, c.value as unknown]))
      : new Map<string, unknown>();
    if (input.name && input.name !== item.name) {
      await updateItemRow(tx, item.id, { name: input.name });
      eventId = await recordEvent(tx, {
        accountId: a.ctx.accountId,
        type: 'item.renamed',
        actorId: a.user.id,
        requestId: a.requestId,
        boardId: item.boardId,
        itemId: item.id,
        batchId,
        before: { name: item.name },
        after: { name: input.name },
      });
      // Relation cells showing this item, and names computed from it, follow the new name.
      await afterItemsRenamed(tx, nameWho(a), [item.id]);
    }
    // a workflow's status move is checked after the other cells of the same edit are written, so the
    // fields it requires may come with it.
    // and the subitems it asks for may come with it too (written first).
    if (withSubitems) await writePopupSubitems(tx, a, access, item, input.subitems, batchId!);
    const order = cellEntries.map((_, i) => i).sort((x, y) => wfLast(targets[x]!) - wfLast(targets[y]!));
    const wfMeta = {
      ...(input.workflow_override ? { workflow_override: true } : {}),
      ...(input.note ? { workflow_note: true } : {}),
    };
    for (const i of order) {
      eventId = (await writeCell(tx, a, access, item, targets[i]!, cellEntries[i]![1], batchId, wfMeta)) ?? eventId;
    }
    // phase 2: a popup's note goes on the item as an update, in the same transaction.
    if (input.note) await createUpdate(tx, a, item.id, { doc: plainTextDoc(input.note) });
    if (triggers.length) {
      const written = new Set(targets.map((c) => c.id));
      shifted = await shiftDependents(tx, a, access, item, triggers, columns, before, written, batchId, writeCell);
    }
  };
  await db.transaction(async (tx) => {
    // Several cells (and dependency shifts): one recompute of computed names at the end.
    const [, changed] = await collectItemChanges(tx, () => write(tx));
    await itemsChanged(tx, nameWho(a), changed);
  });
  return {
    ...(await freshItem(db, a, access, item.id)),
    event_id: eventId,
    ...(shifted.length ? { shifted_item_ids: shifted } : {}),
  };
};

export const setCell = async (
  db: Db,
  a: Actor,
  itemId: string,
  columnKey: string,
  value: unknown,
  opts: { workflow_override?: boolean } = {},
) => updateItem(db, a, itemId, { cells: { [columnKey]: value }, ...opts });

export const moveItemToGroup = async (
  db: Db,
  a: Actor,
  itemId: string,
  groupId: string,
  position: { after_id: string } | { before_id: string } | 'top' | 'bottom' | undefined,
  between?: { after_id: string | null; before_id: string | null },
) => {
  const { item, access } = await loadItem(db, a, itemId);
  assertBoard(access, 'item.move_group');
  assertAssigned(access, a.user, item, await itemCells(db, item.id), await listColumns(db, item.boardId));
  if (item.depth > 0) throw new AppError('bad_request', 'subitem_no_group');
  const group = await findGroup(db, item.boardId, groupId);
  if (!group) throw new AppError('not_found', 'Group not found');
  const boardItems = await listBoardItems(db, item.boardId);
  let next: string;
  if (between) {
    const rankOf = (id: string | null) => {
      if (!id) return null;
      const anchor = boardItems.find((i) => i.id === id && i.depth === 0);
      if (!anchor) throw new AppError('bad_request', 'Unknown position anchor');
      return anchor.position;
    };
    const after = rankOf(between.after_id);
    const before = rankOf(between.before_id);
    // Ranks of different groups can tie; then "right after `after`" is the best we can do.
    next = rankBetween(after, before !== null && (after === null || after < before) ? before : null);
  } else {
    const siblings = boardItems
      .filter((i) => i.groupId === group.id && i.depth === 0 && i.id !== item.id)
      .map((i) => ({ id: i.id, position: i.position }));
    next = positionAmong(siblings, position ?? 'bottom');
  }
  const eventId = await db.transaction(async (tx) => {
    await updateItemRow(tx, item.id, { groupId: group.id, position: next });
    return recordEvent(tx, {
      accountId: a.ctx.accountId,
      type: item.groupId === group.id ? 'item.reordered' : 'item.moved_to_group',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      before: { group_id: item.groupId, position: item.position },
      after: { group_id: group.id, position: next },
    });
  });
  // The move's event: Ctrl+Z can undo a drag (Fix: ).
  return { ...(await freshItem(db, a, access, item.id)), event_id: eventId };
};

/** Soft delete → trash (30 days); children go with the parent. */
export const deleteItem = async (db: Db, a: Actor, itemId: string) => {
  const { item, access } = await loadItem(db, a, itemId);
  assertBoard(access, 'item.delete');
  assertAssigned(access, a.user, item, await itemCells(db, item.id), await listColumns(db, item.boardId));
  await assertDeleteCode(db, a, access.board);
  return db.transaction((tx) => deleteItemTx(tx, a, item, null));
};

/** The delete itself, inside the caller's transaction (single delete or a batch). Returns the event id. */
export const deleteItemTx = async (tx: Db, a: Actor, item: ItemRow, batchId: string | null) => {
  const ids = await liveSubtreeIds(tx, item.id);
  await setItemsDeleted(tx, ids, new Date());
  const entryId = await trashObject(tx, a, {
    type: 'item',
    id: item.id,
    name: item.name,
    boardId: item.boardId,
    payload: { item_ids: ids },
  });
  // Names computed from it (a relation / mirror to it, a parent over its subitems) follow.
  await noteItemsChanged(tx, nameWho(a), [item.id, ...(item.parentItemId ? [item.parentItemId] : [])]);
  return recordEvent(tx, {
    accountId: a.ctx.accountId,
    type: 'item.deleted',
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: item.boardId,
    itemId: item.id,
    batchId,
    before: { name: item.name, group_id: item.groupId },
    meta: { trash_entry_id: entryId },
  });
};

/**
 * `deleteItemTx` for many items in a few statements (undo of a bulk insert of thousands of rows): one trash entry
 * and one `item.deleted` event per item, as if each was deleted alone. Returns the event ids in input order.
 */
export const deleteItemsTx = async (tx: Db, a: Actor, list: ItemRow[], batchId: string | null) => {
  if (!list.length) return [];
  const trees = await liveSubtreesOf(
    tx,
    list.map((i) => i.id),
  );
  await setItemsDeleted(tx, [...trees.values()].flat(), new Date());
  const entryIds = await trashObjects(
    tx,
    a,
    list.map((item) => ({
      type: 'item' as const,
      id: item.id,
      name: item.name,
      boardId: item.boardId,
      payload: { item_ids: trees.get(item.id) ?? [item.id] },
    })),
  );
  return recordEvents(
    tx,
    list.map((item, i) => ({
      accountId: a.ctx.accountId,
      type: 'item.deleted',
      actorId: a.user.id,
      requestId: a.requestId,
      boardId: item.boardId,
      itemId: item.id,
      batchId,
      before: { name: item.name, group_id: item.groupId },
      meta: { trash_entry_id: entryIds[i] },
    })),
  );
};

/** Relation picker (06 §2.12): items of a readable board matching `q`. */
/**
 * The relation picker's items of a board by name, 30 a page ("load more" when one board is
 * browsed); `next_offset` while there are more (a hidden one counts — the next page may be all hidden).
 */
export const searchItems = async (db: Db, a: Actor, boardId: string, q: string, offset = 0) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const page = await searchItemsByName(db, boardId, q.trim(), SEARCH_PAGE + 1, offset);
  const found = page.slice(0, SEARCH_PAGE);
  const rows = await itemsByIds(
    db,
    a.ctx.accountId,
    found.map((i) => i.id),
  );
  const visible = new Set((await filterVisible(db, await boardVisibility(db, a, access), rows)).map((i) => i.id));
  return {
    data: found
      .filter((i) => visible.has(i.id))
      .map((i) => ({ id: i.id, name: i.name, board_id: i.boardId, group_id: i.groupId })),
    next_offset: page.length > SEARCH_PAGE ? offset + SEARCH_PAGE : null,
  };
};
const SEARCH_PAGE = 30;

/** GET /boards/:id/columns/:col/values — existing values for suggestions; hidden columns stay hidden. */
export const columnValues = async (db: Db, a: Actor, boardId: string, columnKey: string, q: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const column = (await visibleColumns(db, access)).find((c) => c.key === columnKey);
  if (!column || columnTypes.get(column.type)?.storage !== 'cell') throw new AppError('not_found', 'Column not found');
  // Values of items the actor may not see must not show either (05 §6).
  const v = await boardVisibility(db, a, access);
  const ids = v ? (await filterVisible(db, v, await listBoardItems(db, boardId))).map((i) => i.id) : null;
  return (await columnValueCounts(db, column.id, q.trim(), ids)).map((r) => ({ value: r.value!, count: r.count }));
};

/** GET /items/:id — one item with computed cells (item card, deep links). */
export const getItem = async (db: Db, a: Actor, itemId: string) => {
  const { access } = await loadItem(db, a, itemId);
  return freshItem(db, a, access, itemId);
};
