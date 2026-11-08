// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { type BulkItemsRequest, type BulkResult, type Query, t, treeMoveRights } from '@bines/shared';
import { errorMessage } from '../../lib/api';
import { showToast } from '../../lib/toast';
import { useUndoToast } from '../../lib/undo';
import type { BoardDetail, useBoardMutations } from './board-api';
import { TreeMoveDialog } from './MoveDialog';

/**
 * The rows a hierarchy move acts on: their ids, or — a windowed board's "every match" — the view's query too.
 * `name`: one row's name, for its toast ("X moved under Y").
 */
export type TreeRows = { ids: string[]; query?: Query; name?: string };

type TreeAction = Extract<BulkItemsRequest['action'], { type: 'move_under' | 'move_up' }>;

/**
 * — the hierarchy moves behind every menu that shows "move to item" (the shared
 * `treeMoveMenu` entry): the batch bar and its right-click menu, the row menu, the cell menu and the card's ⋯.
 * "Under an item…" opens `TreeMoveDialog`; "one level up" runs at once. Both go to the board's bulk endpoint
 * (`move_under` / `move_up`, the server's hierarchy service) — one batch, one undo — and the mutation refreshes
 * the board and its sub-board. `board` / `m` are the rows' own board (the sub-board for subitems) and its
 * mutations; `onDone` runs after a move (the batch bar clears its selection, the card re-reads its item).
 */
export const useTreeMove = (
  accountId: string,
  board: BoardDetail,
  m: ReturnType<typeof useBoardMutations>,
  onDone?: () => void,
) => {
  const undoToast = useUndoToast(accountId);
  const [picking, setPicking] = useState<TreeRows | null>(null);
  const rights = treeMoveRights(board.capabilities, !!board.parent_board_id);

  const send = (rows: TreeRows, action: TreeAction, message: (res: BulkResult) => string) =>
    new Promise<BulkResult>((resolve, reject) =>
      (rows.query ? m.bulkQuery : m.bulk).mutate(
        (rows.query ? { query: rows.query, action } : { item_ids: rows.ids, action }) as never,
        {
          onSuccess: (res: BulkResult) => {
            onDone?.();
            const skipped = res.skipped ? ` · ${t('batch.skipped', { n: res.skipped })}` : '';
            undoToast(`${message(res)}${skipped}`, res.event_id);
            resolve(res);
          },
          onError: (err: unknown) => {
            showToast({ message: errorMessage(err), tone: 'error' });
            reject(err);
          },
        },
      ),
    );

  /** The menu handlers for `rows` (ids of the registry's `move_under` / `move_up`). */
  const handlers = (rows: TreeRows) => ({
    move_under: () => setPicking(rows),
    move_up: () =>
      void send(rows, { type: 'move_up' }, (res) =>
        rows.name ? t('subitems.outdented', { what: rows.name }) : t('batch.done.up', { n: res.done }),
      ).catch(() => undefined),
  });

  const dialog = picking ? (
    <TreeMoveDialog
      accountId={accountId}
      board={board}
      ids={picking.ids}
      onClose={() => setPicking(null)}
      onMove={(v) =>
        send(
          picking,
          { type: 'move_under', parent_item_id: v.parent.id, ...(v.mapping ? { mapping: v.mapping } : {}) },
          (res) =>
            picking.name
              ? t('tree.done.under', { what: picking.name, parent: v.parent.name })
              : t('batch.done.under', { n: res.done, parent: v.parent.name }),
        )
      }
    />
  ) : null;

  return { rights, handlers, dialog };
};
