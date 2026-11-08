// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import type { WorkspaceTree } from '@bines/shared';
import { changedIds, flattenTree, inRootZone, placesOf, rowById, rowsIn } from './tree-rows';

const board = (id: string, position: string, folder_id: string | null = null) => ({
  id,
  name: id,
  kind: 'main' as const,
  workspace_id: 'W',
  folder_id,
  position,
  item_terminology: 'item',
  can_update: true,
  can_delete: true,
});
const doc = (id: string, position: string, folder_id: string | null = null) => ({
  type: 'doc' as const,
  id,
  name: id,
  icon: null,
  kind: 'main' as const,
  folder_id,
  position,
  can_update: true,
  can_delete: true,
});

const tree: WorkspaceTree = {
  workspace: { id: 'W', name: 'W', kind: 'open', position: 'a', can_edit: true, can_delete: true, can_create: true },
  folders: [
    { id: 'F', workspace_id: 'W', parent_folder_id: null, name: 'F', color: null, position: 'a', can_edit: true },
  ],
  boards: [board('b1', 'a0'), board('b2', 'a2'), board('b3', 'a1', 'F')],
  entities: [doc('d1', 'a1'), doc('d2', 'a3'), doc('d3', 'a0', 'F')],
};

describe('sidebar rows (M8 ד0)', () => {
  it('merges boards and docs of a folder by position', () => {
    expect(rowsIn(tree, null).map((r) => `${r.type}:${r.row.id}`)).toEqual([
      'board:b1',
      'doc:d1',
      'board:b2',
      'doc:d2',
    ]);
    expect(rowsIn(tree, 'F').map((r) => r.row.id)).toEqual(['d3', 'b3']);
  });

  it('finds any row by id, and copes with a tree without entities (an older API)', () => {
    expect(rowById(tree, 'd2')?.name).toBe('d2');
    expect(rowById(tree, 'b3')?.folder_id).toBe('F');
    const old = { ...tree, entities: undefined } as unknown as WorkspaceTree;
    expect(rowsIn(old, null).map((r) => r.row.id)).toEqual(['b1', 'b2']);
  });
});

