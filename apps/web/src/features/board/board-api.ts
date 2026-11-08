// SPDX-License-Identifier: AGPL-3.0-only
import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createWriteSeq } from './write-seq';
import type {
  BoardDetail,
  BulkItemsRequest,
  BulkQueryRequest,
  BulkResult,
  Column,
  ColumnMapping,
  Deleted,
  EditedItem,
  Group,
  GroupColor,
  Item,
  ItemSequence,
  Moved,
  BoardListEntry,
  Tag,
  Team,
  WorkspaceTree,
} from '@bines/shared';
import { t, UNDO_TOAST_SECONDS } from '@bines/shared';
import { showToast } from '../../lib/toast';
import { hierarchyBoardIds, touchesHierarchy } from './hierarchy-refresh';
import { ApiError } from '@bines/sdk';
import { api, errorMessage } from '../../lib/api';
import { rememberEdit, useDeletedToast, useUndoToast } from '../../lib/undo';
import { fetchBoardItems } from './windowed';
import { markFreshItem } from '../../lib/motion';
import { stepUpRequest } from '../secrets/step-up';

export type { BoardDetail, Column, Group, Item, Tag, Team, WorkspaceTree };
export type Workspace = Omit<WorkspaceTree['workspace'], 'can_edit' | 'can_delete' | 'can_create'>;
export type Member = {
  user_id: string;
  name: string;
  email: string;
  role: string;
  status: string;
  avatar_url: string | null;
  /** An agent ("digital worker", מ8): offered in mentions / people pickers when it acts on them. */
  agent?: {
    id: string;
    mention: boolean;
    assign: boolean;
    avatar: string | null;
    /** The @mention list only: why it may not be mentioned here (`agents.mention.unavailable.<reason>`). */
    unavailable?: string;
  };
};

export const boardKeys = {
  workspaces: (accountId: string) => ['account', accountId, 'workspaces'] as const,
  tree: (accountId: string, workspaceId: string) => ['account', accountId, 'tree', workspaceId] as const,
  templates: (accountId: string) => ['account', accountId, 'templates'] as const,
  board: (accountId: string, boardId: string) => ['account', accountId, 'board', boardId] as const,
  items: (accountId: string, boardId: string) => ['account', accountId, 'board', boardId, 'items'] as const,
  members: (accountId: string) => ['account', accountId, 'members'] as const,
};

export const useWorkspaces = (accountId: string) =>
  useQuery({
    queryKey: boardKeys.workspaces(accountId),
    queryFn: () => api(accountId).get<{ data: Workspace[] }>('/workspaces'),
  });

/**
 * Every top-level board I may open, from all the workspaces I see, in one call (`GET /boards`) — pickers across
 * workspaces used to load each workspace's tree (one request each; hundreds of workspaces queued every other request
 * behind them). Under the trees' key prefix, so whatever refreshes the sidebar's trees refreshes this list too.
 */
export const useReadableBoards = (accountId: string) =>
  useQuery({
    queryKey: [...boardKeys.tree(accountId, ''), 'all'] as const,
    queryFn: () => api(accountId).get<{ data: BoardListEntry[] }>('/boards'),
  });

export const useTree = (accountId: string, workspaceId: string | undefined) =>
  useQuery({
    queryKey: boardKeys.tree(accountId, workspaceId ?? ''),
    queryFn: () => api(accountId).get<WorkspaceTree>(`/workspaces/${workspaceId}/tree`),
    enabled: !!workspaceId,
  });

export const useBoard = (accountId: string, boardId: string) =>
  useQuery({
    queryKey: boardKeys.board(accountId, boardId),
    queryFn: () => api(accountId).get<BoardDetail>(`/boards/${boardId}`),
    enabled: !!boardId,
  });

