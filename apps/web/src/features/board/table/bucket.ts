// SPDX-License-Identifier: AGPL-3.0-only
import { createContext, useSyncExternalStore } from 'react';
import { EMPTY_BUCKET, GROUP_PALETTE, paint } from '@bines/shared';
import type { MenuEntry } from '@bines/ui';
import type { Column, Item, Member, Tag, Team } from '../board-api';
import type { Section } from './BoardTable';
import type { Dragged } from './row-dnd';

/**
 * Fix: — the view is grouped by a column (`columnId`; `__group__` = by the board's group): a row dropped in
 * another section takes its value (`set`), or its group (`place`); in its own section it moves within its group.
 * Fix: b: the row menu's / batch bar's "move to group" goes through the same rules (`bucketMoveEntries`).
 */
export type BucketDrag = {
  columnId: string;
  /** The grouping column (null: a system field). */
  column: Column | null;
  /** The view sorts: rows keep the sort's order, so only a change of section is a move. */
  sorted: boolean;
  canMove: boolean;
  canEdit: boolean;
  place: (v: { itemId: string; groupId: string; afterId: string | null; beforeId: string | null }) => void;
  /** Writes the value (`gesture`: the writes of one menu choice for several items are one Ctrl+Z). */
  set: (item: Item, value: unknown, to: Section, gesture?: string) => void;
  /** The view's sections, in order. */
  sections: Section[];
  /**
   * Fix: — where "move to group" can send items: every value the column can hold (all status / dropdown
   * labels, every member and team, every tag, checked / empty), not only the sections shown now. Defaults to
   * `sections`.
   */
  targets?: Section[];
};
export const BucketDragContext = createContext<BucketDrag | null>(null);

/** Date sections are ranges (this week, next month…): no one date to set, so no drop there. */
const RANGE_TYPES = new Set(['date', 'timeline']);
/** Columns holding several values: the item leaves the section it came from and joins the target one. */
const MULTI_KEY: Record<string, string> = { dropdown: 'ids', people: 'persons_and_teams', tags: 'tag_ids' };

/**
 * The grouping column's new value when `item` goes from section `from` to `to` (like a Kanban lane change);
 * undefined = it cannot be set there (computed / read-only columns, date ranges, system fields). The empty section
 * clears the value.
 */
const bucketValue = (b: BucketDrag, item: Item, from: string, to: Section): unknown => {
  const col = b.column;
  if (!col || !b.canEdit || col.read_only || col.restricted_edit || RANGE_TYPES.has(col.type) || !to.seed) {
    return undefined;
  }
  const toKey = to.bucket ?? to.key.slice(b.columnId.length + 1);
  if (toKey === EMPTY_BUCKET) return null;
  const seeded = to.seed.cells[col.id] as Record<string, unknown> | undefined;
  if (seeded === undefined) return undefined;
  const multi = MULTI_KEY[col.type];
  // A combination's section (ק2: "דחוף + לקוח") takes its whole value.
  if (!multi || toKey.startsWith('combo:')) return seeded;
  const fromKey = b.sections.find((s) => s.key === from)?.bucket ?? from.slice(b.columnId.length + 1);
  const current = (item.cells[col.id]?.value ?? {}) as Record<string, unknown>;
  const added = (seeded[multi] as unknown[])[0];
  const idOf = (v: unknown) => String(typeof v === 'object' && v ? (v as { id: string }).id : v);
  const kept = ((current[multi] as unknown[] | undefined) ?? []).filter(
    (v) => idOf(v) !== fromKey && idOf(v) !== idOf(added),
  );
  return { ...current, [multi]: [...kept, added] };
};

/**
 * What dropping `d` on section `to` does — beside a row of it (`anchor`) or at its end — or null when it cannot
 * land there. In its own section (or grouped by the board's group) it is a move within a group, else a value change.
 */
