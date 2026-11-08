// SPDX-License-Identifier: AGPL-3.0-only
import { z } from 'zod';
import {
  AppError,
  CellValueError,
  cellMatches,
  cellsFromValues,
  columnValuesOf,
  integrationFields,
  valuesNeedMembers,
  COLUMN_CHOICES_MAX,
  columnTypes,
  type ColumnChoice,
  type ColumnChoices,
  type BoardDetail,
  type BoardListEntry,
  type BoardSchema,
  type FindItemsInput,
  type IntegrationColumn,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { AppDeps } from '../../types';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { findBoard, findSubBoard, listColumns } from '../boards/boards.repo';
import { accountTimeZone } from '../support/support.access';
import { getBoard, listReadableBoards, listVisibleWorkspaces } from '../boards/boards.service';
import { columnValues, listItems, loadItem, searchItems, visibleColumns, type Actor } from '../items/items.service';
import { listTags } from '../tags/tags.service';
import { listMembers } from '../users/users.service';
import { boardItemNames, childItems, columnCellValues } from './integrations.repo';

/**
 * Integration helpers (n8n, Make, …): a flat board list for pickers, a board's schema for dynamic fields, and find
 * by column value. Every read goes through the same access checks as the app (board read, column restrictions,
 * view_items, a token's board limit).
 */

/** The boards I can open, flat (every workspace), by name. */
export const listBoardsFlat = async (db: Db, a: Actor, q?: { q?: string; workspace_id?: string }) => {
  const needle = q?.q?.trim().toLocaleLowerCase();
  // One query for every workspace (not a tree each): the web app's pickers call this on accounts with hundreds of
  // workspaces.
  const workspaces = (await listVisibleWorkspaces(db, a)).filter((w) => !q?.workspace_id || w.id === q.workspace_id);
  const wsName = new Map(workspaces.map((w) => [w.id, w.name]));
  const out: BoardListEntry[] = [];
  for (const b of await listReadableBoards(db, a, workspaces)) {
    if (needle && !b.name.toLocaleLowerCase().includes(needle)) continue;
    out.push({
      id: b.id,
      name: b.name,
      kind: b.kind,
      workspace_id: b.workspace_id,
      workspace_name: wsName.get(b.workspace_id) ?? '',
      folder_id: b.folder_id,
    });
  }
  return { data: out };
};

/** JSON Schema of a type's cell value, once per type (null when zod cannot express it). */
const valueSchemas = new Map<string, Record<string, unknown> | null>();
const valueSchemaOf = (type: string) => {
  if (valueSchemas.has(type)) return valueSchemas.get(type)!;
  const def = columnTypes.get(type);
  let out: Record<string, unknown> | null = null;
  if (def && def.storage === 'cell' && !def.readOnly) {
    try {
      const { $schema: _drop, ...rest } = z.toJSONSchema(def.valueSchema, {
        io: 'input',
        unrepresentable: 'any',
      }) as Record<string, unknown>;
      out = rest;
    } catch {
      out = null;
    }
  }
  valueSchemas.set(type, out);
  return out;
};

type Label = { id: number; label: string; color?: string; is_deactivated?: boolean };

const columnOf = (col: BoardDetail['columns'][number]): IntegrationColumn => {
  const def = columnTypes.get(col.type);
  const labels = (col.settings as { labels?: Label[] }).labels;
  const hasOptions = def?.filterModel === 'label' || def?.filterModel === 'labels';
  return {
    id: col.id,
    title: col.title,
    type: col.type,
    description: col.description,
    writable: !!def && !def.readOnly && def.storage === 'cell' && def.engine !== 'files' && !col.read_only,
    value_model: def?.filterModel ?? 'text',
    options:
      hasOptions && Array.isArray(labels)
        ? labels
            .filter((l) => !l.is_deactivated && l.label)
            .map((l) => ({ id: l.id, label: l.label, color: l.color ?? null }))
        : null,
    value_schema: valueSchemaOf(col.type),
    linked_board_ids:
      col.type === 'board_relation'
        ? (((col.settings as { board_ids?: unknown }).board_ids as unknown[] | undefined)?.filter(
            (x): x is string => typeof x === 'string',
          ) ?? [])
        : null,
  };
};

/** A board as an integration renders it: groups, and per column its type, options and value schema. */
export const boardSchema = async (db: Db, a: Actor, boardId: string): Promise<BoardSchema> => {
  const board = await getBoard(db, a, boardId);
  const sub = board.subitems_board_id ? await getBoard(db, a, board.subitems_board_id).catch(() => null) : null;
  return {
    id: board.id,
    name: board.name,
    kind: board.kind,
    groups: board.groups.map((g) => ({ id: g.id, title: g.title, color: g.color })),
    columns: board.columns.map(columnOf),
    subitems: sub ? { board_id: sub.id, columns: sub.columns.map(columnOf) } : null,
  };
};

/** Candidates scanned before the visibility check (more matches than this = a value too generic to look up). */
const FIND_SCAN_MAX = 200;

/** Items of a board whose column holds a value (phone / email aware), in board order. */
export const findItems = async (db: Db, a: Actor, boardId: string, input: FindItemsInput) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const column = (await visibleColumns(db, access)).find((c) => c.key === input.column_id);
  if (!column) throw new AppError('not_found', 'Column not found', { column_id: input.column_id });
  const def = columnTypes.get(column.type);
  let ids: string[];
  if (def?.storage === 'item' || column.type === 'name') {
    ids = (await boardItemNames(db, boardId))
      .filter((r) => cellMatches('text', { value: null, text: r.text }, input.value, input.match))
      .map((r) => r.itemId);
  } else if (def?.storage === 'cell') {
    ids = (await columnCellValues(db, boardId, column.id))
      .filter((r) => cellMatches(column.type, { value: r.value, text: r.text }, input.value, input.match))
      .map((r) => r.itemId);
  } else
    throw new AppError('invalid_value', 'column_not_searchable', { column_id: input.column_id, type: column.type });
  const found = await listItems(db, a, boardId, [...new Set(ids)].slice(0, FIND_SCAN_MAX));
  return { data: found.slice(0, input.limit) };
};

