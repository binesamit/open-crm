// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceEntity, WorkspaceTree } from '@bines/shared';

/**
 * The sidebar's rows (M8 ד0): a workspace holds boards and — in the same folders, in one order — other objects
 * (docs now, dashboards next). The API sends boards and `entities` apart; the tree shows them merged by position.
 */
type TreeBoard = WorkspaceTree['boards'][number];
export type TreeRow = { type: 'board'; row: TreeBoard } | { type: WorkspaceEntity['type']; row: WorkspaceEntity };

const byPosition = (a: TreeRow, b: TreeRow) =>
  a.row.position < b.row.position ? -1 : a.row.position > b.row.position ? 1 : 0;

/** The boards and docs of one folder (null = the root), in their shared order. */
export const rowsIn = (data: WorkspaceTree, folderId: string | null): TreeRow[] =>
  [
    ...data.boards.filter((b) => b.folder_id === folderId).map((row): TreeRow => ({ type: 'board', row })),
    ...(data.entities ?? []).filter((e) => e.folder_id === folderId).map((row): TreeRow => ({ type: row.type, row })),
  ].sort(byPosition);

/** Any row by id (boards and docs share one id space — ULIDs). */
export const rowById = (data: WorkspaceTree, id: string) =>
  data.boards.find((b) => b.id === id) ?? (data.entities ?? []).find((e) => e.id === id);

type TreeFolder = WorkspaceTree['folders'][number];

/**
 * One line of the sidebar tree, flattened (s4f-side): a folder's header, a board / doc / dashboard, or the "drop here
 * for no folder" hint shown while something from a folder is dragged. `parents` = the ids of the folders it is in,
 * outermost first (shared by siblings). `gap` = a 2 px space above it (it is not the first thing in its container).
 */
export type FlatItem =
  | { kind: 'folder'; key: string; folder: TreeFolder; depth: number; gap: boolean; closed: boolean; parents: string[] }
  | { kind: 'row'; key: string; row: TreeRow; depth: number; gap: boolean; parents: string[] }
  | { kind: 'hint'; key: string; depth: 0; gap: boolean; parents: string[] };

/** Folder → its sub-folders and its rows, built once per tree (filtering per folder was folders × rows work). */
const indexTree = (data: WorkspaceTree) => {
  const subfolders = new Map<string | null, TreeFolder[]>();
  for (const f of data.folders) {
    const list = subfolders.get(f.parent_folder_id ?? null);
    if (list) list.push(f);
    else subfolders.set(f.parent_folder_id ?? null, [f]);
  }
  const rows = new Map<string | null, TreeRow[]>();
  const add = (folderId: string | null, r: TreeRow) => {
    const list = rows.get(folderId);
    if (list) list.push(r);
    else rows.set(folderId, [r]);
  };
  for (const row of data.boards) add(row.folder_id, { type: 'board', row });
  for (const row of data.entities ?? []) add(row.folder_id, { type: row.type, row });
  for (const list of rows.values()) list.sort(byPosition);
  return { subfolders, rows };
};

export const HINT_KEY = 'root-hint';

/**
 * The tree as the sidebar shows it, top to bottom: the root's folders and rows in their one order (a folder: its
 * header, then — when open — its own sub-folders and rows, recursively), then the hint when `rootHint`.
 * A closed folder hides everything in it.
 */
export const flattenTree = (data: WorkspaceTree, closed: ReadonlySet<string>, rootHint = false): FlatItem[] => {
  const { subfolders, rows } = indexTree(data);
  const out: FlatItem[] = [];
  // a folder's sub-folders and its rows stand in one order (a folder may sit between boards); the
  // positions say where (folders used to come first — the migration kept them there until someone drags one).
  const walk = (folderId: string | null, depth: number, parents: string[]) => {
    const kids: ({ folder: TreeFolder; position: string } | { row: TreeRow; position: string })[] = [
      ...(subfolders.get(folderId) ?? []).map((f) => ({ folder: f, position: f.position })),
      ...(rows.get(folderId) ?? []).map((r) => ({ row: r, position: r.row.position })),
    ].sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
    kids.forEach((k, i) => {
      if ('folder' in k) folder(k.folder, depth, parents, i > 0);
      else out.push({ kind: 'row', key: k.row.row.id, row: k.row, depth, gap: i > 0, parents });
    });
    return kids.length;
  };
  const folder = (f: TreeFolder, depth: number, parents: string[], gap: boolean) => {
    const isClosed = closed.has(f.id);
    out.push({ kind: 'folder', key: f.id, folder: f, depth, gap, closed: isClosed, parents });
    if (!isClosed) walk(f.id, depth + 1, [...parents, f.id]);
  };
  const none: string[] = [];
  const count = walk(null, 0, none);
  // The "drop here for no folder" hint: last, 2 px under what is above it.
  if (rootHint) out.push({ kind: 'hint', key: HINT_KEY, depth: 0, gap: count > 0, parents: none });
  return out;
};

/** Whether a flattened item lives in the root zone (no folder): the rows without a folder and the hint. */
export const inRootZone = (item: FlatItem) => item.kind !== 'folder' && item.parents.length === 0;

/** Where each board, doc, dashboard and folder is and what it is called — compared after a tree changes. */
export const placesOf = (data: WorkspaceTree): Map<string, string> => {
  const at = new Map<string, string>();
  for (const b of data.boards) at.set(b.id, `${b.folder_id}|${b.position}|${b.name}`);
  for (const e of data.entities ?? []) at.set(e.id, `${e.folder_id}|${e.position}|${e.name}`);
  for (const f of data.folders) at.set(f.id, `${f.parent_folder_id}|${f.position}|${f.name}`);
  return at;
};

/**
 * The ids that are new, moved or renamed between two trees of the same workspace (s4f-side): a windowed sidebar
 * scrolls the last one into view, so what one just created / moved / renamed is never off-screen. Many at once (a
 * reload of a busy workspace) are not "what I just did": none then.
 */
export const changedIds = (before: Map<string, string>, after: Map<string, string>, most = 5): string[] => {
  const out: string[] = [];
  for (const [id, place] of after) {
    if (before.get(id) === place) continue;
    out.push(id);
    if (out.length > most) return [];
  }
  return out;
};
