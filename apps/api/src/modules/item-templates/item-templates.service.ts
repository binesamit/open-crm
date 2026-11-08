// SPDX-License-Identifier: AGPL-3.0-only
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import {
  accountSettingsSchema,
  addCountedDays,
  AppError,
  type ApplyItemTemplate,
  type ApplyItemTemplateResult,
  columnTypes,
  countDays,
  type CreateItemTemplate,
  dateInZone,
  dayWeight,
  effectiveDepthMax,
  fillItemTemplateText,
  ITEM_TEMPLATE_NODES_MAX,
  type ItemTemplateCell,
  type ItemTemplateDto,
  type ItemTemplateFile,
  type ItemTemplateNode,
  type ItemTemplateSummary,
  type ItemTemplateUpdate,
  type ItemTemplateVariable,
  itemTemplateNodeSchema,
  itemTemplateStats,
  itemTemplateVariableSchema,
  newId,
  ownWriter,
  rankBetween,
  renderRichDoc,
  renderUpdateBody,
  type RichNode,
  type SaveItemAsTemplate,
  type UpdateItemTemplate,
} from '@bines/shared';
import { z } from 'zod';
import type { Db } from '../../db/client';
import { assets, updateFiles, updates } from '../../db/schema';
import { accountWorkCalendar } from '../../lib/account-calendar';
import type { AppDeps } from '../../types';
import { getAccountSettings } from '../accounts/accounts.repo';
import { recordEvent } from '../activity/activity.repo';
import { assertBoard, type BoardAccess, columnAllowed, loadBoardAccess } from '../boards/boards.access';
import {
  type BoardRow,
  type ColumnRow,
  findGroup,
  findSubBoard,
  itemKeyFormat,
  listColumns,
  listGroups,
  nextItemKeySeq,
} from '../boards/boards.repo';
import {
  assetsByIds,
  cellFileAssets,
  insertAsset,
  insertCellFiles,
  insertUpdateFiles,
  markUploaded,
} from '../files/files.repo';
import { ensureFileCell, ownUploadedAssets, safeName, syncFileCell } from '../files/files.service';
import {
  childItemsOf,
  findItem,
  firstItemPosition,
  insertItem,
  itemCells,
  type ItemRow,
  lastItemPosition,
} from '../items/items.repo';
import { type Actor, loadItem, nameWho, writeCell } from '../items/items.service';
import { collectItemChanges, initialItemName, itemsChanged } from '../items/names.service';
import { ensureSubBoard } from '../items/subitems.service';
import { followNewItem } from '../notifications/notifications.service';
import { insertUpdate } from '../updates/updates.repo';
import {
  boardItemTemplates,
  findItemTemplate,
  insertItemTemplate,
  type ItemTemplateRow,
  itemTemplateAssetIds,
  setItemTemplateAssets,
  updateItemTemplateRow,
} from './item-templates.repo';

/**
 * Item templates: save an item tree as a template, build / edit one, and apply it — a new item, or
 * the template's subitems under an existing item. Everything a person, the API and the AI tools do goes through
 * here: the board's access (reading templates = reading the board; saving / editing = changing its structure,
 * `column.create`; applying = `item.create`), each value through `writeCell` (validation, column restrictions,
 * events), one batch per apply (one undo trashes the whole tree).
 */
type Deps = Pick<AppDeps, 'db' | 'storage'>;

// ---- reading ----

/** A template's variables as saved (anything unreadable = none). */
export const variablesOf = (row: Pick<ItemTemplateRow, 'variables'>): ItemTemplateVariable[] =>
  z.array(itemTemplateVariableSchema).catch([]).parse(row.variables);
const rootOf = (row: ItemTemplateRow): ItemTemplateNode => {
  const r = itemTemplateNodeSchema.safeParse(row.root);
  return r.success ? r.data : { id: 'root', name: row.name, cells: {}, updates: [], children: [] };
};

const summary = (row: ItemTemplateRow): ItemTemplateSummary => {
  const { nodes, depth } = itemTemplateStats(rootOf(row));
  return {
    id: row.id,
    board_id: row.boardId,
    name: row.name,
    category: row.category,
    description: row.description,
    variables: variablesOf(row),
    nodes,
    depth,
    version: row.version,
    source_item_id: row.sourceItemId,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
};
const dto = (row: ItemTemplateRow): ItemTemplateDto => ({ ...summary(row), root: rootOf(row) });

/** A template the actor may read (its board's access). */
const loadTemplate = async (db: Db, a: Actor, id: string) => {
  const row = await findItemTemplate(db, a.ctx.accountId, id);
  if (!row) throw new AppError('not_found', 'Item template not found');
  const access = await loadBoardAccess(db, a.ctx, a.user, row.boardId);
  assertBoard(access, 'item.read');
  return { row, access };
};

/** A top-level board (templates live on the board; deeper levels use its subitems columns). */
const topBoardAccess = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  if (access.board.parentBoardId) throw new AppError('bad_request', 'item_templates_on_the_main_board');
  return access;
};

