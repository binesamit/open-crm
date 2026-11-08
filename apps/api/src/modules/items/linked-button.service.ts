// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  cellFromText,
  convertCellValue,
  popupRequired,
  popupSubitemsRule,
  renderTemplate,
  subitemsPass,
  type ButtonClick,
  type ButtonLinked,
  type CreateLinkedAction,
  type Region,
  type TextPerson,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { type BoardAccess, assertBoard, columnAllowed, loadBoardAccess } from '../boards/boards.access';
import { listColumns, type ColumnRow } from '../boards/boards.repo';
import { findItem, itemCells, type ItemRow } from './items.repo';
import { type Actor, calculatorFor, createItem, itemDto, writeCell } from './items.service';
import { subitemsTally, writePopupSubitems } from './popup-subitems';
import { linkSources, linkTargets } from './relations.repo';
import { plainTextDoc } from './workflow';
import { createUpdate } from '../updates/updates.service';

/**
 * P1-03 — a button that creates a linked item: an item on another board, linked to the clicked one
 * with values copied from it, fixed values and the popup's answers — or, when `reuse` finds a linked item that is
 * still open (e.g. a job in "draft"), the popup's answers go to that one. One transaction, one batch.
 */

type Target = { access: BoardAccess; columns: ColumnRow[]; link: ColumnRow };

const resolveTarget = async (tx: Db, a: Actor, sourceColumns: ColumnRow[], act: CreateLinkedAction) => {
  if (!act.board_id || !act.link) throw new AppError('validation_failed', 'create_linked_not_set');
  const access = await loadBoardAccess(tx, a.ctx, a.user, act.board_id);
  assertBoard(access, 'item.read');
  if (access.board.parentBoardId) throw new AppError('validation_failed', 'create_linked_not_set');
  const columns = await listColumns(tx, act.board_id);
  const link = (act.link.on === 'source' ? sourceColumns : columns).find((c) => c.key === act.link!.column_id);
  if (!link || link.type !== 'board_relation') throw new AppError('validation_failed', 'create_linked_no_link');
  return { access, columns, link } satisfies Target;
};

/** The target-board items linked to the clicked item through the action's relation (either side). */
const linkedItems = async (tx: Db, a: Actor, item: ItemRow, act: CreateLinkedAction, t: Target) => {
  const ids =
    act.link!.on === 'source' ? await linkTargets(tx, t.link.id, item.id) : await linkSources(tx, t.link.id, item.id);
  const rows = await Promise.all([...new Set(ids)].map((id) => findItem(tx, a.ctx.accountId, id)));
  return rows.filter((r): r is ItemRow => !!r && r.boardId === t.access.board.id && !r.archivedAt && !r.parentItemId);
};

/** The linked item `reuse` points at (the newest one that matches), if any. */
const reusable = async (tx: Db, a: Actor, item: ItemRow, act: CreateLinkedAction, t: Target) => {
  const r = act.reuse;
  if (!r) return null;
  const status = t.columns.find((c) => c.key === r.column_id);
  if (!status) return null;
  const linked = await linkedItems(tx, a, item, act, t);
  const matches: ItemRow[] = [];
  for (const row of linked) {
    const cell = (await itemCells(tx, row.id)).find((c) => c.columnId === status.id);
    const index = (cell?.value as { index?: number } | null | undefined)?.index;
    if (index === undefined || index === null ? r.empty : r.labels.includes(index)) matches.push(row);
  }
  // ULIDs sort by creation: the newest first.
  return matches.sort((x, y) => (x.id < y.id ? 1 : -1))[0] ?? null;
};

/**
 * A new linked item's values before the popup: copied from the clicked item (as the clicker sees it — S-36: only
 * visible columns) and the fixed ones, with their texts (the popup shows them) and the name copied to it.
 */
const presetCells = async (
  tx: Db,
  a: Actor,
  x: {
    item: ItemRow;
    access: BoardAccess;
    columns: ColumnRow[];
    act: CreateLinkedAction;
    people: TextPerson[];
    region: Region;
    t: Target;
  },
) => {
  const { item, act, t } = x;
  const calc = await calculatorFor(tx, a, [item.id]);
  const visible = x.columns.filter((c) => columnAllowed(x.access, c.restrictedView));
  const dto = itemDto(calc, item, visible);
  const lookup = (path: string) => {
    const [root, key] = path.split('.', 2);
    if (root !== 'item') return path === 'board.id' ? item.boardId : undefined;
    return key === 'name' ? item.name : key === 'id' ? item.id : key ? (dto.cells[key]?.text ?? '') : undefined;
  };
  const cells: Record<string, unknown> = {};
  const texts: Record<string, string> = {};
  // A relation copied as is keeps its linked items' names (the popup shows them as chips).
  const names: Record<string, string[]> = {};
  let name: string | undefined;
  for (const c of act.copy) {
    const text = c.from === 'name' ? item.name : (dto.cells[c.from]?.text ?? '');
    if (c.to === 'name') {
      name = text.trim() || name;
      continue;
    }
    const to = t.columns.find((col) => col.key === c.to);
    if (!to || to.id === t.link.id) continue;
    let value: unknown;
    if (c.from === 'name') value = cellFromText(to.type, item.name, to.settings, x.people, { region: x.region });
    else {
      const from = visible.find((col) => col.key === c.from);
      const cell = from ? dto.cells[from.key] : undefined;
      if (!from || cell?.value === null || cell?.value === undefined) continue;
      value = convertCellValue({ type: from.type, value: cell.value, text: cell.text ?? '' }, to, x.people);
      if (from.type === to.type && cell.names) names[to.key] = cell.names;
    }
    if (value !== undefined && value !== null) {
      cells[to.key] = value;
      texts[to.key] = text;
    }
  }
  for (const f of act.fixed) {
    const to = t.columns.find((col) => col.key === f.column_id);
    if (!to || to.id === t.link.id) continue;
    const text = renderTemplate(f.text, lookup).text;
    const value = text.trim() ? cellFromText(to.type, text, to.settings, x.people, { region: x.region }) : null;
    if (value !== undefined && value !== null) {
      cells[to.key] = value;
      texts[to.key] = text.trim();
    }
  }
  return { cells, texts, names, name };
};