/** An item-number column's sequence (03 §2.19) and setting the next number; `sequence` null = none yet. */
export const useItemSequence = (accountId: string, boardId: string, columnKey: string) => {
  const qc = useQueryClient();
  const key = ['account', accountId, 'board', boardId, 'sequence', columnKey] as const;
  const query = useQuery({
    queryKey: key,
    queryFn: () =>
      api(accountId).get<{ sequence: ItemSequence | null }>(`/boards/${boardId}/columns/${columnKey}/sequence`),
  });
  const setNext = async (next: number) => {
    await api(accountId).put(`/boards/${boardId}/columns/${columnKey}/sequence`, { next_seq: next });
    await qc.invalidateQueries({ queryKey: key });
  };
  return { ...query, setNext };
};

/**
 * A board's items: every row, or — on a board above the windowed threshold (perf review §7.1) — only the rows
 * loaded so far, with `windowed` set (see `windowed.ts`).
 */
export const useItems = (accountId: string, boardId: string) =>
  useQuery({
    queryKey: boardKeys.items(accountId, boardId),
    queryFn: () => fetchBoardItems(accountId, boardId),
    enabled: !!boardId,
  });

/** Teams of the account (05 §7): assignable in people cells, "my teams" in filters and visibility. */
export const useTeams = (accountId: string) =>
  useQuery({
    queryKey: ['account', accountId, 'teams'],
    queryFn: () => api(accountId).get<{ data: Team[] }>('/teams'),
    staleTime: 5 * 60_000,
  });

/** Account tags (03 §3.1) — names and colours for tags cells, filters and groups. */
export const useTags = (accountId: string) =>
  useQuery({
    queryKey: ['account', accountId, 'tags'],
    queryFn: () => api(accountId).get<{ data: Tag[] }>('/tags'),
    staleTime: 5 * 60_000,
  });

export const useMembers = (accountId: string) =>
  useQuery({
    queryKey: boardKeys.members(accountId),
    queryFn: () => api(accountId).get<{ data: Member[] }>('/users'),
    staleTime: 5 * 60_000,
  });

