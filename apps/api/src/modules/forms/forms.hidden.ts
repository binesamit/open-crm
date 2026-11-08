// SPDX-License-Identifier: AGPL-3.0-only
import { AppError, type FormAnswer, type FormHiddenItem, type FormQuestion } from '@bines/shared';
import type { Db } from '../../db/client';
import { findMembership, type AccountRow } from '../accounts/accounts.repo';
import { listColumns, type ColumnRow } from '../boards/boards.repo';
import { columnAllowed, loadBoardAccess } from '../boards/boards.access';
import { getItem, loadItem, type Actor } from '../items/items.service';
import { findUserById } from '../users/users.repo';
import type { FormRow } from './forms.repo';
import { answerFromCell, answerFromParam } from './forms.values';

/**
 * Hidden values (r16forms): a hidden question's value is typed or picked in the editor (`manual` / `choice`), read
 * from an item of a board when the form is submitted (`item`), or taken from a parameter of the link (`url`).
 * Source items are read with the form creator's rights — the same identity that creates the item — and nothing of
 * them ever reaches the public page: the value is resolved on the server at submit time only.
 */

/**
 * The form's identity when it creates items: its creator, with their rights (like an automation's owner, 04 §4.2).
 * One who left the account, or a suspended account, cannot take submissions.
 */
export const formActor = async (
  db: Db,
  form: Pick<FormRow, 'accountId' | 'createdBy'>,
  account: AccountRow,
  requestId: string,
): Promise<Actor> => {
  const userId = form.createdBy;
  const [membership, user] = userId
    ? await Promise.all([findMembership(db, form.accountId, userId), findUserById(db, userId)])
    : [undefined, undefined];
  if (!membership || membership.status !== 'active' || !user || membership.role === 'viewer')
    throw new AppError('not_found', 'form_unavailable');
  return {
    ctx: { account, accountId: account.id, role: membership.role, membershipId: membership.id },
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      emailVerified: !!user.emailVerified,
      isPlatformOwner: false,
      locale: user.locale,
      timezone: user.timezone,
    },
    requestId,
    // r19relfilter: the form owner chose what the form links — a link the relation's filter does not offer is
    // made and marked, never refused at submit time.
    relationPolicy: 'mark',
  };
};

/** The source of a hidden question (absent = typed by hand). */
export const hiddenSourceOf = (q: FormQuestion) => q.hidden_source ?? 'manual';

/** The boards a connect-boards column links to. */
export const relationBoards = (column: Pick<ColumnRow, 'settings'>) =>
  (column.settings as { board_ids?: string[] } | null)?.board_ids ?? [];

/** Can this actor read the item (a 404 for them otherwise)? */
const readable = async (db: Db, a: Actor, itemId: string) => {
  try {
    return (await loadItem(db, a, itemId)).item;
  } catch {
    return null;
  }
};

/**
 * Checks an item source when the form is saved: the item exists and both the person saving and the form's creator
 * (who reads it at submit time) can read it; its column exists; a connect-boards question links to an item of one
 * of its boards. Returns the reason it cannot be used, or null.
 */
export const checkHiddenItem = async (
  db: Db,
  saver: Actor,
  creator: Actor | null,
  column: ColumnRow,
  src: FormHiddenItem,
): Promise<string | null> => {
  const item = await readable(db, saver, src.item_id);
  if (!item || item.boardId !== src.board_id) return 'invalid_source';
  if (creator && creator.user.id !== saver.user.id && !(await readable(db, creator, src.item_id)))
    return 'source_no_access';
  if (src.column_key === null) {
    return column.type === 'board_relation' && relationBoards(column).includes(item.boardId) ? null : 'invalid_source';
  }
  if (src.column_key === 'name') return column.type === 'board_relation' ? 'invalid_source' : null;
  const source = (await listColumns(db, item.boardId)).find((c) => c.key === src.column_key);
  if (!source) return 'invalid_source';
  // S-84: a column hidden from the person saving is not theirs to copy (the creator reads it on submit).
  const saverAccess = await loadBoardAccess(db, saver.ctx, saver.user, item.boardId).catch(() => null);
  if (!saverAccess || !columnAllowed(saverAccess, source.restrictedView)) return 'source_hidden';
  // People and links only come from a column of the same kind.
  if ((column.type === 'board_relation' || column.type === 'people') && source.type !== column.type)
    return 'invalid_source';
  return null;
};

/**
 * The value of an item source at submit time, as an answer for the question's column — or undefined when there is
 * none: the item is gone or the creator cannot read it, its column is gone or hidden from them, or it is empty.
 * A source problem never blocks the person filling the form; the cell is simply left empty.
 */
const itemAnswer = async (db: Db, actor: Actor, column: ColumnRow, src: FormHiddenItem) => {
  let item: Awaited<ReturnType<typeof getItem>>;
  try {
    item = await getItem(db, actor, src.item_id);
  } catch {
    return undefined;
  }
  if (item.board_id !== src.board_id) return undefined;
  if (src.column_key === null) return column.type === 'board_relation' ? [item.id] : undefined;
  if (src.column_key === 'name') return answerFromCell(column, { type: 'text', value: item.name, text: item.name });
  const source = (await listColumns(db, item.board_id)).find((c) => c.key === src.column_key);
  // A column restricted from the creator is not in their item at all.
  const cell = source ? item.cells[source.key] : undefined;
  if (!source || !cell) return undefined;
  return answerFromCell(column, { type: source.type, value: cell.value, text: cell.text });
};

export type HiddenResolution = { answer: FormAnswer | undefined; error?: 'invalid'; fromLink?: boolean };

/**
 * A hidden question's value for one submission. A link parameter is the person's input: one that is present but
 * does not fit the column is refused (`error`), exactly like a visible answer; a missing one falls back to the fixed
 * value when the question says so.
 */
export const resolveHidden = async (
  db: Db,
  actor: Actor,
  q: FormQuestion,
  column: ColumnRow,
  params: Record<string, string>,
  emails: () => Promise<Map<string, string>>,
): Promise<HiddenResolution> => {
  const source = hiddenSourceOf(q);
  if (source === 'item')
    return { answer: q.hidden_item ? await itemAnswer(db, actor, column, q.hidden_item) : undefined };
  if (source === 'url' && q.hidden_param) {
    const raw = params[q.hidden_param.name];
    if (raw === undefined || !raw.trim())
      return { answer: q.hidden_param.fallback ? q.default_value : undefined, fromLink: true };
    return {
      answer: answerFromParam(column, raw, column.type === 'people' ? await emails() : undefined),
      fromLink: true,
    };
  }
  return { answer: q.default_value };
};

/** Connect-boards ids an actor may link here: readable by them and on one of the column's boards. */
export const linkableItems = async (db: Db, actor: Actor, column: ColumnRow, ids: string[]) => {
  const boards = relationBoards(column);
  for (const id of ids) {
    const item = await readable(db, actor, id);
    if (!item || !boards.includes(item.boardId)) return false;
  }
  return true;
};