export const bucketDropOf = (
  b: BucketDrag,
  d: Dragged,
  to: Section,
  anchor: { id: string; before: boolean } | null,
): (() => void) | null => {
  const item = d.item;
  if (d.isSub || !item || !d.bucket) return null;
  const same = d.bucket === to.key;
  if (same || b.columnId === '__group__') {
    if ((same && b.sorted) || !b.canMove) return null;
    const groupId = same ? item.group_id : to.seed?.groupId;
    if (!groupId) return null;
    const list = to.items.filter((i) => i.group_id === groupId);
    const rest = list.filter((i) => i.id !== item.id);
    const nothing = () => undefined;
    if (!anchor) {
      if (same && list.at(-1)?.id === item.id) return nothing; // already last
      const afterId = rest.at(-1)?.id ?? null;
      return () => b.place({ itemId: item.id, groupId, afterId, beforeId: null });
    }
    const at = rest.findIndex((i) => i.id === anchor.id);
    // Beside a row of another group in the same section: the row would not end up there.
    if (at < 0) return null;
    if (same) {
      const cur = list.findIndex((i) => i.id === item.id);
      const target = list.findIndex((i) => i.id === anchor.id);
      if (target === (anchor.before ? cur + 1 : cur - 1)) return nothing; // dropped right beside itself
    }
    const afterId = anchor.before ? (rest[at - 1]?.id ?? null) : anchor.id;
    const beforeId = anchor.before ? anchor.id : (rest[at + 1]?.id ?? null);
    return () => b.place({ itemId: item.id, groupId, afterId, beforeId });
  }
  const value = bucketValue(b, item, d.bucket, to);
  return value === undefined ? null : () => b.set(item, value, to);
};

/**
 * Fix: b — the grouping column can be set from a menu: a real column, editable by me, whose sections are
 * single values (not date ranges / computed / read-only / system fields). Otherwise "move to group" stays the
 * board's groups.
 */
const settable = (b: BucketDrag) => {
  const col = b.column;
  return !!col && b.canEdit && !col.read_only && !col.restricted_edit && !RANGE_TYPES.has(col.type);
};

/**
 * Fix: b — the row menu's "move to group" in a view grouped by a column: the other sections the item can go
 * to from `from` (the section of the row that was clicked), each setting the column's value exactly like dropping
 * the row there (same rules; Ctrl+Z undoes it). Null = not grouped by a settable column (the board's groups).
 */
export const bucketMoveEntries = (b: BucketDrag | null, item: Item, from: string | undefined): MenuEntry[] | null => {
  if (!b || !from || !settable(b) || item.parent_item_id) return null;
  return (b.targets ?? b.sections).flatMap((s): MenuEntry[] => {
    if (s.key === from) return [];
    const value = bucketValue(b, item, from, s);
    return value === undefined
      ? []
      : [{ label: s.title, onSelect: () => b.set(item, value, s), testId: 'move-section' }];
  });
};

/**
 * The same for several selected items (the batch menu / bar): each leaves the first section it shows in and joins
 * the chosen one; one Ctrl+Z undoes them all. Items already only in that section stay as they are.
 */
const bucketBatchEntries = (b: BucketDrag, ids: string[]): MenuEntry[] => {
  const picked = new Set(ids);
  return (b.targets ?? b.sections).map((s) => ({
    label: s.title,
    testId: 'move-section',
    onSelect: () => {
      const gesture = `bucket:${s.key}:${ids.length}:${Math.random().toString(36).slice(2)}`;
      const seen = new Set<string>();
      for (const from of b.sections) {
        if (from.key === s.key) continue;
        for (const item of from.items) {
          if (!picked.has(item.id) || seen.has(item.id)) continue;
          seen.add(item.id);
          const value = bucketValue(b, item, from.key, s);
          if (value !== undefined) b.set(item, value, s, gesture);
        }
      }
    },
  }));
};

const BUCKET_COLORS = GROUP_PALETTE.map((k) => paint(k));
type Label = { id: number | string; label: string; color?: string; is_deactivated?: boolean };