/** Board mutations; item results are written straight into the items cache so edits feel instant. */
export const useBoardMutations = (accountId: string, boardId: string) => {
  const qc = useQueryClient();
  const client = api(accountId);
  const itemsKey = boardKeys.items(accountId, boardId);
  const boardKey = boardKeys.board(accountId, boardId);
  const refreshBoard = () => qc.invalidateQueries({ queryKey: boardKey });
  const deleted = useDeletedToast(accountId);
  const undoToast = useUndoToast(accountId);
  /** Writes the board's columns straight into the cache (drag reorder / live resize feel instant). */
  const patchColumns = (fn: (columns: Column[]) => Column[]) =>
    qc.setQueryData<BoardDetail>(boardKey, (old) => (old ? { ...old, columns: fn(old.columns) } : old));
  const refreshItems = () => qc.invalidateQueries({ queryKey: itemsKey });
  /**
   * A hierarchy move: this board, its parent or sub-board — details and items. A sub-board made by
   * this very move is not in the cached details yet: refreshing them brings its id, and its items load fresh.
   */
  const refreshAfterBulk = (action: { type: string } | undefined) =>
    touchesHierarchy(action)
      ? Promise.all(
          hierarchyBoardIds(boardId, qc.getQueryData<BoardDetail>(boardKey)).map((id) =>
            qc.invalidateQueries({ queryKey: boardKeys.board(accountId, id) }),
          ),
        )
      : refreshItems();
  // `...old` keeps the rest of the cache entry — a windowed board's `windowed` marker (windowed.ts) must survive.
  const putItem = (item: Item) =>
    qc.setQueryData<{ data: Item[] }>(itemsKey, (old) =>
      old
        ? {
            ...old,
            data: old.data.some((i) => i.id === item.id)
              ? old.data.map((i) => (i.id === item.id ? item : i))
              : [...old.data, item],
          }
        : old,
    );

  // Audit 2026-10-10 (web #1): a response behind a newer write of the same item must not replace the row — the
  // newer cell would show its old value. The newer response (or a refetch) carries the truth.
  const writes = useRef(createWriteSeq());
  const settle = (item: EditedItem, v: { itemId: string }, ctx: { seq: number } | undefined) => {
    if (!ctx || writes.current.isLatest(v.itemId, ctx.seq)) putItem(item);
    else void refreshItems();
  };

  return {
    setCell: useMutation({
      /** `gesture`: writes of one paste / cleared range are one action for Ctrl+Z. */
      /** `workflowOverride`: an owner's move past the status workflow, on purpose. */
      mutationFn: (v: {
        itemId: string;
        columnId: string;
        value: unknown;
        gesture?: string;
        workflowOverride?: boolean;
      }) =>
        v.value === null && !v.workflowOverride
          ? client.delete<EditedItem>(`/items/${v.itemId}/cells/${v.columnId}`)
          : client.put<EditedItem>(`/items/${v.itemId}/cells/${v.columnId}`, {
              value: v.value,
              ...(v.workflowOverride ? { workflow_override: true } : {}),
            }),
      onMutate: (v) => ({ seq: writes.current.next(v.itemId) }),
      onSuccess: (item: EditedItem, v, ctx) => {
        rememberEdit(accountId, item.event_id, v.gesture);
        settle(item, v, ctx);
        // A dependency moved other items with this edit (M8 ד7): reload them.
        if (item.shifted_item_ids?.length) void refreshItems();
        // r19relfilter: a link changed — the "does not match the filter" marks of this board are checked again.
        if (v.value === null || (typeof v.value === 'object' && 'item_ids' in v.value))
          void qc.invalidateQueries({ queryKey: ['account', accountId, 'board', boardId, 'relation-matches'] });
      },
      onError: (e) => {
        // say why the status workflow stopped the move (which fields are missing …).
        if (e instanceof ApiError && e.body.code === 'workflow_blocked')
          showToast({ message: errorMessage(e), tone: 'error' });
        void refreshItems();
      },
    }),
    /** Several cells of one item in one write (one event, one undo) — e.g. a calendar move: a date and two hours. */
    setCells: useMutation({
      mutationFn: (v: { itemId: string; cells: Record<string, unknown> }) =>
        client.patch<EditedItem>(`/items/${v.itemId}`, { cells: v.cells }),
      onMutate: (v) => ({ seq: writes.current.next(v.itemId) }),
      onSuccess: (item: EditedItem, v, ctx) => settle(item, v, ctx),
      onError: (e) => {
        if (e instanceof ApiError && e.body.code === 'workflow_blocked')
          showToast({ message: errorMessage(e), tone: 'error' });
        void refreshItems();
      },
    }),
    renameItem: useMutation({
      mutationFn: (v: { itemId: string; name: string; gesture?: string }) =>
        client.patch<EditedItem>(`/items/${v.itemId}`, { name: v.name }),
      onMutate: (v) => ({ seq: writes.current.next(v.itemId) }),
      onSuccess: (item: EditedItem, v, ctx) => {
        rememberEdit(accountId, item.event_id, v.gesture);
        settle(item, v, ctx);
      },
      // e.g. 409 item_name_computed: the board computes names — say so, and show the name it has.
      onError: (e) => {
        showToast({ message: errorMessage(e), tone: 'error' });
        void refreshItems();
      },
    }),
    createItem: useMutation({
      /** `afterId` = right below that item (menu "add item below"); `top` = first in the group (the header's
       *  "new item"); default: bottom of the group. */
      mutationFn: (v: {
        /** Omitted on a board that computes names: the server names the item. */
        name?: string;
        groupId: string;
        cells?: Record<string, unknown>;
        afterId?: string;
        top?: boolean;
      }) =>
        client.post<Item>(`/boards/${boardId}/items`, {
          ...(v.name !== undefined ? { name: v.name } : {}),
          group_id: v.groupId,
          cells: v.cells,
          ...(v.afterId ? { position: { after_id: v.afterId } } : v.top ? { position: 'top' } : {}),
        }),
      // r16motion: the new row lights up softly once (lib/motion.ts).
      onSuccess: (item) => {
        markFreshItem(item.id);
        putItem(item);
      },
    }),
    deleteItem: useMutation({
      mutationFn: (v: { id: string; name: string }) =>
        stepUpRequest(accountId, () => client.delete<Deleted>(`/items/${v.id}`)),
      onSuccess: async (res, v) => {
        deleted(v.name, res);
        await refreshItems();
      },
    }),
    /** Archive (07 §5.1): out of the board, back from the archive page or the toast's undo. */
    archiveItem: useMutation({
      mutationFn: (v: { id: string; name: string }) =>
        stepUpRequest(accountId, () => client.post<Deleted>(`/items/${v.id}/archive`, {})),
      onSuccess: async (res, v) => {
        undoToast(t('archive.toast', { what: v.name }), res.event_id);
        await refreshItems();
      },
    }),
    archiveGroup: useMutation({
      mutationFn: (v: { id: string; name: string }) =>
        stepUpRequest(accountId, () => client.post<Deleted>(`/boards/${boardId}/groups/${v.id}/archive`, {})),
      onSuccess: async (res, v) => {
        undoToast(t('archive.toast', { what: v.name }), res.event_id);
        await refreshBoard();
        await refreshItems();
      },
    }),
    /** Duplicate (07 §4.2); the toast's undo moves the copy to trash. */
    duplicateItem: useMutation({
      mutationFn: (v: { id: string; name: string; withUpdates?: boolean }) =>
        client.post<Item>(`/items/${v.id}/duplicate`, { with_updates: !!v.withUpdates }),
      onSuccess: async (copy, v) => {
        showToast({
          message: t('duplicate.toast', { what: v.name }),
          seconds: UNDO_TOAST_SECONDS,
          action: {
            label: t('undo.action'),
            run: async () => {
              await client.delete(`/items/${copy.id}`);
              await qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] });
            },
          },
        });
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] });
      },
    }),
    duplicateGroup: useMutation({
      mutationFn: (v: { id: string; name: string }) =>
        client.post<Group>(`/boards/${boardId}/groups/${v.id}/duplicate`, {}),
      onSuccess: async (copy, v) => {
        showToast({
          message: t('duplicate.toast', { what: v.name }),
          seconds: UNDO_TOAST_SECONDS,
          action: {
            label: t('undo.action'),
            run: async () => {
              await client.delete(`/boards/${boardId}/groups/${copy.id}`);
              await refreshBoard();
              await refreshItems();
            },
          },
        });
        await refreshBoard();
        await refreshItems();
      },
    }),
    /** Move / convert (07 §3.4–3.7): the toast's undo puts everything back (the server keeps a snapshot). */
    moveItemToBoard: useMutation({
      mutationFn: (v: { id: string; name: string; to: BoardDetail; groupId?: string; mapping: ColumnMapping }) =>
        client.post<Moved>(`/items/${v.id}/move-to-board`, {
          board_id: v.to.id,
          group_id: v.groupId,
          mapping: v.mapping,
        }),
      onSuccess: async (res, v) => {
        undoToast(t('move.toast', { what: v.name, board: v.to.name }), res.event_id);
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] });
      },
    }),
    moveGroupToBoard: useMutation({
      mutationFn: (v: { id: string; name: string; to: BoardDetail; mapping: ColumnMapping }) =>
        client.post<Moved>(`/boards/${boardId}/groups/${v.id}/move-to-board`, {
          board_id: v.to.id,
          mapping: v.mapping,
        }),
      onSuccess: async (res, v) => {
        undoToast(t('move.toast', { what: v.name, board: v.to.name }), res.event_id);
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] });
      },
    }),
    convertItem: useMutation({
      mutationFn: (v: { id: string; name: string; parentItemId?: string; groupId?: string; mapping?: ColumnMapping }) =>
        client.post<Moved>(`/items/${v.id}/convert`, {
          parent_item_id: v.parentItemId,
          group_id: v.groupId,
          mapping: v.mapping,
        }),
      onSuccess: async (res, v) => {
        undoToast(t('convert.toast', { what: v.name }), res.event_id);
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] });
      },
    }),
    /** A subitem of `parentId` (D14). The first one creates the sub-board, so both boards refresh. */
    createSubitem: useMutation({
      /** `afterId`: right below that subitem ("add below"); default: last. */
      mutationFn: (v: { parentId: string; name?: string; afterId?: string }) =>
        client.post<Item>(`/items/${v.parentId}/subitems`, {
          ...(v.name !== undefined ? { name: v.name } : {}),
          ...(v.afterId ? { position: { after_id: v.afterId } } : {}),
        }),
      onSuccess: () => qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] }),
    }),
    /** A subitem among its siblings (drag in the subitems table). */
    reorderSubitem: useMutation({
      mutationFn: (v: { itemId: string; position: { after_id: string } | { before_id: string } }) =>
        client.post<Item>(`/items/${v.itemId}/reorder`, { position: v.position }),
      onSettled: () => qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] }),
    }),
    /**
     * fix6-table 5: a subitem dragged under another item / subitem of the board, at a place among its new
     * siblings (its own subitems come along). The toast's undo (and Ctrl+Z) puts it back.
     */
    reparentSubitem: useMutation({
      mutationFn: (v: {
        itemId: string;
        name: string;
        parentId: string;
        position?: { after_id: string } | { before_id: string };
      }) => client.post<Moved>(`/items/${v.itemId}/reparent`, { parent_item_id: v.parentId, position: v.position }),
      onSuccess: (res, v) => undoToast(t('subitems.moved', { what: v.name }), res.event_id),
      onSettled: () => qc.invalidateQueries({ queryKey: ['account', accountId, 'board'] }),
    }),
    /** Batch action on the selection (07 §6); the caller shows the result toast. */
    bulk: useMutation({
      mutationFn: (v: BulkItemsRequest) =>
        stepUpRequest(accountId, () => client.post<BulkResult>(`/boards/${boardId}/items/bulk`, v)),
      onSettled: (_r, _e, v) => refreshAfterBulk(v.action),
    }),
    /** The same on every item a query matches (a windowed board's "select all" — rows never loaded too). */
    bulkQuery: useMutation({
      mutationFn: (v: BulkQueryRequest) =>
        stepUpRequest(accountId, () => client.post<BulkResult>(`/boards/${boardId}/items/bulk-query`, v)),
      onSettled: (_r, _e, v) => refreshAfterBulk(v.action),
    }),
    moveItem: useMutation({
      mutationFn: (v: { itemId: string; groupId: string }) =>
        client.post<Item>(`/items/${v.itemId}/move-to-group`, { group_id: v.groupId }),
      onSuccess: putItem,
    }),
    /** Places an item between two others of the board (Kanban order), in its own group. */
    placeItem: useMutation({
      mutationFn: (v: { itemId: string; groupId: string; afterId: string | null; beforeId: string | null }) =>
        client.post<Item>(`/items/${v.itemId}/move-to-group`, {
          group_id: v.groupId,
          between: { after_id: v.afterId, before_id: v.beforeId },
        }),
      onSuccess: putItem,
      onError: refreshItems,
    }),
    /** Optimistic local change (a drag shows its result at once; the server answer replaces it). */
    patchItem: (itemId: string, fn: (item: Item) => Item) =>
      qc.setQueryData<{ data: Item[] }>(itemsKey, (old) =>
        old ? { ...old, data: old.data.map((i) => (i.id === itemId ? fn(i) : i)) } : old,
      ),
    createGroup: useMutation({
      mutationFn: (
        v:
          | string
          | {
              title: string;
              color?: GroupColor;
              position?: { before_id: string } | { after_id: string } | 'top' | 'bottom';
            },
      ) => client.post<Group>(`/boards/${boardId}/groups`, typeof v === 'string' ? { title: v } : v),
      onSuccess: refreshBoard,
    }),
    reorderGroup: useMutation({
      mutationFn: (v: { groupId: string; position: { before_id: string } | { after_id: string } }) =>
        client.post<Group>(`/boards/${boardId}/groups/${v.groupId}/reorder`, { position: v.position }),
      onSuccess: refreshBoard,
    }),
    updateGroup: useMutation({
      mutationFn: (v: { groupId: string; title?: string; color?: string }) =>
        client.patch<Group>(`/boards/${boardId}/groups/${v.groupId}`, { title: v.title, color: v.color }),
      onSuccess: refreshBoard,
    }),
    deleteGroup: useMutation({
      mutationFn: (v: { id: string; name: string }) =>
        stepUpRequest(accountId, () => client.delete<Deleted>(`/boards/${boardId}/groups/${v.id}`)),
      onSuccess: async (res, v) => {
        deleted(v.name, res);
        await refreshBoard();
        await refreshItems();
      },
    }),
    createColumn: useMutation({
      mutationFn: (v: {
        title: string;
        type: string;
        after_column_id?: string;
        before_column_id?: string;
        settings?: Record<string, unknown>;
      }) => client.post<Column>(`/boards/${boardId}/columns`, v),
      onSuccess: refreshBoard,
    }),
    /** `order` = every column key in the new order (name first); the moved column is placed by its neighbour. */
    reorderColumn: useMutation({
      mutationFn: (v: { columnId: string; order: string[] }) => {
        const i = v.order.indexOf(v.columnId);
        const position = i > 0 ? { after_id: v.order[i - 1]! } : { before_id: v.order[1]! };
        return client.post(`/boards/${boardId}/columns/${v.columnId}/reorder`, { position });
      },
      onMutate: (v) => patchColumns((cols) => v.order.map((k) => cols.find((c) => c.id === k)!).filter(Boolean)),
      onSettled: refreshBoard,
    }),
    /** Live width while dragging the header edge; `setColumnWidth` saves it on release. */
    previewColumnWidth: (columnId: string, width: number) =>
      patchColumns((cols) => cols.map((c) => (c.id === columnId ? { ...c, width } : c))),
    setColumnWidth: useMutation({
      mutationFn: (v: { columnId: string; width: number }) =>
        client.patch<Column>(`/boards/${boardId}/columns/${v.columnId}`, { width: v.width }),
      onSettled: refreshBoard,
    }),
    updateColumn: useMutation({
      mutationFn: (v: {
        columnId: string;
        title?: string;
        settings?: Record<string, unknown>;
        width?: number;
        /** fix6-table 4: optional; null clears it. */
        description?: string | null;
      }) =>
        client.patch<Column>(`/boards/${boardId}/columns/${v.columnId}`, {
          title: v.title,
          settings: v.settings,
          width: v.width,
          description: v.description,
        }),
      onSuccess: async () => {
        await refreshBoard();
        await refreshItems();
      },
    }),
    deleteColumn: useMutation({
      mutationFn: (v: { id: string; name: string }) => client.delete<Deleted>(`/boards/${boardId}/columns/${v.id}`),
      onSuccess: async (res, v) => {
        deleted(v.name, res);
        await refreshBoard();
      },
      // e.g. 409 column_in_name_source: the item name is built from this column.
      onError: (e) => showToast({ message: errorMessage(e), tone: 'error' }),
    }),
    renameBoard: useMutation({
      mutationFn: (name: string) => client.patch<BoardDetail>(`/boards/${boardId}`, { name }),
      onSuccess: async () => {
        await refreshBoard();
        await qc.invalidateQueries({ queryKey: ['account', accountId, 'tree'] });
      },
    }),
  };
};