/**
 * GET …/buttons/{column}/linked: the item the popup should open on (null = a new one), and a new one's values from
 * the copy and fixed settings (the popup shows them; the click writes them again on the server).
 */
export const linkedPreview = async (
  tx: Db,
  a: Actor,
  x: {
    item: ItemRow;
    access: BoardAccess;
    columns: ColumnRow[];
    act: CreateLinkedAction;
    people: TextPerson[];
    region: Region;
  },
) => {
  const t = await resolveTarget(tx, a, x.columns, x.act);
  const open = await reusable(tx, a, x.item, x.act, t);
  if (open) return { item_id: open.id, cells: {} };
  const { cells, texts, names } = await presetCells(tx, a, { ...x, t });
  return {
    item_id: null,
    cells: Object.fromEntries(
      Object.entries(cells).map(([k, value]) => [
        k,
        { value, text: texts[k] ?? null, ...(names[k] ? { names: names[k] } : {}) },
      ]),
    ),
  };
};

export const runCreateLinked = async (
  tx: Db,
  a: Actor,
  x: {
    item: ItemRow;
    access: BoardAccess;
    columns: ColumnRow[];
    buttonKey: string;
    act: CreateLinkedAction;
    answers: ButtonClick;
    batchId: string;
    people: TextPerson[];
    region: Region;
  },
): Promise<ButtonLinked> => {
  const { item, act, answers, batchId } = x;
  const t = await resolveTarget(tx, a, x.columns, act);
  const popup = act.popup;
  const allowed = new Set(popup.fields.map((f) => f.column_id));
  const answerCells = Object.entries(answers.cells ?? {});
  for (const [key] of answerCells) {
    const col = t.columns.find((c) => c.key === key);
    if (!allowed.has(key) || !col || col.id === t.link.id)
      throw new AppError('invalid_value', `popup_field_unknown:${key}`);
  }
  if (answers.subitems && !popup.subitems) throw new AppError('invalid_value', 'popup_field_unknown:subitems');

  let target: ItemRow;
  let created = false;
  if (answers.target_item_id) {
    // Only the linked item `reuse` points at may be filled in this way.
    const open = await reusable(tx, a, item, act, t);
    if (!open || open.id !== answers.target_item_id) throw new AppError('conflict', 'create_linked_target_changed');
    assertBoard(t.access, 'item.update');
    target = open;
    for (const [key, value] of answerCells) {
      await writeCell(
        tx,
        a,
        t.access,
        target,
        t.columns.find((c) => c.key === key)!,
        value ?? null,
        batchId,
        {
          button: x.buttonKey,
        },
      );
    }
  } else {
    assertBoard(t.access, 'item.create');
    const { cells, name } = await presetCells(tx, a, { ...x, t });
    for (const [key, value] of answerCells) {
      if (value === null || value === undefined) delete cells[key];
      else cells[key] = value;
    }
    if (act.link!.on === 'target') cells[t.link.key] = { item_ids: [item.id] };
    const dtoNew = await createItem(
      tx,
      a,
      t.access.board.id,
      { name: name ?? item.name, cells },
      { batchId, via: 'popup' },
    );
    target = (await findItem(tx, a.ctx.accountId, dtoNew.id))!;
    created = true;
    if (act.link!.on === 'source') {
      const current = await linkTargets(tx, t.link.id, item.id);
      const multiple = (t.link.settings as { allow_multiple?: boolean } | null)?.allow_multiple !== false;
      await writeCell(
        tx,
        a,
        x.access,
        item,
        t.link,
        { item_ids: multiple ? [...current, target.id] : [target.id] },
        batchId,
        { button: x.buttonKey },
      );
    }
  }

  // The popup's subitems (of the target board's subitems board), then its rules — on the item made / filled in.
  const subFields = new Set(['name', ...(popup.subitems?.fields ?? []).map((f) => f.column_id)]);
  await writePopupSubitems(tx, a, t.access, target, answers.subitems, batchId, subFields);
  const subRule = popupSubitemsRule(popup);
  if (subRule) {
    const tally = await subitemsTally(tx, a, target, subRule);
    if (!subitemsPass(subRule, tally))
      throw new AppError('validation_failed', 'popup_subitems', {
        min: subRule.min,
        have: tally.complete,
        incomplete: tally.incomplete,
        all: !!subRule.all,
      });
  }
  const now = await itemCells(tx, target.id);
  const missing = popupRequired(popup).filter((key) => {
    const col = t.columns.find((c) => c.key === key);
    return !!col && !now.some((c) => c.columnId === col.id && c.value !== null);
  });
  if (missing.length)
    throw new AppError('validation_failed', 'popup_required', {
      columns: missing.map((k) => ({ id: k, title: t.columns.find((c) => c.key === k)?.title ?? k })),
    });
  if (popup.note === 'required' && !answers.note) throw new AppError('validation_failed', 'popup_note_required');
  if (answers.note && (popup.note ?? 'off') !== 'off')
    await createUpdate(tx, a, target.id, { doc: plainTextDoc(answers.note) });
  const fresh = (await findItem(tx, a.ctx.accountId, target.id))!;
  return { item_id: fresh.id, board_id: fresh.boardId, name: fresh.name, created };
};