/** GET /boards/{id}/item-templates */
export const listItemTemplates = async (db: Db, a: Actor, boardId: string) => {
  const access = await topBoardAccess(db, a, boardId);
  assertBoard(access, 'item.read');
  return { data: (await boardItemTemplates(db, a.ctx.accountId, boardId)).map(summary) };
};

/** GET /item-templates/{id} */
export const getItemTemplate = async (db: Db, a: Actor, id: string) => dto((await loadTemplate(db, a, id)).row);

// ---- files: a template holds its own copies ----

/** A server-side copy of a stored file as a new asset of the account (counted in its storage). */
const copyFile = async (deps: Deps, a: Actor, src: typeof assets.$inferSelect, name?: string) => {
  if (!src.storageKey) return null;
  const id = newId();
  const fileName = name ?? src.fileName;
  const key = `${a.ctx.accountId}/${id}/${safeName(fileName)}`;
  await insertAsset(deps.db, {
    id,
    accountId: a.ctx.accountId,
    ownerId: a.user.id,
    kind: 'file',
    storageKey: key,
    fileName,
    mime: src.mime,
    size: src.size,
    width: src.width,
    height: src.height,
    sha256: src.sha256,
    uploadStatus: 'pending',
  });
  await deps.storage.copy(src.storageKey, key);
  await markUploaded(deps.db, id, src.size, src.mime);
  return { asset_id: id, name: fileName };
};

const filesOfTree = (root: ItemTemplateNode) => {
  const out: ItemTemplateFile[] = [];
  const walk = (n: ItemTemplateNode) => {
    for (const c of Object.values(n.cells)) if (c.kind === 'files') out.push(...c.files);
    for (const u of n.updates) out.push(...u.files);
    n.children.forEach(walk);
  };
  walk(root);
  return out;
};

/**
 * The files a tree sent by the editor / the API / an AI tool may name: the template's own already, or files the
 * actor just uploaded (they become the template's).
 */
const checkTreeFiles = async (db: Db, a: Actor, root: ItemTemplateNode, held: string[]) => {
  const ids = [...new Set(filesOfTree(root).map((f) => f.asset_id))];
  const fresh = ids.filter((id) => !held.includes(id));
  if (fresh.length) await ownUploadedAssets(db, a, fresh);
  return ids;
};

// ---- limits ----

const checkTree = (root: ItemTemplateNode, board: BoardRow) => {
  const { nodes, depth } = itemTemplateStats(root);
  if (nodes > ITEM_TEMPLATE_NODES_MAX)
    throw new AppError('validation_failed', 'item_template_too_big', { limit: ITEM_TEMPLATE_NODES_MAX, nodes });
  const max = effectiveDepthMax(board.hierarchyDepthMax);
  if (depth > max) throw new AppError('depth_exceeded', `This board allows ${max} levels of subitems`, { max, depth });
};

const uniqueVariables = (vars: ItemTemplateVariable[]) => {
  const keys = vars.map((v) => v.key);
  if (new Set(keys).size !== keys.length) throw new AppError('validation_failed', 'item_template_duplicate_variable');
  return vars;
};

// ---- create / update / delete (each one recorded: an API or AI call is one undoable batch) ----

type TemplateState = Pick<ItemTemplateRow, 'name' | 'category' | 'description' | 'variables' | 'root' | 'version'>;
const stateOf = (r: ItemTemplateRow): TemplateState => ({
  name: r.name,
  category: r.category,
  description: r.description,
  variables: r.variables,
  root: r.root,
  version: r.version,
});

type TemplateEventType =
  'item_template.created' | 'item_template.updated' | 'item_template.deleted' | 'item_template.restored';

const templateEvent = (
  tx: Db,
  a: Actor,
  type: TemplateEventType,
  row: Pick<ItemTemplateRow, 'id' | 'boardId' | 'name'>,
  extra: { before?: unknown; after?: unknown; undo_of?: string } = {},
) =>
  recordEvent(tx, {
    accountId: a.ctx.accountId,
    type,
    actorId: a.user.id,
    requestId: a.requestId,
    boardId: row.boardId,
    before: (extra.before ?? null) as never,
    after: (extra.after ?? { id: row.id, name: row.name }) as never,
    meta: { template_id: row.id, ...(extra.undo_of ? { undo_of: extra.undo_of } : {}) },
  });

