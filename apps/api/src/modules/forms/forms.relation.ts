// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, canBoard, type FormQuestion, relationListOf } from '@bines/shared';
import type { Db } from '../../db/client';
import type { AccountRow } from '../accounts/accounts.repo';
import { loadBoardAccess } from '../boards/boards.access';
import { boardsByIds, type ColumnRow } from '../boards/boards.repo';
import { relationChoiceSearch } from '../items/relation-filter.service';
import { searchItems, type Actor } from '../items/items.service';
import type { FormRow } from './forms.repo';
import { memberActor, readable, relationBoards } from './forms.hidden';

/**
 * A visible connect-boards question. The person picks item(s) of the linked board(s):
 * - the list is the items the form's creator may read (the identity that creates the item and its links), within the
 *   column's own filter ("which items it offers") when it has one;
 * - `members`: only a signed-in member who may read the linked board sees the question, and only the items they may
 *   read themselves (both rights);
 * - `everyone`: anyone who opens the form sees the list — the items' names only.
 * The same rules check what a submission links, so nothing outside the list can be linked through the page.
 */

/** Everything that decides a relation question's list for one visitor. */
export type RelationCtx = { creator: Actor; visitor: Actor | null };

export const relationContext = async (
  db: Db,
  account: AccountRow,
  creator: Actor,
  visitorId: string | null,
): Promise<RelationCtx> => ({
  creator,
  visitor: visitorId ? await memberActor(db, account, visitorId, 'form-visitor') : null,
});

const canRead = async (db: Db, a: Actor, boardId: string) => {
  try {
    const access = await loadBoardAccess(db, a.ctx, a.user, boardId);
    return canBoard(access.perm, 'item.read').ok;
  } catch {
    return false;
  }
};

/**
 * The linked boards this visitor's list comes from (in the column's order), or [] = the question is not shown to them.
 * `members` needs a signed-in member; both they and the creator must read the board.
 */
export const relationBoardsFor = async (db: Db, q: FormQuestion, column: ColumnRow, rc: RelationCtx) => {
  const members = relationListOf(q) === 'members';
  if (members && !rc.visitor) return [];
  const out: string[] = [];
  for (const id of relationBoards(column)) {
    if (!(await canRead(db, rc.creator, id))) continue;
    if (members && !(await canRead(db, rc.visitor!, id))) continue;
    out.push(id);
  }
  return out;
};

/** The names of the boards, for the page's board switch (only when there are several). */
export const relationBoardNames = async (db: Db, accountId: string, ids: string[]) => {
  if (ids.length < 2) return [];
  const byId = new Map((await boardsByIds(db, accountId, ids)).map((b) => [b.id, b.name]));
  return ids.map((id) => byId.get(id) ?? '');
};

/** One page of the items a board offers to the creator (the column's filter applied when it has one). */
const creatorPage = async (
  db: Db,
  creator: Actor,
  form: Pick<FormRow, 'boardId'>,
  column: ColumnRow,
  boardId: string,
  q: string,
  offset: number,
  ids?: string[],
) => {
  const filtered = await relationChoiceSearch(db, creator, boardId, q, {
    boardId: form.boardId,
    columnKey: column.key,
    offset,
    ids,
  }).catch((e: unknown) => {
    if (e instanceof AppError && e.code === 'not_found') return null;
    throw e;
  });
  if (filtered) return { data: filtered.data, next_offset: filtered.next_offset, filtered: true };
  const plain = await searchItems(db, creator, boardId, q, offset);
  return { ...plain, filtered: false };
};

/** GET /public/forms/:token/questions/:id/options — one page of the question's items (id + name). */
export const relationOptions = async (
  db: Db,
  form: Pick<FormRow, 'boardId'>,
  q: FormQuestion,
  column: ColumnRow,
  rc: RelationCtx,
  input: { q: string; board: number; offset: number },
) => {
  const boards = await relationBoardsFor(db, q, column, rc);
  const boardId = boards[input.board];
  if (!boardId) throw new AppError('not_found', 'Question not found');
  const page = await creatorPage(db, rc.creator, form, column, boardId, input.q, input.offset);
  let data = page.data;
  // Members: only what the person may read too.
  if (relationListOf(q) === 'members' && rc.visitor) {
    const keep: typeof data = [];
    for (const it of data) if (await readable(db, rc.visitor, it.id)) keep.push(it);
    data = keep;
  }
  return { data: data.map((it) => ({ value: it.id, label: it.name })), next_offset: page.next_offset };
};

/**
 * Are these ids (an answer) all items this visitor's list offers? Each must be on one of the boards the visitor
 * sees, readable by the creator (and by a `members` visitor), and offered by the column's filter.
 */
export const relationAnswerAllowed = async (
  db: Db,
  form: Pick<FormRow, 'boardId'>,
  q: FormQuestion,
  column: ColumnRow,
  rc: RelationCtx,
  ids: string[],
) => {
  if (!ids.length) return true;
  const boards = new Set(await relationBoardsFor(db, q, column, rc));
  const byBoard = new Map<string, string[]>();
  for (const id of ids) {
    const item = await readable(db, rc.creator, id);
    if (!item || !boards.has(item.boardId)) return false;
    if (relationListOf(q) === 'members' && !(await readable(db, rc.visitor!, id))) return false;
    byBoard.set(item.boardId, [...(byBoard.get(item.boardId) ?? []), id]);
  }
  for (const [boardId, list] of byBoard) {
    for (let i = 0; i < list.length; i += 30) {
      const chunk = list.slice(i, i + 30);
      const page = await creatorPage(db, rc.creator, form, column, boardId, '', 0, chunk);
      if (!page.filtered) continue;
      const offered = new Set(page.data.map((d) => d.id));
      if (chunk.some((id) => !offered.has(id))) return false;
    }
  }
  return true;
};