/** The subitems right under an item (or under a subitem), in their order — what the actor may see. */
export const listSubitems = async (db: Db, a: Actor, itemId: string) => {
  await loadItem(db, a, itemId);
  const children = await childItems(db, itemId);
  const boardId = children[0]?.boardId;
  if (!boardId) return { data: [] };
  return {
    data: await listItems(
      db,
      a,
      boardId,
      children.map((c) => c.id),
    ),
  };
};

/**
 * The values a column can hold, for the value pickers of integrations (n8n, Make): status / dropdown labels, the
 * account's people, tags, the items a connect-boards column links (searched by name), item names, or the values
 * already typed in a free-text column. `q` narrows by text. Reads go through the same access checks as the app.
 */
export const columnChoices = async (
  deps: Pick<AppDeps, 'db' | 'storage'>,
  a: Actor,
  boardId: string,
  columnKey: string,
  input: { q: string; subitems: boolean; withEmails: boolean },
): Promise<ColumnChoices> => {
  const { db } = deps;
  let targetId = boardId;
  if (input.subitems) {
    assertBoard(await loadBoardAccess(db, a.ctx, a.user, boardId), 'item.read');
    const sub = await findSubBoard(db, boardId);
    if (!sub) throw new AppError('not_found', 'Column not found', { column_id: columnKey });
    targetId = sub.id;
  }
  const access = await loadBoardAccess(db, a.ctx, a.user, targetId);
  assertBoard(access, 'item.read');
  const q = input.q.trim().toLocaleLowerCase();
  const hit = (text: string) => !q || text.toLocaleLowerCase().includes(q);
  const cap = (data: ColumnChoice[]) => data.slice(0, COLUMN_CHOICES_MAX);
  const items = async (boardIds: string[]) => {
    const out: ColumnChoice[] = [];
    for (const id of boardIds) {
      const found = (await searchItems(db, a, id, input.q).catch(() => null))?.data ?? [];
      const name = found.length ? ((await findBoard(db, a.ctx.accountId, id))?.name ?? null) : null;
      out.push(...found.map((i) => ({ id: i.id, text: i.name, hint: name })));
    }
    return out;
  };

  if (columnKey === 'name') return { kind: 'items', data: cap(await items([targetId])) };
  const column = (await visibleColumns(db, access)).find((c) => c.key === columnKey);
  if (!column) throw new AppError('not_found', 'Column not found', { column_id: columnKey });
  const def = columnTypes.get(column.type);
  const settings = (column.settings ?? {}) as { labels?: Label[]; board_ids?: unknown };
  switch (def?.filterModel) {
    case 'label':
    case 'labels':
      return {
        kind: 'labels',
        data: cap(
          (settings.labels ?? [])
            .filter((l) => !l.is_deactivated && l.label && hit(l.label))
            .map((l) => ({ id: String(l.id), text: l.label, hint: null })),
        ),
      };
    case 'people': {
      const members = await listMembers(deps, a.ctx, a.user, { status: 'active' }).catch(() => []);
      return {
        kind: 'people',
        data: cap(
          members
            .filter((m) => hit(input.withEmails ? `${m.name} ${m.email}` : m.name))
            .map((m) => ({ id: m.user_id, text: m.name, hint: input.withEmails ? m.email : null })),
        ),
      };
    }
    case 'tags':
      return {
        kind: 'tags',
        data: cap(
          (await listTags(db, a)).filter((t) => hit(t.name)).map((t) => ({ id: t.id, text: t.name, hint: null })),
        ),
      };
    case 'links': {
      const linked =
        column.type === 'dependency'
          ? [targetId]
          : (Array.isArray(settings.board_ids) ? settings.board_ids : []).filter(
              (x): x is string => typeof x === 'string',
            );
      return { kind: 'items', data: cap(await items(linked)) };
    }
    default:
      if (def?.storage !== 'cell') return { kind: 'values', data: [] };
      return {
        kind: 'values',
        data: cap(
          (await columnValues(db, a, targetId, columnKey, input.q)).map((v) => ({
            id: null,
            text: v.value,
            hint: null,
          })),
        ),
      };
  }
};