/** POST /boards/{id}/item-templates — a template built in the editor, by the API or an AI tool. */
export const createItemTemplate = async (db: Db, a: Actor, boardId: string, input: CreateItemTemplate) => {
  const access = await topBoardAccess(db, a, boardId);
  assertBoard(access, 'column.create');
  checkTree(input.root, access.board);
  const files = await checkTreeFiles(db, a, input.root, []);
  const id = newId();
  await db.transaction(async (tx) => {
    await insertItemTemplate(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId,
      name: input.name,
      category: input.category,
      description: input.description,
      variables: uniqueVariables(input.variables) as never,
      root: input.root as never,
      createdBy: a.user.id,
    });
    await setItemTemplateAssets(tx, a.ctx.accountId, id, files);
    await templateEvent(tx, a, 'item_template.created', { id, boardId, name: input.name });
  });
  return dto((await findItemTemplate(db, a.ctx.accountId, id))!);
};

/** PATCH /item-templates/{id} — a new tree or new variables is a new version. */
export const updateItemTemplate = async (db: Db, a: Actor, id: string, patch: UpdateItemTemplate) => {
  const { row, access } = await loadTemplate(db, a, id);
  assertBoard(access, 'column.create');
  const treeChanged = patch.root !== undefined || patch.variables !== undefined;
  let files: string[] | null = null;
  if (patch.root) {
    checkTree(patch.root, access.board);
    files = await checkTreeFiles(db, a, patch.root, await itemTemplateAssetIds(db, id));
  }
  await db.transaction(async (tx) => {
    await updateItemTemplateRow(tx, id, {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.category !== undefined ? { category: patch.category } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.variables !== undefined ? { variables: uniqueVariables(patch.variables) as never } : {}),
      ...(patch.root !== undefined ? { root: patch.root as never } : {}),
      ...(treeChanged ? { version: row.version + 1 } : {}),
    });
    if (files) await setItemTemplateAssets(tx, a.ctx.accountId, id, files);
    const after = (await findItemTemplate(tx, a.ctx.accountId, id))!;
    await templateEvent(tx, a, 'item_template.updated', row, { before: stateOf(row), after: stateOf(after) });
  });
  return dto((await findItemTemplate(db, a.ctx.accountId, id))!);
};

/** DELETE /item-templates/{id} — out of every menu; `restore` (or undo) brings it back, its files kept till then. */
export const deleteItemTemplate = async (db: Db, a: Actor, id: string) => {
  const { row, access } = await loadTemplate(db, a, id);
  assertBoard(access, 'column.create');
  await db.transaction(async (tx) => {
    await updateItemTemplateRow(tx, id, { deletedAt: new Date() });
    await templateEvent(tx, a, 'item_template.deleted', row);
  });
  return { ok: true as const, id };
};

/** POST /item-templates/{id}/restore */
export const restoreItemTemplate = async (db: Db, a: Actor, id: string) => {
  const row = await findItemTemplate(db, a.ctx.accountId, id, true);
  if (!row) throw new AppError('not_found', 'Item template not found');
  assertBoard(await loadBoardAccess(db, a.ctx, a.user, row.boardId), 'column.create');
  await db.transaction(async (tx) => {
    await updateItemTemplateRow(tx, id, { deletedAt: null });
    await templateEvent(tx, a, 'item_template.restored', row);
  });
  return dto((await findItemTemplate(db, a.ctx.accountId, id))!);
};

/**
 * Undo of a template's event (activity undo): made → deleted, deleted → back, changed → its previous state (a new
 * version of it). Returns the undo's own event id.
 */
export const undoItemTemplateEventTx = async (
  tx: Db,
  a: Actor,
  ev: { id: string; type: string; payload?: unknown },
) => {
  const p = (ev.payload ?? {}) as { before?: TemplateState | null; meta?: { template_id?: string } };
  const row = await findItemTemplate(tx, a.ctx.accountId, String(p.meta?.template_id ?? ''), true);
  if (!row) throw new AppError('already_undone', 'Item template not found');
  assertBoard(await loadBoardAccess(tx, a.ctx, a.user, row.boardId), 'column.create');
  const undo = { undo_of: ev.id };
  if (ev.type === 'item_template.created' || ev.type === 'item_template.restored') {
    if (row.deletedAt) throw new AppError('already_undone', 'Item template already deleted');
    await updateItemTemplateRow(tx, row.id, { deletedAt: new Date() });
    return templateEvent(tx, a, 'item_template.deleted', row, undo);
  }
  if (ev.type === 'item_template.deleted') {
    if (!row.deletedAt) throw new AppError('already_undone', 'Item template is not deleted');
    await updateItemTemplateRow(tx, row.id, { deletedAt: null });
    return templateEvent(tx, a, 'item_template.restored', row, undo);
  }
  const before = p.before;
  if (!before) throw new AppError('not_undoable', 'Nothing to go back to');
  const root = itemTemplateNodeSchema.parse(before.root);
  await updateItemTemplateRow(tx, row.id, {
    name: before.name,
    category: before.category,
    description: before.description,
    variables: before.variables as never,
    root: root as never,
    version: row.version + 1,
  });
  await setItemTemplateAssets(
    tx,
    a.ctx.accountId,
    row.id,
    filesOfTree(root).map((f) => f.asset_id),
  );
  return templateEvent(tx, a, 'item_template.updated', row, { before: stateOf(row), after: before, ...undo });
};

