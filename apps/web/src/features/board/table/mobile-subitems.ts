// SPDX-License-Identifier: AGPL-3.0-only
import type { Item } from '../board-api';

/**
 * Round 16 (r16mobsub, product owner: "subitems must also show in this view, not only through the item's side panel"):
 * the rows a phone shows under an open item — the same order as the desktop table (D14): the sub-board's header,
 * each subitem (an open one followed by its own subitems, one level further in), then "+ add subitem".
 *
 * `childrenOf` and `expanded` come from the board's `SubitemsContext`, so the view's filter (which subitems match,
 * which parents a filter opens) and its subitem sort are already applied — one source for desktop and phone.
 */
export type MobileSubRow =
  | { kind: 'head'; parent: Item; depth: number }
  | { kind: 'item'; item: Item; depth: number }
  | { kind: 'add'; parent: Item; depth: number };

/** Whether a subitem can be added under `item`: a sub-board, room under the board's depth limit, and permission. */
export const canNestUnder = (item: Pick<Item, 'depth'>, depthMax: number | undefined, canCreate: boolean) =>
  canCreate && depthMax !== undefined && item.depth + 1 <= depthMax;

export const subtreeRows = (
  parent: Item,
  childrenOf: ReadonlyMap<string, Item[]>,
  expanded: ReadonlySet<string>,
  opts: {
    /** The root board's `hierarchy_depth_max` — the server checks every level against it (undefined: no "add"). */
    depthMax: number | undefined;
    canCreate: boolean;
    /** The cards layout's compact list has no header row. */
    head?: boolean;
  },
  depth = 1,
): MobileSubRow[] => {
  const rows: MobileSubRow[] = [];
  const walk = (p: Item, d: number, seen: Set<string>) => {
    if (opts.head !== false) rows.push({ kind: 'head', parent: p, depth: d });
    for (const child of childrenOf.get(p.id) ?? []) {
      rows.push({ kind: 'item', item: child, depth: d });
      // A cycle in stale data never loops forever.
      if (expanded.has(child.id) && !seen.has(child.id)) walk(child, d + 1, new Set(seen).add(child.id));
    }
    if (canNestUnder(p, opts.depthMax, opts.canCreate)) rows.push({ kind: 'add', parent: p, depth: d });
  };
  walk(parent, depth, new Set([parent.id]));
  return rows;
};

/** A stable key for a subtree row (React keys; a parent has one header and one "add"). */
export const subRowKey = (r: MobileSubRow) => (r.kind === 'item' ? `si:${r.item.id}` : `${r.kind}:${r.parent.id}`);
