// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { findBoard } from '../boards/boards.repo';
import { notifyUsers } from '../notifications/notify';
import { activeBoardOwnerIds, relationColumnsUsingView } from './view-dependents.repo';

/**
 * r19relfilter: a shared view that steered relation columns' choice filters ("offer only items of the view …") was
 * deleted or made private. The columns fall back to every item and show "the view no longer exists" (the read side,
 * `resolveChoices`); here the owners of each column's board hear about it in the bell (and by email per their
 * settings) — one notification per column, which opens that column's settings. The one who did it is not told
 * (D15), and a board muted for everyone sends nothing.
 */
export const notifyChoiceViewGone = async (tx: Db, a: Actor, view: { id: string; boardId: string; name: string }) => {
  const cols = await relationColumnsUsingView(tx, a.ctx.accountId, view.boardId, view.id);
  for (const c of cols) {
    // Owners of a sub-board's column are the parent board's (D14); the bell opens the parent board.
    const topId = c.parentBoardId ?? c.boardId;
    const top = await findBoard(tx, a.ctx.accountId, topId);
    if (!top || (top.settings as { notifications_muted?: boolean } | undefined)?.notifications_muted) continue;
    const owners = (await activeBoardOwnerIds(tx, a.ctx.accountId, topId)).filter((id) => id !== a.user.id);
    await notifyUsers(
      tx,
      {
        accountId: a.ctx.accountId,
        type: 'relation_view_missing',
        actorId: a.user.id,
        boardIds: [c.boardId, topId],
        target: { boardId: c.boardId },
        payload: {
          view_name: view.name,
          column_title: c.title,
          // Only a top-level board's column opens from the link (a sub-board's headers live under the parent's).
          ...(c.parentBoardId ? {} : { column_key: c.key }),
          excerpt: top.name,
        },
      },
      owners,
    );
  }
};