// ---- save an item as a template ----

/** The columns a template keeps a value of (as a cell holds it): not computed, not their own writer's, no links. */
const keepsValue = (c: ColumnRow) => {
  const def = columnTypes.get(c.type);
  return !!def && def.storage === 'cell' && !def.readOnly && !ownWriter(def) && def.engine !== 'links';
};
const isFiles = (c: ColumnRow) => columnTypes.get(c.type)?.engine === 'files';
const DATE_TYPES = new Set(['date', 'timeline']);

type Workdays = {
  weekend: 'fri_sat' | 'sat_sun';
  calendar: Awaited<ReturnType<typeof accountWorkCalendar>>['calendar'];
};

/** Working days from `anchor` to `iso` on the account's calendar (anchor = 0). */
const workdaysAfter = (anchor: string, iso: string, w: Workdays) =>
  countDays(anchor, iso, 'workdays', w.calendar, w.weekend) - dayWeight(anchor, 'workdays', w.calendar, w.weekend);

const sameSet = (x: string[], y: string[]) => x.length === y.length && x.every((v) => y.includes(v));

/**
 * POST /items/{id}/save-as-template — the item and its subitems (every depth), their values, updates (with their
 * files) and file columns (the template's own copies). Suggested variables: see `saveItemAsTemplateSchema`.
 */
