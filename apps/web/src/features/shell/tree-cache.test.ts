// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { BoardDetail, WorkspaceTree } from '@bines/shared';
import { addBoard, addBoardToTree, patchTree, patchTreeRow, treeBoardOf } from './tree-cache';

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
const tree = (): WorkspaceTree => ({
  workspace: { id: 'W', name: 'W', kind: 'open', position: 'a', can_edit: true, can_delete: true, can_create: true },
  folders: [
    { id: 'F', workspace_id: 'W', parent_folder_id: null, name: 'F', color: null, position: 'a', can_edit: true },
  ],
  boards: [board('b1', 'a0'), board('b2', 'a2', 'F')],
  entities: [
    {
      type: 'doc',
      id: 'd1',
      name: 'd1',
      icon: null,
      kind: 'main',
      folder_id: null,
      position: 'a1',
      can_update: true,
      can_delete: true,
    },
  ],
});

describe('fine-grained sidebar cache updates (s4f-side)', () => {
  it('patches one board and keeps every other object', () => {
    const t = tree();
    const next = patchTree(t, 'b1', { name: 'New name' });
    expect(next.boards[0]).toMatchObject({ id: 'b1', name: 'New name', position: 'a0' });
    expect(next.boards[1]).toBe(t.boards[1]);
    expect(next.entities).toBe(t.entities);
    expect(next.folders).toBe(t.folders);
  });

  it('moves a row to the root (folder_id null) and patches docs and folders', () => {
    const t = tree();
    expect(patchTree(t, 'b2', { folder_id: null }).boards[1]!.folder_id).toBeNull();
    expect(patchTree(t, 'd1', { name: 'Doc', icon: '📄' }).entities[0]).toMatchObject({ name: 'Doc', icon: '📄' });
    expect(patchTree(t, 'F', { name: 'Folder' }).folders[0]!.name).toBe('Folder');
  });

  it('returns the same tree when the id is not in it or nothing changes', () => {
    const t = tree();
    expect(patchTree(t, 'nope', { name: 'x' })).toBe(t);
    expect(patchTree(t, 'b1', { name: 'b1' })).toBe(t);
    expect(patchTree(t, 'b1', {})).toBe(t);
  });

  it('patches every cached tree of the account, never the all-boards list under the same prefix', () => {
    const qc = new QueryClient();
    const t = tree();
    const all = { data: [{ id: 'b1', name: 'b1' }] };
    qc.setQueryData(['account', 'A', 'tree', 'W'], t);
    qc.setQueryData(['account', 'A', 'tree', '', 'all'], all);
    patchTreeRow(qc, 'A', 'b1', { name: 'Renamed' });
    expect(qc.getQueryData<WorkspaceTree>(['account', 'A', 'tree', 'W'])!.boards[0]!.name).toBe('Renamed');
    expect(qc.getQueryData(['account', 'A', 'tree', '', 'all'])).toBe(all);
  });

  it('adds a created board in its place by position, with my rights, once', () => {
    const detail = {
      ...board('b9', 'a1'),
      capabilities: { 'board.update': true, 'board.delete': false },
    } as unknown as BoardDetail;
    const entry = treeBoardOf(detail);
    expect(entry).toMatchObject({ id: 'b9', can_update: true, can_delete: false });
    const t = tree();
    const next = addBoard(t, entry);
    expect(next.boards.map((b) => b.id)).toEqual(['b1', 'b9', 'b2']);
    expect(next.boards[0]).toBe(t.boards[0]);
    expect(addBoard(next, entry)).toBe(next);

    const qc = new QueryClient();
    qc.setQueryData(['account', 'A', 'tree', 'W'], t);
    addBoardToTree(qc, 'A', detail);
    expect(qc.getQueryData<WorkspaceTree>(['account', 'A', 'tree', 'W'])!.boards).toHaveLength(3);
  });
});
