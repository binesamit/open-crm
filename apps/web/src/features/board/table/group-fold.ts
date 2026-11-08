// SPDX-License-Identifier: AGPL-3.0-only
/**
 * Prod (round 2, the product owner: "while a group is dragged every group should be folded, so moving between them is
 * easy and clear; after the drop the items open again as they were"): the sections shown folded during a group
 * drag — the user's own folded ones plus every board group (top level). Nothing is saved: once the drag ends the
 * table goes back to `collapsed` itself, so each group is open or folded exactly as before.
 */
export const foldedWhileDragging = (
  sections: readonly { key: string; group?: unknown; level?: number }[],
  collapsed: ReadonlySet<string>,
): Set<string> => {
  const out = new Set(collapsed);
  for (const s of sections) if (s.group && s.level === undefined) out.add(s.key);
  return out;
};

/**
 * Where to scroll so a row stays at the same height on screen after the rows above it changed (the dragged group's
 * title under the pointer as everything folds, and again as it opens): its new start in the scroller (the
 * virtualiser's, list offset included) minus where it was in the viewport. Never below 0.
 */
export const keepInPlace = (rowStart: number, viewportTop: number) => Math.max(0, rowStart - viewportTop);