export const saveItemAsTemplate = async (deps: Deps, a: Actor, itemId: string, input: SaveItemAsTemplate) => {
  const { db } = deps;
  const { item, access } = await loadItem(db, a, itemId);
  if (item.parentItemId) throw new AppError('bad_request', 'item_templates_from_a_top_item');
  assertBoard(access, 'column.create');
  const board = access.board;
  const sub = await findSubBoard(db, board.id);
  const columnsOf = new Map<string, ColumnRow[]>([[board.id, await listColumns(db, board.id)]]);
  if (sub) columnsOf.set(sub.id, await listColumns(db, sub.id));
  const w = await accountWorkCalendar(db, a.ctx.accountId);

  // The tree, breadth by breadth (children in their order).
  type Raw = { item: ItemRow; children: Raw[] };
  let count = 1;
  const read = async (it: ItemRow): Promise<Raw> => {
    const kids = input.with_subitems ? await childItemsOf(db, [it.id]) : [];
    count += kids.length;
    if (count > ITEM_TEMPLATE_NODES_MAX)
      throw new AppError('validation_failed', 'item_template_too_big', { limit: ITEM_TEMPLATE_NODES_MAX });
    return { item: it, children: await Promise.all(kids.map(read)) };
  };
  const tree = await read(item);
  const all: ItemRow[] = [];
  const flat = (r: Raw) => {
    all.push(r.item);
    r.children.forEach(flat);
  };
  flat(tree);
  const cellsOf = new Map<string, Awaited<ReturnType<typeof itemCells>>>();
  for (const it of all) cellsOf.set(it.id, await itemCells(db, it.id));

  // `start`: the earliest date anywhere in the tree.
  let anchor: string | null = null;
  for (const it of all)
    for (const cell of cellsOf.get(it.id)!) {
      const col = columnsOf.get(it.boardId)?.find((c) => c.id === cell.columnId);
      if (!col || !DATE_TYPES.has(col.type) || !columnAllowed(access, col.restrictedView)) continue;
      const v = cell.value as { date?: string; from?: string } | null;
      const d = v?.date ?? v?.from;
      if (d && (!anchor || d < anchor)) anchor = d;
    }
  const useStart = input.variables.start && !!anchor;
  // `owner`: the item's first people column, wherever the same people are in the tree.
  const peopleCol = columnsOf.get(board.id)!.find((c) => c.type === 'people');
  const peopleOf = (v: unknown) =>
    ((v as { persons_and_teams?: { id: string; kind: string }[] } | null)?.persons_and_teams ?? []).map(
      (p) => `${p.kind}:${p.id}`,
    );
  const ownerSet = peopleCol
    ? peopleOf(cellsOf.get(item.id)!.find((c) => c.columnId === peopleCol.id)?.value ?? null)
    : [];
  const useOwner = input.variables.owner && ownerSet.length > 0;
  // `name`: the item's name, wherever it appears in the tree's names and updates.
  const useName = input.variables.name && item.name.trim().length >= 2;
  const named = (text: string) => (useName ? text.split(item.name).join('{name}') : text);
  const namedDoc = (doc: RichNode): RichNode => ({
    ...doc,
    ...(doc.text !== undefined ? { text: named(doc.text) } : {}),
    ...(doc.content ? { content: doc.content.map(namedDoc) } : {}),
  });

  const copied: string[] = [];
  const keepFiles = async (list: { current: typeof assets.$inferSelect }[]) => {
    const out: ItemTemplateFile[] = [];
    for (const f of list) {
      const c = await copyFile(deps, a, f.current);
      if (c) {
        copied.push(c.asset_id);
        out.push(c);
      }
    }
    return out;
  };

  const nodeOf = async (r: Raw): Promise<ItemTemplateNode> => {
    const it = r.item;
    const cols = columnsOf.get(it.boardId) ?? [];
    const cells: Record<string, ItemTemplateCell> = {};
    for (const col of cols) {
      if (!columnAllowed(access, col.restrictedView)) continue;
      if (isFiles(col)) {
        if (!input.with_files) continue;
        const files = await keepFiles(await cellFileAssets(db, it.id, col.id));
        if (files.length) cells[col.key] = { kind: 'files', files };
        continue;
      }
      if (!keepsValue(col)) continue;
      const cell = cellsOf.get(it.id)!.find((c) => c.columnId === col.id);
      if (!cell || cell.value === null || cell.value === undefined) continue;
      if (useStart && DATE_TYPES.has(col.type)) {
        const v = cell.value as { date?: string; time?: string; from?: string; to?: string };
        const from = v.date ?? v.from;
        if (from) {
          cells[col.key] = {
            kind: 'date',
            var: 'start',
            from: workdaysAfter(anchor!, from, w),
            to: v.to ? workdaysAfter(anchor!, v.to, w) : null,
            time: v.time ? v.time.slice(0, 5) : null,
          };
          continue;
        }
      }
      if (useOwner && col.type === 'people' && sameSet(peopleOf(cell.value), ownerSet)) {
        cells[col.key] = { kind: 'var', var: 'owner' };
        continue;
      }
      if (useName && (col.type === 'text' || col.type === 'long_text')) {
        const text = col.type === 'text' ? String(cell.value) : ((cell.value as { text?: string }).text ?? '');
        if (text.includes(item.name)) {
          cells[col.key] = { kind: 'text', text: named(text) };
          continue;
        }
      }
      cells[col.key] = { kind: 'value', value: cell.value };
    }
    const ups: ItemTemplateUpdate[] = [];
    if (input.with_updates) {
      const rows = await db
        .select()
        .from(updates)
        .where(
          and(
            eq(updates.itemId, it.id),
            isNull(updates.parentUpdateId),
            isNull(updates.deletedAt),
            eq(updates.isSecret, false),
          ),
        )
        .orderBy(asc(updates.createdAt))
        .limit(20);
      for (const u of rows) {
        const files = input.with_files
          ? await keepFiles(
              (
                await db
                  .select({ asset: assets })
                  .from(updateFiles)
                  .innerJoin(assets, eq(assets.id, updateFiles.assetId))
                  .where(and(eq(updateFiles.updateId, u.id), isNull(assets.deletedAt)))
                  .orderBy(asc(updateFiles.position))
              ).map((x) => ({ current: x.asset })),
            )
          : [];
        ups.push({
          text: named(u.bodyText),
          doc: u.bodyJson ? namedDoc(u.bodyJson as unknown as RichNode) : null,
          pinned: u.isPinned,
          files,
        });
      }
    }
    return {
      id: it.id === item.id ? 'root' : it.id,
      name: it.id === item.id && useName ? '{name}' : named(it.name),
      cells,
      updates: ups,
      children: await Promise.all(r.children.map(nodeOf)),
    };
  };
  const root = await nodeOf(tree);
  const variables: ItemTemplateVariable[] = [
    ...(useName ? [{ key: 'name', label: 'שם', type: 'text' as const, required: true, default: null }] : []),
    ...(useStart
      ? [{ key: 'start', label: 'תאריך התחלה', type: 'date' as const, required: true, default: 'today' }]
      : []),
    ...(useOwner ? [{ key: 'owner', label: 'אחראי', type: 'person' as const, required: false, default: null }] : []),
  ];
  const id = newId();
  await db.transaction(async (tx) => {
    await insertItemTemplate(tx, {
      id,
      accountId: a.ctx.accountId,
      boardId: board.id,
      name: input.name,
      category: input.category,
      description: input.description,
      variables: variables as never,
      root: root as never,
      sourceItemId: item.id,
      createdBy: a.user.id,
    });
    await setItemTemplateAssets(tx, a.ctx.accountId, id, copied);
    await templateEvent(tx, a, 'item_template.created', { id, boardId: board.id, name: input.name });
  });
  return dto((await findItemTemplate(db, a.ctx.accountId, id))!);
};

