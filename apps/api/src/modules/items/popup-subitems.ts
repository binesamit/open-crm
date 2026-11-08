// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  evaluateConditions,
  flattenRules,
  type PopupSubitemsWrite,
  type SubitemsRule,
  type SubitemsTally,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { accountEnv, queryEnvOf } from '../automations/engine/context';
import { type BoardAccess, loadBoardAccess } from '../boards/boards.access';
import { listColumns } from '../boards/boards.repo';
import { cellsByItemIds, childItemsOf, type ItemRow } from './items.repo';
import { type Actor, calculatorFor, itemDto, writeCell } from './items.service';
import { createSubitemTx } from './subitems.service';

/**
 * a popup's subitems: new subitems of the item and values filled in on the ones it has, written in the
 * popup's transaction and batch (one Ctrl+Z), before its action (a workflow move, a button) is checked. `allowed`
 * limits the sub-board columns (a button's popup takes its own columns only); 'name' is the subitem's name.
 */
export const writePopupSubitems = async (
  tx: Db,
  a: Actor,
  access: BoardAccess,
  item: ItemRow,
  input: PopupSubitemsWrite | undefined,
  batchId: string,
  allowed?: Set<string>,
) => {
  if (!input?.create?.length && !input?.update?.length) return;
  const check = (key: string) => {
    if (allowed && !allowed.has(key)) throw new AppError('invalid_value', `popup_field_unknown:${key}`);
  };
  if (input.update?.length) {
    const children = await childItemsOf(tx, [item.id]);
    const subBoardId = children[0]?.boardId;
    const subAccess = subBoardId ? await loadBoardAccess(tx, a.ctx, a.user, subBoardId) : null;
    const columns = subBoardId ? await listColumns(tx, subBoardId) : [];
    for (const u of input.update) {
      // Only the item's own subitems, one level down.
      const child = children.find((c) => c.id === u.id && !c.archivedAt);
      if (!child || !subAccess) throw new AppError('not_found', 'Subitem not found');
      for (const [key, value] of Object.entries(u.cells)) {
        check(key);
        const target = columns.find((c) => c.key === key);
        if (!target) throw new AppError('not_found', `Column "${key}" not found`);
        await writeCell(tx, a, subAccess, child, target, value ?? null, batchId);
      }
    }
  }
  for (const c of input.create ?? []) {
    for (const key of Object.keys(c.cells ?? {})) check(key);
    if (c.name) check('name');
    // Empty values are not written (a row left blank in a column).
    const cells = Object.fromEntries(Object.entries(c.cells ?? {}).filter(([, v]) => v !== null && v !== undefined));
    await createSubitemTx(tx, a, access, item, { name: c.name, cells }, batchId, 'popup');
  }
};

/**
 * How the item's subitems (one level down, not archived) stand against a rule: those that count (match its
 * conditions) with and without every required value, and — round 2 — those that do not meet its `each` conditions
 * (not complete either). Conditions are read on the sub-board's computed values.
 */
export const subitemsTally = async (tx: Db, a: Actor, item: ItemRow, rule: SubitemsRule): Promise<SubitemsTally> => {
  const children = (await childItemsOf(tx, [item.id])).filter((c) => !c.archivedAt);
  if (!children.length) return { complete: 0, incomplete: 0 };
  const columns = await listColumns(tx, children[0]!.boardId);
  const counts = rule.conditions && flattenRules(rule.conditions).length ? rule.conditions : undefined;
  const each = rule.each && flattenRules(rule.each).length ? rule.each : undefined;
  let counted = children;
  let failing = new Set<string>();
  if (counts || each) {
    const calc = await calculatorFor(
      tx,
      a,
      children.map((c) => c.id),
      children,
    );
    const env = await queryEnvOf(tx, a.ctx.accountId, columns, await accountEnv(tx, a.ctx.accountId));
    const meets = (g: NonNullable<SubitemsRule['conditions']>, c: ItemRow) => {
      try {
        return evaluateConditions(g, itemDto(calc, c, columns), env).matched;
      } catch {
        // A rule on a column that is gone does not block the board.
        return true;
      }
    };
    if (counts) counted = children.filter((c) => meets(counts, c));
    if (each) failing = new Set(counted.filter((c) => !meets(each, c)).map((c) => c.id));
  }
  const cells = await cellsByItemIds(
    tx,
    counted.map((c) => c.id),
  );
  const keyOf = new Map(columns.map((c) => [c.id, c.key]));
  const filled = new Map<string, Set<string>>();
  for (const cell of cells)
    if (cell.value !== null) {
      const key = keyOf.get(cell.columnId);
      if (key) filled.set(cell.itemId, (filled.get(cell.itemId) ?? new Set()).add(key));
    }
  let complete = 0;
  for (const c of counted)
    if (!failing.has(c.id) && rule.required.every((k) => (k === 'name' ? !!c.name.trim() : !!filled.get(c.id)?.has(k))))
      complete++;
  return { complete, incomplete: counted.length - complete, ...(failing.size ? { failing: failing.size } : {}) };
};
