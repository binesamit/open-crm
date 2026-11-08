// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, deleteGuardOf } from '@bines/shared';
import type { Db } from '../../db/client';
import { assertFreshCode } from '../secrets/step-up';
import type { Actor } from '../items/items.service';
import { findBoard } from './boards.repo';

/**
 * a board whose permissions say "deleting takes a verification code" — every delete or archive of an
 * item / subitem (one, many, a group) asks for a fresh two-factor code, the same code as secrets. A subitems board
 * follows its main board. An automation the board's people built still deletes (its run has no person to
 * ask); the AI, agents, MCP and remote support never pass, a personal API token only with `secrets:read`.
 */
export const assertDeleteCode = async (
  db: Db,
  a: Actor,
  board: { settings: unknown; parentBoardId: string | null },
) => {
  const main = board.parentBoardId ? await findBoard(db, a.ctx.accountId, board.parentBoardId) : board;
  const guard = deleteGuardOf(main?.settings);
  if (!guard.enabled || a.automation) return;
  if (a.ctx.support || a.agent || (!a.sessionId && !a.token)) throw new AppError('forbidden', 'delete_requires_code');
  await assertFreshCode(db, a, guard);
};