/**
 * Fix: — every section a grouping column could have, in the column's own order: the sections shown now
 * keep their place in it (their items, title, colour); values no item holds yet become empty sections that set
 * that value (a status label, a dropdown option, a member or team, a tag, "checked"); the empty section last.
 * Columns whose values cannot be listed (numbers, text, dates) keep just the sections shown.
 */
export const bucketTargets = (
  sections: Section[],
  column: Column | null,
  opts: {
    groupId: string | undefined;
    members: Member[];
    teams: Team[];
    tags: Tag[];
    emptyLabel: string;
    checkedLabel: string;
  },
): Section[] => {
  if (!column || !opts.groupId) return sections;
  const groupId = opts.groupId;
  const byKey = new Map(sections.map((s) => [s.key, s]));
  const values: { key: string; title: string; color?: string; cell: unknown }[] = [];
  // Labels without text (blank slots) are not offered unless an item already holds one (shown sections).
  const labels = ((column.settings.labels as Label[] | undefined) ?? []).filter(
    (l) => l && !l.is_deactivated && l.label?.trim(),
  );
  switch (column.type) {
    case 'status':
      for (const l of labels)
        values.push({ key: String(l.id), title: l.label, color: l.color, cell: { index: Number(l.id) } });
      break;
    case 'dropdown':
      for (const l of labels)
        values.push({ key: String(l.id), title: l.label, color: l.color, cell: { ids: [Number(l.id)] } });
      break;
    case 'people':
      for (const m of opts.members)
        if (m.status === 'active')
          values.push({
            key: m.user_id,
            title: m.name || m.email,
            cell: { persons_and_teams: [{ id: m.user_id, kind: 'person' }] },
          });
      for (const x of opts.teams)
        values.push({ key: x.id, title: x.name, cell: { persons_and_teams: [{ id: x.id, kind: 'team' }] } });
      break;
    case 'tags':
      for (const x of opts.tags) values.push({ key: x.id, title: `#${x.name}`, cell: { tag_ids: [x.id] } });
      break;
    case 'checkbox':
      values.push({ key: 'checked', title: opts.checkedLabel, cell: { checked: true } });
      break;
    default:
      return sections;
  }
  const out: Section[] = [];
  const used = new Set<string>();
  values.forEach((v, i) => {
    const key = `${column.id}:${v.key}`;
    used.add(key);
    out.push(
      byKey.get(key) ?? {
        key,
        title: v.title,
        color: paint(v.color) ?? BUCKET_COLORS[i % BUCKET_COLORS.length]!,
        items: [],
        seed: { groupId, cells: { [column.id]: v.cell } },
      },
    );
  });
  const emptyKey = `${column.id}:${EMPTY_BUCKET}`;
  // Shown values the list does not hold (a deactivated label, a former member) stay where they are.
  for (const s of sections) if (!used.has(s.key) && s.key !== emptyKey) out.push(s);
  out.push(
    byKey.get(emptyKey) ?? {
      key: emptyKey,
      title: opts.emptyLabel,
      color: 'var(--status-empty)',
      items: [],
      seed: { groupId, cells: {} },
    },
  );
  return out;
};

/*
 * The batch bar lives outside the table (BoardPage), so the table publishes its grouping per board here and the
 * bar reads it with `useBucketBatchMove(boardId)`.
 */
const published = new Map<string, BucketDrag>();
const listeners = new Set<() => void>();
export const publishBucketDrag = (boardId: string, b: BucketDrag | null) => {
  if ((published.get(boardId) ?? null) === b) return;
  if (b) published.set(boardId, b);
  else published.delete(boardId);
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/**
 * For the batch bar and its right-click menu: when the table is grouped by a settable column, the sections to move
 * the selected items to (setting the value, like the row menu); null = the board's groups as before.
 */
export const useBucketBatchMove = (boardId: string): ((ids: string[]) => MenuEntry[]) | null => {
  const b = useSyncExternalStore(subscribe, () => published.get(boardId) ?? null);
  return b && settable(b) ? (ids) => bucketBatchEntries(b, ids) : null;
};
