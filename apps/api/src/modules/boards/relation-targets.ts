// SPDX-License-Identifier: AGPL-3.0-only
import { AppError } from '@bines/shared';
import type { Db } from '../../db/client';
import type { Actor } from '../../types';
import { withoutTwoWay } from '../items/relations.service';
import { readableBoardIds } from './boards.access';
import { listColumns, updateColumnRow } from './boards.repo';

/** The boards a connect-boards column's settings link to. */
export const relationBoardIds = (settings: Record<string, unknown> | null | undefined): string[] =>
  Array.isArray(settings?.board_ids)
    ? (settings.board_ids as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

/**
 * a connect-boards column links only to boards its editor may read — whoever they are (a guest, a
 * member, an admin not subscribed to a private board), through any path (the column API, a bulk edit / import, AI
 * tools, MCP, API tokens). Checked on create and on every settings change. Boards it already linked to stay (an
 * editor who cannot see one of them still renames the column or adds a board); the column's own board is always
 * allowed. A board that does not exist and one the actor cannot read get the same answer, so ids don't leak.
 */
export const assertRelationTargets = async (
  db: Db,
  a: Actor,
  boardId: string,
  next: Record<string, unknown>,
  previous: Record<string, unknown> | null,
) => {
  const before = new Set(relationBoardIds(previous));
  const added = [...new Set(relationBoardIds(next))].filter((id) => id !== boardId && !before.has(id));
  if (!added.length) return;
  const readable = await readableBoardIds(db, a.ctx, a.user, added);
  const hidden = added.filter((id) => !readable.has(id));
  if (hidden.length)
    throw new AppError('validation_failed', 'A linked board was not found', {
      reason: 'board_not_readable',
      board_ids: hidden,
    });
};

/**
 * Boards made from another board or a template (duplicate, new board from a template): their connect-boards
 * columns keep only the boards the actor reads (and the new boards themselves) — a copy never links to a board its
 * maker could not link to by hand. A dropped board's choice filter goes with it; a two-way pair is not kept.
 */
export const dropUnreadableRelationTargets = async (tx: Db, a: Actor, boardIds: string[]) => {
  const own = new Set(boardIds);
  for (const boardId of boardIds)
    for (const c of await listColumns(tx, boardId)) {
      if (c.type !== 'board_relation') continue;
      const settings = c.settings as Record<string, unknown>;
      const ids = relationBoardIds(settings);
      const foreign = ids.filter((id) => !own.has(id));
      if (!foreign.length) continue;
      const readable = await readableBoardIds(tx, a.ctx, a.user, foreign);
      const dropped = foreign.filter((id) => !readable.has(id));
      if (!dropped.length) continue;
      const filters = { ...((settings.choice_filter as Record<string, unknown> | undefined) ?? {}) };
      for (const id of dropped) delete filters[id];
      await updateColumnRow(tx, c.id, {
        settings: {
          ...withoutTwoWay(settings),
          board_ids: ids.filter((id) => !dropped.includes(id)),
          ...(settings.choice_filter ? { choice_filter: filters } : {}),
        },
      });
    }
};
