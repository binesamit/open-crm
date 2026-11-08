// SPDX-License-Identifier: AGPL-3.0-only
import type { QueryClient } from '@tanstack/react-query';
import type { BoardDetail, WorkspaceTree } from '@bines/shared';

/**
 * Fine-grained updates of the cached sidebar trees (s4f-side): a renamed / moved / new row changes that one entry,
 * every other board, doc, dashboard and folder object stays the same (so the memoised sidebar rows do not render
 * again), and nothing waits for a whole tree to reload.
 */

/** Every tree of the account lives under this prefix (and the "all boards" list, which is not a tree). */
const treesKey = (accountId: string) => ['account', accountId, 'tree'] as const;

const isTree = (x: unknown): x is WorkspaceTree =>
  !!x &&
  typeof x === 'object' &&
  'workspace' in x &&
  Array.isArray((x as WorkspaceTree).boards) &&
  Array.isArray((x as WorkspaceTree).folders);

export type TreeRowPatch = { name?: string; folder_id?: string | null; icon?: string | null };

const byPosition = (a: { position: string }, b: { position: string }) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;

/** `list` with the entry `id` patched (only the fields it has), or `list` itself when nothing changes. */
const patchList = <T extends { id: string }>(list: T[], id: string, patch: Partial<T>): T[] => {
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return list;
  const old = list[i]!;
  const changed = (Object.keys(patch) as (keyof T)[]).some((k) => patch[k] !== undefined && patch[k] !== old[k]);
  if (!changed) return list;
  const next = list.slice();
  const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<T>;
  next[i] = { ...old, ...clean };
  return next;
};

/** One tree with the row / folder `id` patched; the same tree object when it is not in it. */
export const patchTree = (tree: WorkspaceTree, id: string, patch: TreeRowPatch): WorkspaceTree => {
  const boards = patchList(tree.boards, id, { name: patch.name, folder_id: patch.folder_id });
  const entities = tree.entities
    ? patchList(tree.entities, id, { name: patch.name, folder_id: patch.folder_id, icon: patch.icon })
    : tree.entities;
  const folders = patchList(tree.folders, id, { name: patch.name });
  return boards === tree.boards && entities === tree.entities && folders === tree.folders
    ? tree
    : { ...tree, boards, entities, folders };
};

/** Patches a board, doc, dashboard or folder in every cached tree of the account (shown at once). */
export const patchTreeRow = (qc: QueryClient, accountId: string, id: string, patch: TreeRowPatch) => {
  qc.setQueriesData<unknown>({ queryKey: treesKey(accountId) }, (old: unknown) =>
    isTree(old) ? patchTree(old, id, patch) : old,
  );
};

/** The tree's entry for a board the API returned (create / duplicate): its place and my rights on it. */
export const treeBoardOf = (b: BoardDetail): WorkspaceTree['boards'][number] => ({
  id: b.id,
  name: b.name,
  kind: b.kind,
  workspace_id: b.workspace_id,
  folder_id: b.folder_id,
  position: b.position,
  item_terminology: b.item_terminology,
  can_update: !!b.capabilities['board.update'],
  can_delete: !!b.capabilities['board.delete'],
});

/** A tree with a board added in its place by position (or the same tree when it is already there). */
export const addBoard = (tree: WorkspaceTree, board: WorkspaceTree['boards'][number]): WorkspaceTree =>
  tree.boards.some((b) => b.id === board.id) ? tree : { ...tree, boards: [...tree.boards, board].sort(byPosition) };

/** A new board shows in its workspace's cached tree at once (the reload after it only confirms it). */
export const addBoardToTree = (qc: QueryClient, accountId: string, board: BoardDetail) => {
  const key = [...treesKey(accountId), board.workspace_id];
  qc.setQueryData<unknown>(key, (old: unknown) => (isTree(old) ? addBoard(old, treeBoardOf(board)) : old));
};

/** After a failed optimistic change: reload the trees (the server's truth). */
export const reloadTrees = (qc: QueryClient, accountId: string) =>
  qc.invalidateQueries({ queryKey: treesKey(accountId) });
