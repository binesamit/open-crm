// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  isComputedName,
  type NameDuplicates,
  type NameSource,
  nameSourceOfColumns,
  nameSourceRefs,
  type NameSourceOut,
} from '@bines/shared';
import type { Db } from '../../db/client';
import { assertBoard, loadBoardAccess } from '../boards/boards.access';
import { findBoard, listColumns } from '../boards/boards.repo';
import { updateColumn } from '../boards/boards.service';
import type { Actor } from './items.service';
import { itemsByIds } from './items.repo';
import { nameRecomputeState } from './names.service';
import { duplicateNameGroups } from './names.repo';
import { boardVisibility, filterVisible } from './visibility';

/**
 * The item name source endpoints. The setting itself lives on the board's name column
 * (`settings.name_source`): it is part of the column the UI edits it from (the name column's header menu), it is
 * per board and per sub-board for free (each has its own name column), and board copies / templates / undo of
 * column settings carry it like any column setting. These endpoints are the typed way to read and set it.
 */

const outOf = (boardId: string, columns: { type: string; settings: unknown }[], boardSettings: unknown) => {
  const source = nameSourceOfColumns(columns);
  return {
    board_id: boardId,
    name_source: source,
    computed: isComputedName(source),
    refs: nameSourceRefs(source),
    recompute: nameRecomputeState(boardSettings),
  } satisfies NameSourceOut;
};

/** GET /boards/:id/name-source — the source, the columns it reads and the last recompute. */
export const getNameSource = async (db: Db, a: Actor, boardId: string) => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  return outOf(boardId, await listColumns(db, boardId), access.board.settings);
};

/**
 * PUT /boards/:id/name-source — the same as editing the name column's settings (`column.update` rights, a
 * `column.settings_changed` event, undoable like any column setting). A change that affects names recomputes
 * the board: in the request on small boards, as a background job on big ones (see `recompute`).
 */
export const putNameSource = async (db: Db, a: Actor, boardId: string, input: NameSource) => {
  const columns = await listColumns(db, boardId);
  const nameColumn = columns.find((c) => c.type === 'name');
  if (!nameColumn) throw new AppError('not_found', 'Column not found');
  await updateColumn(db, a, boardId, nameColumn.key, {
    settings: { ...(nameColumn.settings as Record<string, unknown>), name_source: input },
  });
  const board = await findBoard(db, a.ctx.accountId, boardId);
  return outOf(boardId, await listColumns(db, boardId), board?.settings);
};

const MAX_IDS = 20;

/**
 * GET /boards/:id/name-duplicates — names shared by more than one active item (the "unique combination" warning;
 * never a block). Items the reader may not see are left out of the list and the counts.
 */
export const nameDuplicates = async (db: Db, a: Actor, boardId: string): Promise<NameDuplicates> => {
  const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
  assertBoard(access, 'item.read');
  const source = nameSourceOfColumns(await listColumns(db, boardId));
  const found = await duplicateNameGroups(db, boardId);
  const v = await boardVisibility(db, a, access);
  let groups = found.rows.map((g) => ({ name: g.name, count: g.count, item_ids: g.item_ids.slice(0, MAX_IDS) }));
  let count = found.groups;
  let items = found.items;
  if (v) {
    const visible = new Set(
      (
        await filterVisible(
          db,
          v,
          await itemsByIds(
            db,
            a.ctx.accountId,
            groups.flatMap((g) => g.item_ids),
          ),
        )
      ).map((i) => i.id),
    );
    groups = groups
      .map((g) => ({ ...g, item_ids: g.item_ids.filter((id) => visible.has(id)) }))
      .map((g) => ({ ...g, count: g.item_ids.length }))
      .filter((g) => g.count > 1);
    count = groups.length;
    items = groups.reduce((n, g) => n + g.count, 0);
  }
  return { board_id: boardId, warn: source.warn_duplicates === true, count, items, groups };
};
