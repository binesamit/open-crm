// SPDX-License-Identifier: AGPL-3.0-only
import type { Db } from '../../db/client';
import { boardsByIds, listBoardsInWorkspaces } from '../boards/boards.repo';
import type { InstallationRow } from './extensions.repo';

/**
 * Where an installation works: the whole account, or chosen workspaces and / or chosen boards (their
 * union). `board_ids` is the installation's column; the workspaces live in its `state` (`workspace_ids`), so a board
 * added to a chosen workspace later is in scope at once. Both empty (null) = every board of the account.
 */
type ScopeRow = Pick<InstallationRow, 'accountId' | 'boardIds' | 'state'>;

export const scopeWorkspaceIds = (row: Pick<InstallationRow, 'state'>): string[] | null => {
  const ws = (row.state as { workspace_ids?: unknown } | null)?.workspace_ids;
  return Array.isArray(ws) && ws.length ? ws.filter((x): x is string => typeof x === 'string') : null;
};

/** The installation's state with the chosen workspaces (none = the key is removed). */
export const withScopeWorkspaces = (state: unknown, workspaceIds: string[] | null): Record<string, unknown> => {
  const { workspace_ids: _, ...rest } = (state ?? {}) as Record<string, unknown>;
  return workspaceIds?.length ? { ...rest, workspace_ids: workspaceIds } : rest;
};

/** Account-wide: no board list and no workspace list. */
export const scopeIsAll = (row: ScopeRow) => !row.boardIds && !scopeWorkspaceIds(row);

/** In scope, for a board whose workspace the caller already knows. */
export const inScope = (row: ScopeRow, board: { id: string; workspaceId: string | null }) => {
  if (scopeIsAll(row)) return true;
  if (row.boardIds?.includes(board.id)) return true;
  return !!board.workspaceId && !!scopeWorkspaceIds(row)?.includes(board.workspaceId);
};

/** The workspace of a board, looked up only when a workspace list makes it matter. */
export const boardInScope = async (db: Db, row: ScopeRow, boardId: string) => {
  if (scopeIsAll(row) || row.boardIds?.includes(boardId)) return true;
  if (!scopeWorkspaceIds(row)) return false;
  const [b] = await boardsByIds(db, row.accountId, [boardId]);
  return !!b && inScope(row, b);
};

/** Of these boards, those in scope (one lookup). */
export const boardsInScope = async (db: Db, row: ScopeRow, ids: string[]) => {
  if (scopeIsAll(row)) return ids;
  if (!scopeWorkspaceIds(row)) return ids.filter((id) => row.boardIds!.includes(id));
  const ws = new Map((await boardsByIds(db, row.accountId, ids)).map((b) => [b.id, b.workspaceId]));
  return ids.filter((id) => inScope(row, { id, workspaceId: ws.get(id) ?? null }));
};

/** Every board in scope now (null = the whole account) — for a server token's board limit. */
export const scopeBoardIds = async (db: Db, row: ScopeRow): Promise<string[] | null> => {
  const ws = scopeWorkspaceIds(row);
  if (!ws) return row.boardIds ?? null;
  const inWs = (await listBoardsInWorkspaces(db, row.accountId, ws)).map((b) => b.id);
  return [...new Set([...(row.boardIds ?? []), ...inWs])];
};