// ---- apply ----

type Answers = { text: Record<string, string>; dates: Record<string, string>; people: Record<string, string[]> };

const answersFor = (
  vars: ItemTemplateVariable[],
  given: ApplyItemTemplate['variables'],
  today: string,
  missingOk = false,
): Answers => {
  const out: Answers = { text: {}, dates: {}, people: {} };
  const missing: string[] = [];
  for (const v of vars) {
    const raw = given[v.key];
    const list = Array.isArray(raw) ? raw : raw !== undefined && raw !== '' ? [raw] : [];
    if (v.type === 'person') {
      if (list.length) out.people[v.key] = list;
      else if (v.required) missing.push(v.key);
      out.text[v.key] = '';
      continue;
    }
    const value = list[0] ?? (v.type === 'date' && v.default === 'today' ? today : (v.default ?? undefined));
    if (value === undefined || value === '') {
      if (v.required) missing.push(v.key);
      continue;
    }
    if (v.type === 'date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
        throw new AppError('validation_failed', 'item_template_bad_date', { key: v.key });
      out.dates[v.key] = value;
    }
    out.text[v.key] = value;
  }
  if (missing.length && !missingOk)
    throw new AppError('validation_failed', 'item_template_missing_variables', { missing });
  return out;
};

/** A template value as the column's input (null = nothing to write). */
const resolveCell = (spec: ItemTemplateCell, col: ColumnRow, ans: Answers, w: Workdays): unknown => {
  const fill = (t: string) => fillItemTemplateText(t, ans.text);
  const asText = (t: string) => (col.type === 'long_text' ? { text: t } : col.type === 'text' ? t : null);
  switch (spec.kind) {
    case 'value':
      return spec.value ?? null;
    case 'text':
      return asText(fill(spec.text));
    case 'date': {
      const base = ans.dates[spec.var];
      if (!base) return null;
      const from = addCountedDays(base, spec.from, 'workdays', w.calendar, w.weekend);
      if (col.type === 'timeline') {
        const to = spec.to === null ? from : addCountedDays(base, spec.to, 'workdays', w.calendar, w.weekend);
        return { from, to: to < from ? from : to };
      }
      if (col.type === 'date') return { date: from, ...(spec.time ? { time: spec.time } : {}) };
      return null;
    }
    case 'var': {
      if (ans.people[spec.var])
        return col.type === 'people'
          ? { persons_and_teams: ans.people[spec.var]!.map((id) => ({ id, kind: 'person' })) }
          : null;
      const date = ans.dates[spec.var];
      if (date) return col.type === 'date' ? { date } : col.type === 'timeline' ? { from: date, to: date } : null;
      const text = ans.text[spec.var];
      return text ? asText(text) : null;
    }
    default:
      return null;
  }
};

/** Words of a rich document with `{variable}` fields filled. */
const fillDoc = (doc: RichNode, values: Record<string, string>): RichNode => ({
  ...doc,
  ...(doc.text !== undefined ? { text: fillItemTemplateText(doc.text, values) } : {}),
  ...(doc.content ? { content: doc.content.map((c) => fillDoc(c, values)) } : {}),
});

/**
 * POST /item-templates/{id}/apply — a new item from the template, or its subitems under an existing item (whose
 * empty cells take the template's values). Files are copied first (storage), then everything is written in one
 * transaction as one batch: undoing it sends the new items to the trash with their subitems.
 */
export type ApplyOptions = {
  /** The batch the apply's events join (an automation's run, a form's submission) — a new one by default. */
  batchId?: string;
  /** A required variable left empty is left empty, not refused (a form's submission is never refused for it). */
  missingOk?: boolean;
  /**
   * A new item's own name and values that win over the template's (a form's answers): cells by column key, as the
   * column stores them. Ignored for subitems under an existing item.
   */
  overrides?: { name?: string; cells?: Record<string, unknown> };
};

