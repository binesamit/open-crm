// SPDX-License-Identifier: AGPL-3.0-only
/**
 * The item tree (D14; 02 §items). `depth` is 0 for a top-level item, 1 for a subitem, 2 for a sub-subitem …;
 * the database allows `depth` 0..5 (`ck_items_depth`). A board's `hierarchy_depth_max` is the deepest `depth` it
 * allows under its items: 1 = subitems only, 2 = sub-subitems too (every new board, as the code always did —
 * product decision in the 2026-10-10 audit), up to 5. A stored value above 5 (the boards CHECK accepts 1..6) is
 * read as 5, so the service never lets an insert hit the items CHECK.
 */
export const ITEM_DEPTH_MAX = 5;

/** The deepest `depth` a board allows: its `hierarchy_depth_max`, never above `ITEM_DEPTH_MAX`. */
export const effectiveDepthMax = (hierarchyDepthMax: number | null | undefined) =>
  Math.max(1, Math.min(hierarchyDepthMax ?? 2, ITEM_DEPTH_MAX));