describe('the flattened tree (s4f-side)', () => {
  const nested: WorkspaceTree = {
    ...tree,
    // Folders before the rows of their parent (as migration 0108 numbered them).
    folders: [
      { id: 'F', workspace_id: 'W', parent_folder_id: null, name: 'F', color: null, position: '0a', can_edit: true },
      { id: 'G', workspace_id: 'W', parent_folder_id: null, name: 'G', color: null, position: '0b', can_edit: true },
      { id: 'FS', workspace_id: 'W', parent_folder_id: 'F', name: 'FS', color: null, position: '0a', can_edit: true },
    ],
    boards: [board('b1', 'a0'), board('b2', 'a2'), board('b3', 'a1', 'F'), board('b4', 'a0', 'FS')],
    entities: [doc('d1', 'a1'), doc('d3', 'a0', 'F')],
  };
  const lines = (closed: string[] = [], hint = false) =>
    flattenTree(nested, new Set(closed), hint).map(
      (it) => `${'  '.repeat(it.depth)}${it.kind === 'row' ? it.row.type : it.kind}:${it.key}${it.gap ? '+' : ''}`,
    );

  it('lists folders (sub-folders first, then rows by position), then the rows without a folder', () => {
    expect(lines()).toEqual([
      'folder:F',
      '  folder:FS',
      '    board:b4',
      '  doc:d3+',
      '  board:b3+',
      'folder:G+',
      'board:b1+',
      'doc:d1+',
      'board:b2+',
    ]);
  });

  it('a folder dragged between rows stands there — in the root and inside a folder', () => {
    const moved: WorkspaceTree = {
      ...nested,
      folders: nested.folders.map((f) =>
        f.id === 'G' ? { ...f, position: 'a15' } : f.id === 'FS' ? { ...f, position: 'a5' } : f,
      ),
    };
    const flat = flattenTree(moved, new Set(), true).map(
      (it) => `${'  '.repeat(it.depth)}${it.kind === 'row' ? it.row.type : it.kind}:${it.key}${it.gap ? '+' : ''}`,
    );
    expect(flat).toEqual([
      'folder:F',
      '  doc:d3',
      '  board:b3+',
      '  folder:FS+',
      '    board:b4',
      'board:b1+',
      'doc:d1+',
      'folder:G+',
      'board:b2+',
      'hint:root-hint+',
    ]);
  });

  it('a closed folder hides everything in it; its sub-folders stay as they were when it opens', () => {
    expect(lines(['F'])).toEqual(['folder:F', 'folder:G+', 'board:b1+', 'doc:d1+', 'board:b2+']);
    expect(lines(['FS'])).toEqual([
      'folder:F',
      '  folder:FS',
      '  doc:d3+',
      '  board:b3+',
      'folder:G+',
      'board:b1+',
      'doc:d1+',
      'board:b2+',
    ]);
    const flat = flattenTree(nested, new Set(['FS']));
    expect(flat.find((it) => it.key === 'FS')).toMatchObject({ kind: 'folder', closed: true });
  });

  it('carries each line’s folders (outermost first) and marks the root zone', () => {
    const flat = flattenTree(nested, new Set());
    expect(flat.find((it) => it.key === 'b4')?.parents).toEqual(['F', 'FS']);
    expect(flat.find((it) => it.key === 'd3')?.parents).toEqual(['F']);
    expect(flat.filter(inRootZone).map((it) => it.key)).toEqual(['b1', 'd1', 'b2']);
  });

  it('adds the "no folder" hint last while a row from a folder is dragged', () => {
    expect(lines([], true).at(-1)).toBe('hint:root-hint+');
    const onlyFolders = { ...nested, boards: nested.boards.filter((b) => b.folder_id), entities: [] };
    expect(flattenTree(onlyFolders, new Set(), true).at(-1)).toMatchObject({ kind: 'hint', gap: true });
  });

  it('without folders the first root row has no space above it', () => {
    const flat = flattenTree({ ...nested, folders: [], boards: [board('x', 'a')], entities: [] }, new Set());
    expect(flat).toMatchObject([{ kind: 'row', key: 'x', gap: false, depth: 0 }]);
  });

  it('keeps the rows of an unchanged tree the same objects (memoised rows compare them)', () => {
    const a = flattenTree(nested, new Set());
    const b = flattenTree(nested, new Set());
    const row = (f: typeof a, key: string) => f.find((it) => it.key === key);
    const ra = row(a, 'b1');
    const rb = row(b, 'b1');
    expect(ra?.kind === 'row' && rb?.kind === 'row' && ra.row.row === rb.row.row).toBe(true);
  });

  it('flattens 1,200 entries quickly', () => {
    const big: WorkspaceTree = {
      ...nested,
      folders: Array.from({ length: 60 }, (_, i) => ({
        id: `F${i}`,
        workspace_id: 'W',
        parent_folder_id: i < 40 ? null : `F${i - 40}`,
        name: `F${i}`,
        color: null,
        position: `a${i}`,
        can_edit: true,
      })),
      boards: Array.from({ length: 1140 }, (_, i) => board(`b${i}`, `a${i}`, i % 3 ? `F${i % 60}` : null)),
      entities: [],
    };
    const t0 = performance.now();
    const flat = flattenTree(big, new Set());
    expect(flat).toHaveLength(1200);
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('what just changed in a tree (s4f-side: a windowed sidebar scrolls it into view)', () => {
  it('finds a new, moved or renamed row or folder; nothing when unchanged', () => {
    const before = placesOf(tree);
    expect(changedIds(before, placesOf(tree))).toEqual([]);
    const added = { ...tree, boards: [...tree.boards, board('b9', 'z', 'F')] };
    expect(changedIds(before, placesOf(added))).toEqual(['b9']);
    const moved = { ...tree, boards: tree.boards.map((b) => (b.id === 'b1' ? { ...b, folder_id: 'F' } : b)) };
    expect(changedIds(before, placesOf(moved))).toEqual(['b1']);
    const renamed = { ...tree, folders: tree.folders.map((f) => ({ ...f, name: 'G' })) };
    expect(changedIds(before, placesOf(renamed))).toEqual(['F']);
  });

  it('many changes at once (a reload, another workspace) are not one action: none', () => {
    const before = placesOf(tree);
    const many = { ...tree, boards: Array.from({ length: 10 }, (_, i) => board(`n${i}`, `a${i}`)) };
    expect(changedIds(before, placesOf(many))).toEqual([]);
  });
});