// ── conveniences for integrations that run no code of their own (Make without custom IML functions) ──────────

/**
 * Plain column values (`values` on create / update) → stored cells, on the board that holds the item: labels by
 * text, people by email or name, dates in the person's time zone … (`cellsFromValues`). A value that does not fit
 * answers 422 with a message that names the column and the choices.
 */
export const cellsFromPlainValues = async (
  deps: Pick<AppDeps, 'db' | 'storage'>,
  a: Actor,
  boardId: string | null,
  values: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> => {
  if (!values || !Object.keys(values).length) return {};
  const { db } = deps;
  const columns = boardId ? (await getBoard(db, a, boardId)).columns.map(columnOf) : [];
  const members = valuesNeedMembers(columns, values)
    ? await listMembers(deps, a.ctx, a.user, { status: 'active' }).catch(() => [])
    : [];
  const timeZone = a.user.timezone ?? (await accountTimeZone(db, a.ctx.accountId));
  try {
    return cellsFromValues(columns, values, members, { timeZone });
  } catch (e) {
    if (e instanceof CellValueError) throw new AppError('invalid_value', e.message, { column_id: e.columnId });
    throw e;
  }
};

/** The board an item lives on, for converting `values` of an update. */
export const itemBoardOf = async (db: Db, a: Actor, itemId: string): Promise<string> =>
  (await loadItem(db, a, itemId)).item.boardId;

/** The board a new subitem of `parentItemId` lands on (the sub-board, null before its first subitem). */
export const subitemBoardOf = async (db: Db, a: Actor, parentItemId: string): Promise<string | null> => {
  const { item, access } = await loadItem(db, a, parentItemId);
  if (access.board.parentBoardId) return item.boardId;
  return (await findSubBoard(db, item.boardId))?.id ?? null;
};

type WithCells = { board_id: string; cells?: Record<string, { text?: string | null } | null> };

/** `?format=flat`: each item also gets `column_values` — its cells' text keyed by column title. */
export const flatItems = async <T extends WithCells>(
  db: Db,
  list: T[],
): Promise<(T & { column_values: Record<string, string | null> })[]> => {
  const titles = new Map<string, Map<string, string>>();
  for (const boardId of new Set(list.map((i) => i.board_id)))
    titles.set(boardId, new Map((await listColumns(db, boardId)).map((c) => [c.key, c.title])));
  return list.map((i) => ({
    ...i,
    column_values: columnValuesOf(i.cells ?? {}, titles.get(i.board_id) ?? new Map<string, string>()),
  }));
};

/** One item, flattened when `format=flat`. */
export const flatIf = async <T extends WithCells>(db: Db, format: string | undefined, item: T): Promise<T> =>
  format === 'flat' ? (await flatItems(db, [item]))[0]! : item;

/** Items, flattened when `format=flat`. */
export const flatListIf = async <T extends WithCells>(db: Db, format: string | undefined, list: T[]): Promise<T[]> =>
  format === 'flat' ? flatItems(db, list) : list;

/** The column-values form of a board (or of its sub-board): one input field per writable column, in its type. */
export const boardFields = async (db: Db, a: Actor, boardId: string, subitems: boolean) => ({
  data: integrationFields(await boardSchema(db, a, boardId), subitems),
});
