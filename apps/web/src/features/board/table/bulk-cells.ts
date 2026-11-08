// SPDX-License-Identifier: AGPL-3.0-only
import { columnTypes, ownWriter, t } from '@bines/shared';
import type { Column, Item } from '../board-api';
import type { Selection } from '../selection';

/**
 * Round 12 (product decision): with several items (or subitems) checked, editing a cell of one of the checked
 * rows sets that column on ALL the checked rows — one request to the bulk endpoint (`set_cell`): one batch, one
 * undo, the server checks the permission per item (the ones not allowed are skipped and counted). While the
 * pointer is on a cell of a checked row, the same column's cells of every checked row are highlighted, and the
 * hovered cell says how many items the edit applies to.
 */

/** A column the bulk endpoint can set (the batch bar's "set value" uses the same rule). */
export const bulkSettable = (c: Column) => {
  const def = columnTypes.get(c.type);
  return !c.read_only && c.type !== 'name' && def?.storage === 'cell' && !ownWriter(def) && def.engine !== 'links';
};

/**
 * a relation column on several checked rows — a picker toggle links / unlinks that item on every
 * checked row (the bulk `change_links`), a paste / clear sets the whole value (`set_cell`).
 */
export const bulkLinks = (c: Column) => !c.read_only && c.type === 'board_relation';

type LinkIds = { item_ids?: string[] } | null | undefined;
const idsOf = (v: unknown) => (v as LinkIds)?.item_ids ?? [];

/** What one picker change did to a row's links. */
export const linkDelta = (before: unknown, after: unknown) => {
  const was = idsOf(before);
  const now = idsOf(after);
  return { add: now.filter((id) => !was.includes(id)), remove: was.filter((id) => !now.includes(id)) };
};

/** Another row's links after the same change (as the server does it: a single-link column replaces). */
export const withLinkDelta = (current: unknown, d: { add: string[]; remove: string[] }, allowMultiple?: unknown) => {
  const kept = idsOf(current).filter((id) => !d.remove.includes(id));
  const next = allowMultiple === false && d.add.length ? [d.add[0]!] : [...new Set([...kept, ...d.add])];
  return next.length ? { item_ids: next } : null;
};

/** The items an edit of `itemId`'s cell applies to: every checked row when it is one of 2+ checked; else none. */
export const bulkTargets = (selection: Pick<Selection, 'ids' | 'has'> | null | undefined, itemId: string) =>
  selection && selection.ids.length > 1 && selection.has(itemId) ? selection.ids : null;

/** The optimistic copy of an item after the batch set its cell (the server's answer replaces it). */
export const withCell = (item: Item, columnId: string, value: unknown): Item => {
  const cells = { ...item.cells };
  if (value === null) delete cells[columnId];
  else cells[columnId] = { ...(cells[columnId] ?? { text: null }), value } as Item['cells'][string];
  return { ...item, cells };
};

export const bulkHint = (n: number) => t('r12.bulk.hint', { n });

const STYLE_ID = 'bulk-hover-style';

/**
 * The highlight of a column across the checked rows: one rule in a <style> element (no row re-renders while the
 * pointer moves over a big table). Rows carry `data-bulk-board` + `data-selected`; cells `data-column`.
 */
export const bulkHoverRule = (boardId: string, columnId: string) => {
  const esc = (s: string) => s.replace(/["\\]/g, '\\$&');
  return (
    `[data-bulk-board="${esc(boardId)}"][data-selected] > [data-column="${esc(columnId)}"]` +
    '{background-color:color-mix(in srgb,var(--primary) 14%,var(--surface))!important;' +
    'box-shadow:inset 0 0 0 1.5px color-mix(in srgb,var(--primary) 60%,transparent)}'
  );
};

export const setBulkHover = (boardId: string | null, columnId?: string) => {
  if (typeof document === 'undefined') return;
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!boardId || !columnId) {
    if (el) el.textContent = '';
    document.documentElement.removeAttribute('data-bulk-hover');
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = bulkHoverRule(boardId, columnId);
  // For tests: which column is lit.
  document.documentElement.setAttribute('data-bulk-hover', columnId);
};
