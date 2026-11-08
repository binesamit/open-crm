// SPDX-License-Identifier: AGPL-3.0-only
import type { RelationPickerGrouping } from '@bines/shared';

export type PickerHit = { id: string; name: string; board_id: string; group_id?: string | null };
type PickerGroup = { id: string; title: string; color: string };
export type PickerBoard = { id: string; name: string; groups: PickerGroup[] };
/** A run of the picker's list: a board's name above it (its first run), a group's title (board_group). */
export type PickerSection = { key: string; board?: PickerBoard; group?: PickerGroup; hits: PickerHit[] };

/**
 * Prod (product owner: several boards in one relation column): the picker's items under their board's name, in the
 * column's board order, and under the board's groups in the board's order (the column's `picker_group_by`). Items
 * of no listed board (a linked item beyond the first page) come first, without a title; items of a group the board
 * no longer has come last in their board. One board shown: no board title (the chips above already say which).
 */
export const pickerSections = (
  hits: PickerHit[],
  boards: PickerBoard[],
  mode: RelationPickerGrouping,
): PickerSection[] => {
  if (mode === 'none') return hits.length ? [{ key: 'all', hits }] : [];
  const listed = new Set(boards.map((b) => b.id));
  const out: PickerSection[] = [];
  const loose = hits.filter((h) => !listed.has(h.board_id));
  if (loose.length) out.push({ key: 'loose', hits: loose });
  const titled = boards.length > 1;
  for (const b of boards) {
    const own = hits.filter((h) => h.board_id === b.id);
    if (!own.length) continue;
    const runs: PickerSection[] = [];
    if (mode === 'board') runs.push({ key: b.id, hits: own });
    else {
      const known = new Set(b.groups.map((g) => g.id));
      for (const g of b.groups) {
        const inGroup = own.filter((h) => h.group_id === g.id);
        if (inGroup.length) runs.push({ key: `${b.id}:${g.id}`, group: g, hits: inGroup });
      }
      const other = own.filter((h) => !h.group_id || !known.has(h.group_id));
      if (other.length) runs.push({ key: `${b.id}:-`, hits: other });
    }
    if (titled) runs[0] = { ...runs[0]!, board: b };
    out.push(...runs);
  }
  return out;
};
