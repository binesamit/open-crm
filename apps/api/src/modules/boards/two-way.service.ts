// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type setTwoWaySchema } from '@bines/shared';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { pairTwoWayColumns, partnerOf, singleTargetBoard, unpairTwoWay } from '../items/relations.service';
import { assertBoard, loadBoardAccess } from './boards.access';
import { findColumnByKey } from './boards.repo';
import { columnDto, createColumnTx } from './boards.service';

/**
 * Two-way switch of a board_relation column (03 §2.16). Needs `column.update` here; enabling also needs
 * `column.create` on the target board (a new partner) or `column.update` there (an existing one). Disabling
 * touches the partner as a side effect.
 */
export const setTwoWay = async (
  db: Db,
  a: Actor,
  boardId: string,
  key: string,
  input: z.infer<typeof setTwoWaySchema>,
) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  const column = await findColumnByKey(db, boardId, key);
  if (!column) throw new AppError('not_found', 'Column not found');
  assertBoard(access, 'column.update');
  const fail = (reason: string) => new AppError('two_way_unavailable', reason, { reason });
  if (column.type !== 'board_relation') throw fail('not_a_relation');
  const who = { accountId: a.ctx.accountId, actorId: a.user.id, requestId: a.requestId };

  if (!input.enabled) {
    const partner = await db.transaction((tx) => unpairTwoWay(tx, who, column));
    return result(db, boardId, key, partner ? { boardId: partner.boardId, key: partner.key } : null, 0);
  }

  const targetBoardId = singleTargetBoard(column);
  if (!targetBoardId) throw fail('one_target_board');
  const current = await partnerOf(db, column);
  if (current && (!input.partner_column_id || input.partner_column_id === current.key))
    return result(db, boardId, key, { boardId: current.boardId, key: current.key }, 0);
  const target = await loadBoardAccess(db, a.ctx, a.user, targetBoardId);
  if (target.board.parentBoardId) throw fail('sub_board');

  return db.transaction(async (tx) => {
    let partner;
    if (input.partner_column_id) {
      assertBoard(target, 'column.update');
      partner = await findColumnByKey(tx, targetBoardId, input.partner_column_id);
      if (!partner) throw new AppError('not_found', 'Column not found');
    } else {
      assertBoard(target, 'column.create');
      partner = await createColumnTx(tx, a, targetBoardId, {
        title: input.partner_title ?? access.board.name,
        type: 'board_relation',
        settings: { board_ids: [boardId], allow_multiple: true },
      });
    }
    const paired = await pairTwoWayColumns(tx, who, column, partner);
    return result(tx, boardId, key, { boardId: partner.boardId, key: partner.key }, paired.backfilled);
  });
};

const result = async (
  db: Db,
  boardId: string,
  key: string,
  partner: { boardId: string; key: string } | null,
  backfilled: number,
) => {
  const column = (await findColumnByKey(db, boardId, key))!;
  const other = partner ? await findColumnByKey(db, partner.boardId, partner.key) : undefined;
  return {
    column: columnDto(column),
    partner: other ? { board_id: other.boardId, column: columnDto(other) } : null,
    backfilled,
  };
};
