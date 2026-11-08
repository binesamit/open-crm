// SPDX-License-Identifier: AGPL-3.0-only
import {
  AppError,
  type DocAction,
  type DocLevel,
  type DocPermissionContext,
  canBoard,
  canDoc,
  docCapabilities,
  type BoardKind,
} from '@bines/shared';
import type { Db } from '../../db/client';
import type { AccountContext, SessionUser } from '../../types';
import {
  findColumnById,
  findWorkspace,
  listColumns,
  listWorkspaces,
  type WorkspaceRow,
  workspaceIdsWithMember,
} from '../boards/boards.repo';
import { type BoardAccess, columnAllowed, workspaceVisibleTo } from '../boards/boards.access';
import type { ItemRow } from '../items/items.repo';
import { itemCells } from '../items/items.repo';
import { assertAssigned, loadItem } from '../items/items.service';
import { docLevelsOf, docsByIds, findDoc, type DocMeta } from './docs.repo';

/** A doc in an item's cell (ד2): the item, the board access it was read through, the column key. */
export type CellHost = { item: ItemRow; board: BoardAccess; columnKey: string };
export type DocAccess = {
  doc: DocMeta;
  workspace: WorkspaceRow;
  perm: DocPermissionContext;
  userId: string;
  cell: CellHost | null;
};

export const docPermissionContext = (
  ctx: AccountContext,
  doc: { kind: BoardKind },
  workspaceVisible: boolean,
  level: DocPermissionContext['level'],
): DocPermissionContext => ({ accountRole: ctx.role, workspaceVisible, doc: { kind: doc.kind }, level });

/**
 * Loads a doc the actor may at least read; anything else — another account's, a hidden one, one in trash — is a
 * 404, so ids of docs one cannot see do not leak. An API token limited to some boards sees no docs.
 */
export const loadDocAccess = async (
  db: Db,
  ctx: AccountContext,
  user: SessionUser,
  docId: string,
): Promise<DocAccess> => {
  const doc = await findDoc(db, ctx.accountId, docId);
  if (!doc || ctx.boardLimit) throw new AppError('not_found', 'Doc not found');
  if (doc.host === 'cell') return loadCellDocAccess(db, ctx, user, doc);
  const [workspace, memberOf, levels] = await Promise.all([
    findWorkspace(db, ctx.accountId, doc.workspaceId),
    workspaceIdsWithMember(db, ctx.accountId, user.id),
    docLevelsOf(db, ctx.accountId, user.id, [doc.id]),
  ]);
  if (!workspace) throw new AppError('not_found', 'Doc not found');
  const perm = docPermissionContext(ctx, doc, workspaceVisibleTo(workspace, ctx, memberOf), levels.get(doc.id) ?? null);
  if (!canDoc(perm, 'doc.read').ok) throw new AppError('not_found', 'Doc not found');
  return { doc, workspace, perm, userId: user.id, cell: null };
};

/**
 * A doc in an item's cell has the item's permissions (plan §3.1, like files): whoever sees the item (and the
 * column) reads it and may comment (account viewers only read); whoever may change that cell — `item.update`,
 * the column's edit restriction, "edit assigned" — edits and manages it (a guest at most edits). Anything else is
 * a 404, like the item.
 */
const loadCellDocAccess = async (db: Db, ctx: AccountContext, user: SessionUser, doc: DocMeta): Promise<DocAccess> => {
  const notFound = () => new AppError('not_found', 'Doc not found');
  if (!doc.itemId || !doc.columnId) throw notFound();
  let loaded: Awaited<ReturnType<typeof loadItem>>;
  try {
    loaded = await loadItem(db, { ctx, user }, doc.itemId);
  } catch {
    throw notFound();
  }
  const { item, access } = loaded;
  const column = await findColumnById(db, doc.columnId);
  if (!column || column.deletedAt || column.boardId !== item.boardId || !columnAllowed(access, column.restrictedView))
    throw notFound();
  let editable = canBoard(access.perm, 'item.update').ok && columnAllowed(access, column.restrictedEdit);
  if (editable) {
    try {
      assertAssigned(access, user, item, await itemCells(db, item.id), await listColumns(db, item.boardId));
    } catch {
      editable = false;
    }
  }
  const level: DocLevel = editable ? 'owner' : 'commenter';
  // The item decided who sees it; as a doc it is then "invited" at that level (guests included).
  const perm = docPermissionContext(ctx, { kind: 'shareable' }, true, level);
  return {
    doc,
    workspace: access.workspace,
    perm,
    userId: user.id,
    cell: { item, board: access, columnKey: column.key },
  };
};

export const assertDoc = (access: DocAccess, action: DocAction) => {
  const d = canDoc(access.perm, action);
  if (!d.ok) throw d.as404 ? new AppError('not_found', 'Doc not found') : new AppError('forbidden', d.reason);
};

export const docCapabilitiesOf = (access: DocAccess) => docCapabilities(access.perm);

/**
 * Of these docs, the ones the actor may read with the context of each (sidebar, search, favourites) — one query
 * for the levels, one for the workspaces.
 */
export const readableDocs = async (db: Db, ctx: AccountContext, user: SessionUser, docs: DocMeta[]) => {
  if (!docs.length || ctx.boardLimit) return [];
  const [levels, memberOf, workspaces] = await Promise.all([
    docLevelsOf(
      db,
      ctx.accountId,
      user.id,
      docs.map((d) => d.id),
    ),
    workspaceIdsWithMember(db, ctx.accountId, user.id),
    listWorkspaces(db, ctx.accountId),
  ]);
  const wsById = new Map(workspaces.map((w) => [w.id, w]));
  const out: { doc: DocMeta; perm: DocPermissionContext }[] = [];
  for (const doc of docs) {
    const ws = wsById.get(doc.workspaceId);
    if (!ws || doc.host !== 'workspace') continue;
    const perm = docPermissionContext(ctx, doc, workspaceVisibleTo(ws, ctx, memberOf), levels.get(doc.id) ?? null);
    if (canDoc(perm, 'doc.read').ok) out.push({ doc, perm });
  }
  return out;
};

/** The docs module's loader as a yes / no (a "shared with you" notification only to who can open it now). */
export const canOpenDoc =
  (docId: string) =>
  async (db: Db, ctx: AccountContext, user: SessionUser): Promise<boolean> => {
    try {
      await loadDocAccess(db, ctx, user, docId);
      return true;
    } catch {
      return false;
    }
  };

export const readableDocIds = async (db: Db, ctx: AccountContext, user: SessionUser, ids: string[]) =>
  new Set(
    (await readableDocs(db, ctx, user, await docsByIds(db, ctx.accountId, [...new Set(ids)]))).map((r) => r.doc.id),
  );