export const applyItemTemplate = async (
  deps: Deps,
  a: Actor,
  id: string,
  input: ApplyItemTemplate,
  opts: ApplyOptions = {},
): Promise<ApplyItemTemplateResult> => {
  const { db } = deps;
  const { row, access } = await loadTemplate(db, a, id);
  assertBoard(access, 'item.create');
  const board = access.board;
  const saved = rootOf(row);
  const o = input.parent_item_id ? undefined : opts.overrides;
  const root: ItemTemplateNode = o
    ? {
        ...saved,
        name: o.name ?? saved.name,
        cells: {
          ...saved.cells,
          ...Object.fromEntries(Object.entries(o.cells ?? {}).map(([k, value]) => [k, { kind: 'value', value }])),
        },
      }
    : saved;
  const vars = variablesOf(row);
  const settings = accountSettingsSchema.safeParse((await getAccountSettings(db, a.ctx.accountId)) ?? {});
  const today = dateInZone(new Date(), settings.success ? settings.data.locale.timezone : 'Asia/Jerusalem');
  const ans = answersFor(vars, input.variables, today, opts.missingOk);
  const w = await accountWorkCalendar(db, a.ctx.accountId);
  const skipped: ApplyItemTemplateResult['skipped'] = [];

  // Under an existing item: on this board (or its subitems), with room for the template's depth.
  let parent: ItemRow | null = null;
  if (input.parent_item_id) {
    const loaded = await loadItem(db, a, input.parent_item_id);
    parent = loaded.item;
    const parentTop = loaded.access.board.parentBoardId ?? loaded.access.board.id;
    if (parentTop !== board.id) throw new AppError('bad_request', 'item_template_other_board');
  }
  const { depth } = itemTemplateStats(root);
  const max = effectiveDepthMax(board.hierarchyDepthMax);
  const baseDepth = parent ? parent.depth + 1 : 0;
  const deepest = parent ? baseDepth + depth - 1 : depth;
  if (deepest > max) throw new AppError('depth_exceeded', `This board allows ${max} levels of subitems`, { max });
  const group = parent
    ? null
    : input.group_id
      ? await findGroup(db, board.id, input.group_id)
      : (await listGroups(db, board.id))[0];
  if (!parent && !group) throw new AppError('not_found', 'Group not found');

  // The template's files, copied before the transaction (a storage call), each once.
  const fileCopies = new Map<string, ItemTemplateFile>();
  const wanted = [...new Set(filesOfTree(root).map((f) => f.asset_id))];
  const sources = new Map((await assetsByIds(db, a.ctx.accountId, wanted)).map((r) => [r.id, r]));
  for (const assetId of wanted) {
    const src = sources.get(assetId);
    const copy = src ? await copyFile(deps, a, src) : null;
    if (copy) fileCopies.set(assetId, copy);
    else skipped.push({ column: 'files', reason: 'file_missing' });
  }

  const batchId = opts.batchId ?? newId();
  const created: string[] = [];
  const silent = new Map<string, string>();
  const resultId = await db.transaction(async (tx) => {
    const boardCols = await listColumns(tx, board.id);
    const needSub = parent ? true : root.children.length > 0;
    const sub = needSub ? (board.parentBoardId ? board : await ensureSubBoard(tx, a, board)) : null;
    const subAccess = sub ? await loadBoardAccess(tx, a.ctx, a.user, sub.id) : null;
    const subCols = sub ? await listColumns(tx, sub.id) : [];

    const writeCells = async (
      it: ItemRow,
      node: ItemTemplateNode,
      cols: ColumnRow[],
      acc: BoardAccess,
      onlyEmpty: boolean,
    ) => {
      const existing = onlyEmpty ? new Set((await itemCells(tx, it.id)).map((c) => c.columnId)) : new Set<string>();
      for (const [key, spec] of Object.entries(node.cells)) {
        const col = cols.find((c) => c.key === key);
        if (!col) {
          skipped.push({ column: key, reason: 'column_missing' });
          continue;
        }
        if (existing.has(col.id)) continue;
        if (spec.kind === 'files') {
          const files = spec.files.flatMap((f) => (fileCopies.has(f.asset_id) ? [fileCopies.get(f.asset_id)!] : []));
          if (!files.length || !isFiles(col)) continue;
          if (!columnAllowed(acc, col.restrictedEdit)) {
            skipped.push({ column: key, reason: 'column_restricted' });
            continue;
          }
          await ensureFileCell(tx, a, it.id, it.boardId, col.id);
          await insertCellFiles(
            tx,
            files.map((f, i) => ({
              id: newId(),
              accountId: a.ctx.accountId,
              itemId: it.id,
              columnId: col.id,
              assetId: f.asset_id,
              position: String(i).padStart(6, '0'),
              createdBy: a.user.id,
            })),
          );
          await syncFileCell(tx, a, it.id, it.boardId, col.id);
          continue;
        }
        const value = resolveCell(spec, col, ans, w);
        if (value === null || value === undefined) continue;
        try {
          await writeCell(tx, a, acc, it, col, value, batchId, { via: 'template', template_id: row.id });
        } catch (e) {
          if (!(e instanceof AppError)) throw e;
          skipped.push({ column: key, reason: e.code });
        }
      }
    };

    const writeUpdates = async (it: ItemRow, node: ItemTemplateNode) => {
      for (const u of node.updates) {
        const files = u.files.flatMap((f) => (fileCopies.has(f.asset_id) ? [fileCopies.get(f.asset_id)!] : []));
        const doc = u.doc ? fillDoc(u.doc as RichNode, ans.text) : null;
        const body = doc ? renderRichDoc(doc) : renderUpdateBody(fillItemTemplateText(u.text, ans.text));
        if (!body.text.trim() && !files.length) continue;
        const updateId = newId();
        await insertUpdate(tx, {
          id: updateId,
          accountId: a.ctx.accountId,
          boardId: it.boardId,
          itemId: it.id,
          parentUpdateId: null,
          bodyHtml: body.html,
          bodyText: body.text,
          bodyJson: doc as never,
          isPinned: u.pinned,
          source: 'user',
          createdBy: a.user.id,
        });
        if (files.length)
          await insertUpdateFiles(
            tx,
            files.map((f, i) => ({
              updateId,
              assetId: f.asset_id,
              accountId: a.ctx.accountId,
              position: String(i).padStart(6, '0'),
            })),
          );
      }
    };

    /** One item of the tree (and its subtree) at `at`. */
    const make = async (
      node: ItemTemplateNode,
      at: { boardId: string; groupId: string | null; parent: ItemRow | null; position: string; depth: number },
    ) => {
      const onSub = at.boardId !== board.id;
      const cols = onSub ? subCols : boardCols;
      const itemId = newId();
      const name = initialItemName(cols, fillItemTemplateText(node.name, ans.text).trim() || row.name).name;
      const key = !onSub && (await itemKeyFormat(tx, board.id)) ? await nextItemKeySeq(tx, board.id) : undefined;
      await insertItem(tx, {
        id: itemId,
        accountId: a.ctx.accountId,
        boardId: at.boardId,
        groupId: at.groupId,
        parentItemId: at.parent?.id ?? null,
        rootItemId: at.parent ? (at.parent.rootItemId ?? at.parent.id) : null,
        depth: at.depth,
        position: at.position,
        name: name.slice(0, 255),
        keySeq: key ? Number(key.seq) : null,
        createdBy: a.user.id,
        creatorType: a.automation ? 'automation' : 'user',
      });
      silent.set(
        itemId,
        await recordEvent(tx, {
          accountId: a.ctx.accountId,
          type: 'item.created',
          actorId: a.user.id,
          requestId: a.requestId,
          boardId: at.boardId,
          itemId,
          batchId,
          after: { name, ...(at.groupId ? { group_id: at.groupId } : { parent_item_id: at.parent!.id }) },
          meta: { via: 'template', template_id: row.id, template_version: row.version },
        }),
      );
      await followNewItem(tx, a, itemId);
      created.push(itemId);
      const it = (await findItem(tx, a.ctx.accountId, itemId))!;
      await writeCells(it, node, cols, onSub ? subAccess! : access, false);
      await writeUpdates(it, node);
      let prev: string | null = null;
      for (const child of node.children) {
        prev = rankBetween(prev, null);
        await make(child, { boardId: sub!.id, groupId: null, parent: it, position: prev, depth: at.depth + 1 });
      }
      return itemId;
    };

    const [, changed] = await collectItemChanges(tx, async () => {
      if (!parent) {
        // The rank is read under the group's lock (released with the transaction).
        await tx.execute(sqlLock(group!.id));
        const position =
          input.position === 'top'
            ? rankBetween(null, await firstItemPosition(tx, group!.id))
            : rankBetween(await lastItemPosition(tx, group!.id), null);
        return make(root, { boardId: board.id, groupId: group!.id, parent: null, position, depth: 0 });
      }
      // Under an existing item: its empty cells (a top item: the board's columns), its updates, then the children.
      if (parent.depth === 0) await writeCells(parent, { ...root, children: [] }, boardCols, access, true);
      await writeUpdates(parent, root);
      const siblings = await childItemsOf(tx, [parent.id]);
      let prev: string | null = siblings.length ? siblings[siblings.length - 1]!.position : null;
      for (const child of root.children) {
        prev = rankBetween(prev, null);
        await make(child, { boardId: sub!.id, groupId: null, parent, position: prev, depth: parent.depth + 1 });
      }
      return parent.id;
    });
    await itemsChanged(tx, nameWho(a), [...created, ...(parent ? [parent.id] : []), ...changed], { silent });
    return parent?.id ?? created[0]!;
  });
  return { item_id: resultId, created: created.length, batch_id: batchId, skipped };
};

/** The group's append lock (as `createItem`): two appends at once never tie on the last rank. */
const sqlLock = (groupId: string) => sql`select pg_advisory_xact_lock(hashtext(${groupId}))`;
