// SPDX-License-Identifier: AGPL-3.0-only
import type { BulkItemsRequest } from '@bines/shared';

/**
 * (E2E): a hierarchy move changes two boards at once — the board and its sub-board (rows move
 * between them, the first move under an item even creates the sub-board). The tab that made the move ignores its
 * own live events, so the mutation refreshes both: their details (a new `subitems_board_id`, subitem counts) and
 * their items. Bulk actions that stay on one board keep refreshing only that board's items.
 */
const HIERARCHY_ACTIONS = new Set<BulkItemsRequest['action']['type']>(['move_under', 'move_up']);

export const touchesHierarchy = (action: { type: string } | undefined) =>
  !!action && HIERARCHY_ACTIONS.has(action.type as BulkItemsRequest['action']['type']);

/** The boards of `boardId`'s hierarchy known from its cached details: itself, its parent and/or its sub-board. */
export const hierarchyBoardIds = (
  boardId: string,
  detail: { parent_board_id: string | null; subitems_board_id: string | null } | undefined,
) => [...new Set([boardId, detail?.parent_board_id, detail?.subitems_board_id].filter((id): id is string => !!id))];

/**
 * A row is either an item of the board or a subitem — never both. Right after a hierarchy move, its undo or a
 * redo, the board's items and the sub-board's items refetch separately and land one after the other, so for a
 * moment the same row can be in both caches. The subitems table leaves out a subitem row that the board shows as
 * an item (and with it the branch under it): whichever side is stale, the row never shows twice, and once both
 * caches agree nothing is left out.
 */
export const withoutTopRows = <T extends { id: string }>(subRows: T[], topIds: readonly string[]): T[] => {
  if (!topIds.length) return subRows;
  const top = new Set(topIds);
  return subRows.some((r) => top.has(r.id)) ? subRows.filter((r) => !top.has(r.id)) : subRows;
};
